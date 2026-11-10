/**
 * Adaptive WhatsApp admin tools — what the admin portal's Campaign Manager → Adaptive → WhatsApp
 * tab and Launch & health do, for Claude. Registered ONLY on a SUPER_ADMIN's connection
 * (registry.ts `opts.admin`; ../../admin.ts), and every handler checks it again.
 *
 * Each tool proxies captive-server's `/internal/adaptive/admin/whatsapp…`, `/admin/launch`,
 * `/admin/journey-templates/:key/messages` or the owner `…/venues/:v/test-send` route, acting as
 * `{ uid: <the admin>, kind: 'super_admin' }`, so the server's checks, rate limits, activity log
 * and refusals are exactly the portal's. Nothing is decided here. Platform-wide: the templates and
 * the sending switch are not per account (Send test is: the picked account, or `tenantUserId`).
 *
 * What changes prod: edit_whatsapp_draft (a draft), suggest_whatsapp_template (billed AI run),
 * send_whatsapp_template_to_meta (confirm), sync_whatsapp_now, send_whatsapp_test (a real
 * message), set_whatsapp_sending (ON needs "WHATSAPP ON"). Everything else only reads.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom, type ToolExtra } from '../shared';
import { callServerInternalGet, callServerInternalJson, type ServerCallResult } from '../../serverClient';
import {
  NOT_ADMIN,
  WHATSAPP_ON_PHRASE,
  checksView,
  connectionView,
  coverageView,
  draftChangeShape,
  errorText,
  hasTextChange,
  listInputShape,
  listView,
  mergeSource,
  pickTemplate,
  recipientsView,
  sendingView,
  setSendingShape,
  stepsView,
  suggestInputShape,
  templateDetail,
  templateRefShape,
  testOptionsShape,
  testSendShape,
  type DraftChange,
  type Lang,
  type TemplateRef,
} from './whatsappAdminView';

type Rec = Record<string, any>;
type Actor = { uid: string; kind: 'super_admin' };

const ADMIN = '/internal/adaptive/admin';

/** The admin this connection acts as (bearer re-checked the role on this request), or null. */
function adminFrom(extra: ToolExtra | undefined): Actor | null {
  const uid = extra?.authInfo?.extra?.adminUid;
  return typeof uid === 'string' && uid ? { uid, kind: 'super_admin' } : null;
}

type Outcome = { data: Rec } | { error: string };

function outcome({ status, data }: ServerCallResult): Outcome {
  if (status >= 400 || data.ok === false) return { error: errorText(status, data) };
  return { data };
}

const get = async (path: string): Promise<Outcome> => outcome(await callServerInternalGet(path));
const write = async (method: 'POST' | 'PUT', path: string, body: Rec, actor: Actor): Promise<Outcome> =>
  outcome(await callServerInternalJson(method, path, { ...body, actor }));

/** The template a ref means, read in full (its id first, else found by name + language). */
async function loadTemplate(ref: TemplateRef): Promise<Outcome> {
  let id = ref.templateId;
  if (!id) {
    const o = await get(`${ADMIN}/whatsapp`);
    if ('error' in o) return o;
    const picked = pickTemplate(o.data.templates ?? [], ref);
    if ('error' in picked) return picked;
    id = picked.id;
  }
  return get(`${ADMIN}/whatsapp/templates/${id}`);
}

/** The account Send test acts on: the asked one (a captive-portal tenant) or the picked one. */
async function accountFor(asked: string | undefined, extra: ToolExtra): Promise<{ id: string } | { error: string }> {
  if (!asked) {
    const bound = tenantFrom(extra);
    return bound ? { id: bound } : { error: NO_TENANT };
  }
  if (asked.includes('/')) return { error: 'Not an account id' };
  const snap = await db.collection('Users').doc(asked).get();
  if (!snap.exists || String(snap.get('accountType') ?? '').toUpperCase() !== 'CAPTIVE_PORTAL_TENANT') {
    return { error: `${asked} is not a captive-portal account` };
  }
  return { id: asked };
}

