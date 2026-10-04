/**
 * The sandbox Meta (PR W1): a stand-in for the WhatsApp Business Management API in the local
 * emulator stack and the emulator tests (ADAPTIVE_SANDBOX=1 + the emulator only). It keeps
 * Meta-shaped templates in `CaptivePortal_AdaptiveSandboxWhatsAppTemplates` — the API, the tests
 * and the skill's scripts all share the emulator — and starts with the three templates production
 * has today (the OTP template, `restaurant_feedback_request`, and `heidifi_visit_feedback` with its
 * mis-registered button), so the checks and the import can be tried against reality.
 *
 * A new template starts PENDING; the dev routes decide (approve, reject, pause, disable, delete,
 * re-categorise, quality) and can queue faults for the next calls (rate limit, bad token, no
 * permission, already exists, name locked, timeout — with or without the template arriving —,
 * server error, an incomplete list).
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { hashId } from '../core/checksum';
import { sandboxEnabled } from '../engine/clock';
import { MetaError } from './metaError';
import type { MetaClient, MetaTemplateCreate, PhoneNumberInfo } from './meta';
import type { MetaComponent } from '../core/whatsapp/template';

export const SANDBOX_WABA_ID = 'sandbox_waba_1';
const FAULTS_DOC = '__faults';

export const SANDBOX_FAULTS = [
  'rate_limit',
  'invalid_token',
  'permission',
  'exists',
  'locked',
  'invalid',
  'timeout',
  'timeout_lost',
  'server_error',
  'list_incomplete',
  'no_waba_scope',
] as const;
export type SandboxFault = (typeof SANDBOX_FAULTS)[number];
export type SandboxOp = 'debug' | 'phones' | 'list' | 'get' | 'find' | 'create' | 'edit' | 'any';

const col = () => db.collection(COL.sandboxWhatsAppTemplates);

const sandboxMetaId = (name: string, language: string) => hashId('sbx', `${name}:${language}`).replace(/^sbx_/, '9').slice(0, 16);

/** The three templates production has today (`heidifi_visit_feedback` with its broken button). */
function seedTemplates(): Array<Record<string, unknown>> {
  return [
    {
      name: 'heidifi_verification_code',
      language: 'en',
      status: 'APPROVED',
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', text: '*{{1}}* is your verification code. For your security, do not share this code.', add_security_recommendation: true },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Copy code', url: 'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}', example: ['https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp123456'] }] },
      ],
    },
    {
      name: 'restaurant_feedback_request',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, thank you for visiting {{2}}! We would love to hear how it went. Tap below to rate us.', example: { body_text: [['Anna', 'Café Bellevue']] } },
        { type: 'FOOTER', text: 'Reply STOP to opt out.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Rate Us', url: 'https://visit.askheidi.app/{{1}}', example: ['s/gkgq7j5z'] }] },
      ],
    },
    {
      name: 'heidifi_visit_feedback',
      language: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, thanks for visiting {{2}} today. How did we do? Tap below to leave quick feedback.', example: { body_text: [['Anna', 'Café Bellevue']] } },
        // As registered in production: a literal {{1}} before Meta's own variable slot.
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Rate your visit', url: 'https://visit.askheidi.app/%7B%7B1%7D%7D{{1}}', example: ['s/gkgq7j5z'] }] },
      ],
    },
  ];
}

function toMeta(id: string, t: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    ...(t.previous_category ? { previous_category: t.previous_category } : {}),
    ...(t.rejected_reason ? { rejected_reason: t.rejected_reason } : {}),
    quality_score: { score: t.quality ?? 'UNKNOWN' },
    components: typeof t.componentsJson === 'string' ? JSON.parse(t.componentsJson) : t.components ?? [],
    parameter_format: 'POSITIONAL',
  };
}

async function ensureSeeded(): Promise<void> {
  const any = await col().limit(2).get();
  if (any.docs.some((d) => d.id !== FAULTS_DOC)) return;
  const batch = db.batch();
  for (const t of seedTemplates()) {
    const id = sandboxMetaId(String(t.name), String(t.language));
    // Firestore refuses nested arrays (Meta's body example): components as JSON text.
    const { components, ...rest } = t;
    batch.set(col().doc(id), { ...rest, componentsJson: JSON.stringify(components), wabaId: SANDBOX_WABA_ID, quality: 'GREEN', createdAt: new Date() });
  }
  await batch.commit();
}

/** Queues faults for the next sandbox calls (dev route + tests). */
export async function queueSandboxFaults(items: Array<{ op: SandboxOp; fault: SandboxFault }>): Promise<number> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  return db.runTransaction(async (tx) => {
    const ref = col().doc(FAULTS_DOC);
    const snap = await tx.get(ref);
    const queue = ((snap.get('queue') as Array<{ op: SandboxOp; fault: SandboxFault }> | undefined) ?? []).concat(items);
    tx.set(ref, { queue });
    return queue.length;
  });
}

async function takeFault(op: SandboxOp): Promise<SandboxFault | null> {
  return db.runTransaction(async (tx) => {
    const ref = col().doc(FAULTS_DOC);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const queue = (snap.get('queue') as Array<{ op: SandboxOp; fault: SandboxFault }> | undefined) ?? [];
    const i = queue.findIndex((q) => q.op === op || q.op === 'any');
    if (i < 0) return null;
    const [hit] = queue.splice(i, 1);
    tx.set(ref, { queue });
    return hit.fault;
  });
}

function faultError(fault: SandboxFault, method: 'GET' | 'POST'): MetaError {
  switch (fault) {
    case 'rate_limit':
      return new MetaError('rate_limited', '(sandbox) Too many calls', { status: 429, code: 80008, retryAfterMs: 60_000 });
    case 'invalid_token':
      return new MetaError('setup', '(sandbox) Error validating access token: Session has expired', { status: 401, code: 190 });
    case 'permission':
    case 'no_waba_scope':
      return new MetaError('permission', '(sandbox) (#200) Requires whatsapp_business_management permission', { status: 403, code: 200 });
    case 'exists':
      return new MetaError('already_exists', '(sandbox) Content in this language already exists', { status: 400, code: 100, subcode: 2388024 });
    case 'locked':
      return new MetaError('locked', '(sandbox) New content can’t be added while the existing content is being deleted', { status: 400, code: 100, subcode: 2388024 });
    case 'invalid':
      return new MetaError('invalid', '(sandbox) Invalid parameter: the template has too many variables for its length', { status: 400, code: 100, subcode: 2388043 });
    case 'server_error':
      return new MetaError(method === 'POST' ? 'unknown' : 'unavailable', '(sandbox) An unexpected error has occurred', { status: 500, code: 2 });
    case 'timeout':
    case 'timeout_lost':
    default:
      return new MetaError(method === 'POST' ? 'unknown' : 'unavailable', '(sandbox) No answer from Meta (timeout)', { status: null });
  }
}

async function failIfQueued(op: SandboxOp, method: 'GET' | 'POST'): Promise<SandboxFault | null> {
  const fault = await takeFault(op);
  if (!fault) return null;
  // `timeout` on a create: the template arrives but the answer is lost (the caller must adopt it).
  if (op === 'create' && fault === 'timeout') return fault;
  if (fault === 'list_incomplete' || fault === 'no_waba_scope') return fault;
  throw faultError(fault, method);
}

async function byNameLanguage(name: string, language: string) {
  const snap = await col().where('name', '==', name).get();
  return snap.docs.find((d) => d.get('language') === language) ?? null;
}