function adminTool<A>(
  server: McpServer,
  name: string,
  description: string,
  shape: Parameters<typeof addTool>[3],
  run: (args: A, actor: Actor, extra: ToolExtra) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>>,
): void {
  addTool<A>(server, name, description, shape, async (args, extra) => {
    const actor = adminFrom(extra);
    if (!actor) return errorResult(NOT_ADMIN);
    try {
      return await run(args, actor, extra);
    } catch (err) {
      console.error(`[MCP ${name}]`, (err as Error)?.name ?? 'Error');
      return errorResult('Something went wrong talking to the server — try again');
    }
  });
}

const HEIDIFI_ADMIN = 'HeidiFi super admin only. Platform-wide (all accounts share these templates and this WhatsApp number).';

export function registerWhatsAppAdminTools(server: McpServer): void {
  // ── Reads ──────────────────────────────────────────────────────────────────

  adminTool<{ refresh?: boolean }>(
    server,
    'get_whatsapp_connection',
    `${HEIDIFI_ADMIN} Read-only. The WhatsApp tab's Meta connection strip: connected or not, the WhatsApp Business account, the sending number, its quality rating, when the access token expires ("never" for a System User token), whether Meta's notices (webhooks) are on, problems, the last sync, and the template counts. By default it shows the last check without calling Meta; refresh: true runs the tab's "Check connection" first (asks Meta, changes nothing there, free).`,
    { refresh: z.boolean().default(false).describe('Run "Check connection" with Meta first.') },
    async (args, actor) => {
      if (args?.refresh) {
        const c = await write('POST', `${ADMIN}/whatsapp/connection/check`, {}, actor);
        if ('error' in c) return errorResult(c.error);
      }
      const o = await get(`${ADMIN}/whatsapp`);
      return 'error' in o ? errorResult(o.error) : jsonResult(connectionView(o.data));
    },
  );

  adminTool<z.infer<z.ZodObject<typeof listInputShape>>>(
    server,
    'list_whatsapp_templates',
    `${HEIDIFI_ADMIN} Read-only. The WhatsApp templates: ours (hf_<pool>_<n>, one per Adaptive message, names never reused) and legacy ones (imported, the guest login code, old Campaign Manager). Each row: language, message (journey + pool), category asked and Meta's, status (approved, in_review, ready, needs_fix, rejected, paused, draft, …), whether Adaptive uses it now (inUse), the checks, and Meta's reason when it rejected it. Filter by lang, journeyKey, poolKey, status, kind or a name search.`,
    listInputShape,
    async (args) => {
      const o = await get(`${ADMIN}/whatsapp`);
      return 'error' in o ? errorResult(o.error) : jsonResult(listView(o.data, z.object(listInputShape).parse(args ?? {})));
    },
  );

  adminTool<TemplateRef>(
    server,
    'get_whatsapp_template',
    `${HEIDIFI_ADMIN} Read-only. One template in full: our text (named fields like {{contact.firstName}}), the body Meta sees ({{1}}, {{2}}…) and which field each number is, footer and button, the checks (errors and warnings), Meta's status, category and reason when rejected, whether it can be edited or sent to Meta now, its version (baseVersion) and its timeline. Give templateId, or name + lang (e.g. hf_birthday_1, en).`,
    templateRefShape,
    async (args) => {
      const t = await loadTemplate(args);
      return 'error' in t ? errorResult(t.error) : jsonResult(templateDetail(t.data));
    },
  );

  adminTool<{ journeyKey?: string }>(
    server,
    'get_whatsapp_coverage',
    `${HEIDIFI_ADMIN} Read-only. The coverage grid: every Adaptive message that can go by WhatsApp × EN/DE/FR/IT, each cell's best template and status, "N of 44 in use", which AI runs the cell allows (aiCanWrite: new / translation / alternative / fix, for suggest_whatsapp_template) and whether one is already writing. Optionally one journey only.`,
    { journeyKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().describe('Only this journey’s messages (the summary still counts all).') },
    async (args) => {
      const o = await get(`${ADMIN}/whatsapp`);
      return 'error' in o ? errorResult(o.error) : jsonResult(coverageView(o.data, args?.journeyKey));
    },
  );

  // ── Drafts ─────────────────────────────────────────────────────────────────

  /** The body the server's check route wants, for a template with the asked change. */
  function checkBody(t: Rec, change: DraftChange): Rec | { error: string } {
    if (t.use?.kind !== 'adaptive' || !t.lang || !t.use.journeyKey) return { error: 'Only templates of Adaptive messages are edited here' };
    if (!t.source && !change.body) return { error: 'This template has no text of ours yet: give the whole body' };
    const category = change.category ?? t.requestedCategory ?? (t.message?.rule === 'utility' ? 'UTILITY' : 'MARKETING');
    return { id: t.id, use: { journeyKey: t.use.journeyKey, poolKey: t.use.poolKey }, lang: t.lang, category, source: mergeSource(t.source ?? null, change) };
  }

  adminTool<TemplateRef & DraftChange>(
    server,
    'check_whatsapp_draft',
    `${HEIDIFI_ADMIN} Read-only (nothing is saved). Runs the editor's checks on a template's text with the changes you give (body, footer, button, category) — the same checks Send to Meta needs to pass — and shows the body Meta would see. Use it to try wording before edit_whatsapp_draft. German uses "du".`,
    { ...templateRefShape, ...draftChangeShape },
    async (args, actor) => {
      const t = await loadTemplate(args);
      if ('error' in t) return errorResult(t.error);
      const body = checkBody(t.data.template ?? {}, args);
      if ('error' in body) return errorResult(String(body.error));
      const r = await write('POST', `${ADMIN}/whatsapp/templates/check`, body, actor);
      if ('error' in r) return errorResult(r.error);
      return jsonResult({
        name: r.data.name,
        checks: checksView(r.data.checks),
        metaBody: r.data.compiled?.bodyText ?? null,
        metaFooter: r.data.compiled?.footerText ?? null,
        button: r.data.compiled?.button ?? null,
        fields: r.data.compiled?.params ?? [],
      });
    },
  );

  adminTool<TemplateRef & DraftChange & { baseVersion?: number }>(
    server,
    'edit_whatsapp_draft',
    `${HEIDIFI_ADMIN} CHANGES PROD (a draft only — nothing goes to Meta or to guests). Saves new text for a draft template (or one Meta rejected or paused) and returns it with the checks run again. Give templateId or name + lang, and any of body (named fields, e.g. {{contact.firstName}}), footer, button, category; what you leave out stays. An approved template can't be edited (write a new one). Show Manish the new text before saving when he hasn't written it himself.`,
    {
      ...templateRefShape,
      ...draftChangeShape,
      baseVersion: z.number().int().min(0).optional().describe('The version you read (get_whatsapp_template); refused if someone changed it since. Default: the version read now.'),
    },
    async (args, actor) => {
      if (!hasTextChange(args) && !args.category) return errorResult('Nothing to change: give body, footer, button or category');
      const t = await loadTemplate(args);
      if ('error' in t) return errorResult(t.error);
      const cur: Rec = t.data.template ?? {};
      const change: Rec = {};
      if (hasTextChange(args)) {
        if (!cur.source && !args.body) return errorResult('This template has no text of ours yet: give the whole body');
        change.source = mergeSource(cur.source ?? null, args);
      }
      if (args.category) change.category = args.category;
      const r = await write('PUT', `${ADMIN}/whatsapp/templates/${cur.id}`, { change, baseVersion: args.baseVersion ?? cur.version }, actor);
      return 'error' in r ? errorResult(r.error) : jsonResult({ saved: true, template: templateDetail(r.data) });
    },
  );

  adminTool<z.infer<z.ZodObject<typeof suggestInputShape>>>(
    server,
    'suggest_whatsapp_template',
    `${HEIDIFI_ADMIN} COSTS MONEY: starts one BILLED AI run (the AI writer, a paid model call counted against the AI agents' monthly budget and daily runs). It is the tab's "Suggest with AI" (kind new / alternative / fix) and "Translate with AI" (kind translation) for one coverage cell. Only call it when Manish asks for it, and say it is a billed AI run. Refused when the AI switch is off, the budget or today's runs are used up, or a run for the cell is already on its way. Pick only a kind the cell lists in get_whatsapp_coverage (aiCanWrite) — that is what the tab offers; the server doesn't refuse every other kind. The draft appears in a minute or two (list_whatsapp_templates); it is never sent to Meta by itself.`,
    suggestInputShape,
    async (args, actor) => {
      const body: Rec = { use: { journeyKey: args.journeyKey, poolKey: args.poolKey }, lang: args.lang as Lang, kind: args.kind };
      if (args.templateId) body.templateId = args.templateId;
      const r = await write('POST', `${ADMIN}/whatsapp/suggest`, body, actor);
      return 'error' in r
        ? errorResult(r.error)
        : jsonResult({ queued: r.data.queued === true, taskId: r.data.taskId ?? null, aiRunsLeftToday: r.data.runsLeft ?? null, next: 'The draft appears in a minute or two: list_whatsapp_templates or get_whatsapp_coverage.' });
    },
  );

  adminTool<TemplateRef & { confirm: true; baseVersion?: number }>(
    server,
    'send_whatsapp_template_to_meta',
    `${HEIDIFI_ADMIN} CHANGES PROD AT META — needs Manish's explicit OK in the chat for THIS template first (he reviews and sends every template himself; Auto-submit stays off). Only call it after he has said yes to this name and language in this conversation, and set confirm: true. Sends the template to Meta for review (the tab's "Send to Meta"); its checks must pass. A name sent once is never reused, and nothing is ever deleted at Meta. Meta answers in minutes to a day: sync_whatsapp_now, then get_whatsapp_template.`,
    {
      ...templateRefShape,
      confirm: z.literal(true).describe('true — only after Manish said yes to sending this template to Meta in the chat.'),
      baseVersion: z.number().int().min(0).optional().describe('The version Manish approved (get_whatsapp_template); refused if it changed since. Default: the version read now.'),
    },
    async (args, actor) => {
      if (args.confirm !== true) return errorResult('Send to Meta needs confirm: true, after Manish’s OK in the chat');
      const t = await loadTemplate(args);
      if ('error' in t) return errorResult(t.error);
      const cur: Rec = t.data.template ?? {};
      const r = await write('POST', `${ADMIN}/whatsapp/templates/${cur.id}/submit`, { baseVersion: args.baseVersion ?? cur.version }, actor);
      if ('error' in r) return errorResult(r.error);
      return jsonResult({ outcome: r.data.outcome ?? null, error: r.data.error ?? null, template: templateDetail(r.data) });
    },
  );

  adminTool<Record<string, never>>(
    server,
    'sync_whatsapp_now',
    `${HEIDIFI_ADMIN} Changes our copy only (reads Meta, writes nothing at Meta). The tab's "Sync now": reads every template's status from Meta and updates ours (approvals, rejections with Meta's reason, pauses, quality). Takes up to ~35 s; answers running: true when the regular sync is busy (try again in a minute).`,
    {},
    async (_args, actor) => {
      const r = await write('POST', `${ADMIN}/whatsapp/sync`, {}, actor);
      if ('error' in r) return errorResult(r.error);
      if (r.data.running) return jsonResult({ running: true, next: 'The regular sync is running — try again in a minute.' });
      const s: Rec = r.data.sync ?? {};
      return jsonResult({ running: false, ok: s.ok ?? null, complete: s.complete ?? null, changes: s.changes ?? 0, imported: s.imported ?? 0, deleted: s.deleted ?? 0, error: s.error?.message ?? null });
    },
  );

  // ── Send test ──────────────────────────────────────────────────────────────

  adminTool<{ tenantUserId?: string; journeyKey?: string; lang: Lang }>(
    server,
    'list_whatsapp_test_options',
    `${HEIDIFI_ADMIN} Read-only. What send_whatsapp_test needs: the account's venues, its saved test phone numbers (masked; the id is what you pass), and — with journeyKey — the journey's message steps (nodeId) and their WhatsApp templates. Default account: the one picked when connecting.`,
    testOptionsShape,
    async (args, _actor, extra) => {
      const account = await accountFor(args.tenantUserId, extra);
      if ('error' in account) return errorResult(account.error);
      const [venues, recipients] = await Promise.all([
        db.collection('CaptivePortal_Venues').where('tenantUserId', '==', account.id).get(),
        db.collection('CaptivePortal_TestRecipients').doc(account.id).get(),
      ]);
      let steps: unknown = undefined;
      if (args.journeyKey) {
        const m = await get(`${ADMIN}/journey-templates/${args.journeyKey}/messages?lang=${args.lang ?? 'en'}`);
        steps = 'error' in m ? { error: m.error } : stepsView(m.data);
      }
      const phones = recipientsView(recipients.get('recipients'));
      return jsonResult({
        tenantUserId: account.id,
        venues: venues.docs.map((d) => ({ venueId: d.id, name: (d.get('venue_name') as string) ?? (d.get('name') as string) ?? '' })),
        testPhones: phones,
        ...(phones.length ? {} : { note: 'No saved test phone numbers: the owner (or HeidiFi for them) adds one in the Adaptive preview’s Send test.' }),
        ...(steps !== undefined ? { steps } : {}),
      });
    },
  );

  adminTool<z.infer<z.ZodObject<typeof testSendShape>>>(
    server,
    'send_whatsapp_test',
    `${HEIDIFI_ADMIN} SENDS A REAL WHATSAPP MESSAGE from HeidiFi's number (Meta may bill it like any template message). The Adaptive preview's WhatsApp "Send test": one journey step's approved template, filled with the venue's real values and sample guest Anna, to one SAVED test phone number of the account (list_whatsapp_test_options). Call it when Manish asks for a test. No send record, no credits; at most 10 WhatsApp tests a day per account; refused while the account's Adaptive launch mode is off or the message has no approved template. A test also makes Meta send a message notice (one of the WhatsApp sending checks).`,
    testSendShape,
    async (args, actor, extra) => {
      const account = await accountFor(args.tenantUserId, extra);
      if ('error' in account) return errorResult(account.error);
      const body: Rec = { journeyKey: args.journeyKey, channel: 'whatsapp', recipientId: args.recipientId };
      if (args.nodeId) body.nodeId = args.nodeId;
      if (args.offerSlot) body.offerSlot = args.offerSlot;
      if (args.lang) body.lang = args.lang;
      const r = await write('POST', `/internal/adaptive/tenants/${encodeURIComponent(account.id)}/venues/${encodeURIComponent(args.venueId)}/test-send`, body, actor);
      if ('error' in r) return errorResult(r.error);
      const { ok: _ok, ...rest } = r.data;
      return jsonResult({ tenantUserId: account.id, ...rest });
    },
  );

  // ── Sending switch (Launch & health) ───────────────────────────────────────

  adminTool<Record<string, never>>(
    server,
    'get_whatsapp_sending',
    `${HEIDIFI_ADMIN} Read-only. The Launch & health card's WhatsApp sending switch (off: journeys use SMS and email) and the three checks turning it on needs: the adaptive-worker has the WhatsApp keys, Meta sent a message notice in the last 7 days, and at least one approved template is in use. readyToTurnOn says whether all pass.`,
    {},
    async () => {
      const l = await get(`${ADMIN}/launch`);
      return 'error' in l ? errorResult(l.error) : jsonResult(sendingView(l.data));
    },
  );

  adminTool<z.infer<z.ZodObject<typeof setSendingShape>>>(
    server,
    'set_whatsapp_sending',
    `${HEIDIFI_ADMIN} CHANGES PROD SENDING FOR ALL ACCOUNTS. mode "off" is the brake: one call, always allowed — journeys go back to SMS and email. mode "on" makes journeys send approved WhatsApp templates to guests: ONLY on Manish's explicit word in the chat, with confirmPhrase exactly "${WHATSAPP_ON_PHRASE}" as he wrote it — never type the phrase on your own. The server refuses ON unless all three sending checks pass (get_whatsapp_sending).`,
    setSendingShape,
    async (args, actor) => {
      const body: Rec = { change: { whatsappSending: { mode: args.mode } } };
      if (args.note) body.note = args.note;
      if (args.mode === 'on') {
        if ((args.confirmPhrase ?? '').trim() !== WHATSAPP_ON_PHRASE) {
          return errorResult(`Turning WhatsApp sending on needs confirmPhrase "${WHATSAPP_ON_PHRASE}", written by Manish in the chat`);
        }
        const l = await get(`${ADMIN}/launch`);
        if ('error' in l) return errorResult(l.error);
        body.baseVersion = l.data.version;
        body.confirm = WHATSAPP_ON_PHRASE;
      }
      const r = await write('PUT', `${ADMIN}/launch`, body, actor);
      if ('error' in r) return errorResult(r.error);
      const after = await get(`${ADMIN}/launch`);
      return jsonResult({
        changed: r.data.changed !== false,
        lines: r.data.summary?.lines ?? [],
        ...('error' in after ? { note: 'Saved; could not re-read the card' } : { now: sendingView(after.data) }),
      });
    },
  );
}