export function createSandboxMetaClient(): MetaClient {
  const phoneId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || 'sandbox_phone_1';
  return {
    kind: 'sandbox',
    ready: () => sandboxEnabled(),
    phoneNumberId: () => phoneId(),
    async debugToken() {
      const fault = await failIfQueued('debug', 'GET');
      return {
        valid: true,
        scopes: fault === 'no_waba_scope' ? ['whatsapp_business_messaging'] : ['whatsapp_business_management', 'whatsapp_business_messaging'],
        wabaIds: fault === 'no_waba_scope' ? [] : [SANDBOX_WABA_ID],
        expiresAt: null,
      };
    },
    async phoneNumbers(wabaId): Promise<PhoneNumberInfo[]> {
      await failIfQueued('phones', 'GET');
      if (wabaId !== SANDBOX_WABA_ID) throw new MetaError('not_found', '(sandbox) Unsupported get request. Object does not exist', { status: 400, code: 100, subcode: 33 });
      return [{ id: phoneId(), displayPhoneNumber: '+41 44 000 00 00', verifiedName: 'HeidiFi (sandbox)', qualityRating: 'GREEN' }];
    },
    async listTemplates(wabaId) {
      await ensureSeeded();
      const fault = await failIfQueued('list', 'GET');
      const snap = await col().get();
      const all = snap.docs.filter((d) => d.id !== FAULTS_DOC && d.get('wabaId') === wabaId && d.get('status') !== 'DELETED_GONE');
      const templates = all.map((d) => toMeta(d.id, d.data()));
      if (fault === 'list_incomplete') return { templates: templates.slice(0, Math.max(0, Math.floor(templates.length / 2))), complete: false, pages: 1 };
      return { templates, complete: true, pages: 1 };
    },
    async getTemplate(id) {
      await failIfQueued('get', 'GET');
      const snap = await col().doc(id).get();
      if (!snap.exists || id === FAULTS_DOC || snap.get('status') === 'DELETED_GONE') return null;
      return toMeta(id, snap.data()!);
    },
    async findByName(_wabaId, name) {
      await failIfQueued('find', 'GET');
      const snap = await col().where('name', '==', name).get();
      return snap.docs.filter((d) => d.get('status') !== 'DELETED_GONE').map((d) => toMeta(d.id, d.data()));
    },
    async createTemplate(wabaId, body: MetaTemplateCreate) {
      await ensureSeeded();
      const fault = await failIfQueued('create', 'POST');
      const existing = await byNameLanguage(body.name, body.language);
      if (existing && existing.get('status') === 'PENDING_DELETION') throw faultError('locked', 'POST');
      if (existing && existing.get('status') !== 'DELETED_GONE') throw faultError('exists', 'POST');
      const id = sandboxMetaId(body.name, body.language);
      await col().doc(id).set({
        name: body.name,
        language: body.language,
        status: 'PENDING',
        category: body.category,
        componentsJson: JSON.stringify(body.components),
        wabaId,
        quality: 'UNKNOWN',
        createdAt: new Date(),
      });
      if (fault === 'timeout') throw faultError('timeout', 'POST');
      return { id, status: 'PENDING', category: body.category };
    },
    async editTemplate(id, body: { components: MetaComponent[]; category?: string }) {
      await failIfQueued('edit', 'POST');
      const ref = col().doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new MetaError('not_found', '(sandbox) Object does not exist', { status: 400, code: 100, subcode: 33 });
      await ref.update({ componentsJson: JSON.stringify(body.components), ...(body.category ? { category: body.category } : {}), status: 'PENDING', rejected_reason: null });
      return { ok: true };
    },
  };
}

export type SandboxDecision = 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'PENDING_DELETION' | 'DELETED' | 'RECATEGORISE' | 'QUALITY';

/**
 * Dev route + tests: Meta decides. `DELETED` makes the template vanish from lists and gets
 * (as Meta does once a deletion completes); `PENDING_DELETION` keeps it visible and locks the name.
 */
export async function sandboxDecide(
  target: { metaId?: string; name?: string; language?: string },
  d: { decision: SandboxDecision; reason?: string; category?: string; quality?: string },
): Promise<Record<string, unknown>> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  await ensureSeeded();
  let ref = target.metaId ? col().doc(target.metaId) : null;
  if (!ref && target.name && target.language) {
    const hit = await byNameLanguage(target.name, target.language);
    ref = hit ? hit.ref : null;
  }
  if (!ref) throw new Error('no such sandbox template');
  const snap = await ref.get();
  if (!snap.exists || ref.id === FAULTS_DOC) throw new Error('no such sandbox template');
  const update: Record<string, unknown> = {};
  switch (d.decision) {
    case 'APPROVED':
      update.status = 'APPROVED';
      update.rejected_reason = null;
      if (d.category) {
        update.previous_category = snap.get('category') ?? null;
        update.category = d.category;
      }
      break;
    case 'REJECTED':
      update.status = 'REJECTED';
      update.rejected_reason = d.reason ?? 'INVALID_FORMAT';
      break;
    case 'PAUSED':
    case 'DISABLED':
    case 'PENDING_DELETION':
      update.status = d.decision;
      break;
    case 'DELETED':
      update.status = 'DELETED_GONE';
      break;
    case 'RECATEGORISE':
      update.previous_category = snap.get('category') ?? null;
      update.category = d.category ?? 'MARKETING';
      break;
    case 'QUALITY':
      update.quality = (d.quality ?? 'RED').toUpperCase();
      break;
  }
  await ref.update(update);
  const after = await ref.get();
  return toMeta(ref.id, after.data()!);
}
