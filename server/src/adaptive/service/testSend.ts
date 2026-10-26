/**
 * Send test (plan §5: `POST /tenants/:t/venues/:v/test-send`; PR D decision D-D14): one step
 * of a journey, rendered with the venue's real values — its name, the owner's pinned values
 * and offers, its Guest info — for a sample guest "Anna", sent now to one of the account's
 * SAVED test recipients.
 *
 * Behaves like today's `/internal/test-send`: sent now, no send record, no event, no short
 * link, no analytics, no credits, and it counts toward the same daily cap
 * (`CaptivePortal_TestSendCounters/{tenant}_{UTC day}`, the rate card's `testSendDailyLimit`).
 * Stricter where Adaptive is stricter:
 *  - only a saved recipient (the cms's `CaptivePortal_TestRecipients/{tenant}`): the address
 *    never travels in the request, so the route can't become a free relay;
 *  - the cap fails closed; SMS only to the platform's allowed countries;
 *  - refused while the account's launch mode is off (stage 0 does nothing);
 *  - Adaptive's own clients (no automatic retries; the sandbox provider locally — never the
 *    real ones in the local stack), links are same-length placeholders, no unsubscribe link,
 *    and a provider "unsubscribed" answer blocks nothing (it's the owner's own number).
 * The answer carries the status and a preview with the secrets masked, never the rendered text.
 */

import { holidayDef, parseHolidayKeys } from '../core/scans/holidays';
import { randomBytes } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { venuePlaybookId } from '../store/collections';
import type { VenuePlaybookDoc } from '../store/types';
import type { Actor, JourneyDefinition, Offer, SlotValue } from '../core/schemas';
import type { Channel, Lang } from '../core/constants';
import { LANGS } from '../core/constants';
import { getNodeContract } from '../core/registry';
import { DAY_MS, HOUR_MS } from '../core/runtime/time';
import { phoneCountry } from '../core/runtime/phoneCountry';
import { ApiError, conflict, notFound } from '../api/errors';
import { HttpError, tooManyRequests, unavailable } from '../api/http';
import { getVenues } from '../store/tenantData';
import { modeFor, readEngineSettings } from '../store/engineSettings';
import { loadCatalogue, templateVersion } from './catalogue';
import { loadGuestInfo, loadVenueContext } from '../engine/context';
import { linkGates, missingReason, renderMessage, renderValues, variantContent, variantEligible, type LinkKind } from '../engine/renderSend';
import { composeEmail, maskSecretValues, placeholderLink, SHORT_CODE_LENGTH, smsFinalText } from '../send/compose';
import { loadDesignBrand } from '../send/designBrand';
import { renderText } from '../core/render';
import { VISITOR_BASE_URL, validBookingUrl } from '../send/links';
import { registerAdapters, type AdapterRegistry } from '../send/adapters';
import type { ProviderResult } from '../send/adapters/types';
import { whatsappTestAdapter } from '../send/adapters/whatsappTestSend';
import { waBodyValues } from '../core/whatsapp/sendValues';
import { loadWaPickContext, pickWaTemplate } from '../whatsapp/pick';
import { writeLog } from '../whatsapp/store';
import { resolveStayTimes } from '../stays/times';
import { now, refreshClock } from '../engine/clock';
import { getCreditConfig } from '../../services/credits';
import { normalizeE164 } from '../../services/phone';
import { getEntitlements } from '../../services/entitlements';
import { maskedEmail, maskedPhone } from '../core/owner/mask';
import { venueSetupsQuery } from '../store/ownerQueries';

const TEST_RECIPIENTS = 'CaptivePortal_TestRecipients';
const TEST_COUNTERS = 'CaptivePortal_TestSendCounters';

export const testSendInputSchema = z.object({
  journeyKey: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64).optional(),
  /** PR S: the preview step's offer blank (Win-back's stages share one message step). */
  offerSlot: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).optional(),
  channel: z.enum(['sms', 'email', 'whatsapp']),
  lang: z.enum(LANGS).optional(),
  recipientId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
});

/**
 * PR PV: WhatsApp tests go out from HeidiFi's one WhatsApp number, which also carries every guest's
 * login code — a number reported or blocked too often loses quality for everyone. So at most this
 * many a day per account, whatever the shared cap says (even uncapped), counted in the same doc.
 */
export const WHATSAPP_TEST_DAILY_LIMIT = 10;

/**
 * The shared daily cap — the same doc and limit as `/internal/test-send`, but failing closed. A
 * WhatsApp test also takes one of the account's WhatsApp tests (`whatsapp` in the same doc).
 */
async function takeTestSend(tenantUserId: string, opts: { whatsapp?: boolean } = {}): Promise<void> {
  const config = await getCreditConfig();
  const limit = Number(config.testSendDailyLimit) || 0;
  if (limit <= 0 && !opts.whatsapp) return; // 0 = uncapped (as the Campaign test send)
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection(TEST_COUNTERS).doc(`${tenantUserId}_${day}`);
  let outcome: 'ok' | 'cap' | 'whatsapp_cap';
  try {
    outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (limit > 0 && Number(snap.data()?.count ?? 0) >= limit) return 'cap';
      if (opts.whatsapp && Number(snap.data()?.whatsapp ?? 0) >= WHATSAPP_TEST_DAILY_LIMIT) return 'whatsapp_cap';
      tx.set(
        ref,
        { tenantUserId, day, count: FieldValue.increment(1), ...(opts.whatsapp ? { whatsapp: FieldValue.increment(1) } : {}), updatedAt: new Date() },
        { merge: true },
      );
      return 'ok';
    });
  } catch {
    throw unavailable("Test sends can't be counted right now — try again in a minute");
  }
  if (outcome === 'cap') throw tooManyRequests(`Daily test-send limit reached (${limit}/day). Try again tomorrow.`);
  if (outcome === 'whatsapp_cap') throw tooManyRequests(`Daily WhatsApp test limit reached (${WHATSAPP_TEST_DAILY_LIMIT}/day). Try again tomorrow.`);
}

/** The venue's setup that has this journey: the running playbook first, then Guest info, then any other. */
async function setupWith(venueId: string, journeyKey: string, preferred: string[]): Promise<VenuePlaybookDoc | null> {
  const snap = await venueSetupsQuery(venueId).get();
  const docs = snap.docs.map((d) => ({ id: d.id, doc: d.data() as VenuePlaybookDoc })).filter((d) => d.doc.journeys?.[journeyKey]);
  docs.sort((a, b) => {
    const ra = preferred.indexOf(a.id);
    const rb = preferred.indexOf(b.id);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  return docs[0]?.doc ?? null;
}

/**
 * The offer a guest of this journey would hold: its first offer step whose blank names an offer
 * from the menu (PR S: Win-back's stages, the birthday gift — not only a blank called `offer`).
 */
function offerVars(definition: JourneyDefinition, slots: Record<string, SlotValue>, offers: Offer[], at: number, preferSlot?: string): Record<string, unknown> {
  const steps = Object.values(definition.nodes).filter((n) => n.type === 'issue_offer');
  const all = [...steps.map((n) => ({ slot: String(n.config?.slot ?? ''), days: n.config?.expiryDays })), { slot: 'offer', days: undefined }];
  const candidates = preferSlot ? [...all.filter((c) => c.slot === preferSlot), ...all.filter((c) => c.slot !== preferSlot)] : all;
  for (const c of candidates) {
    const chosen = slots[c.slot];
    const offer = typeof chosen === 'string' ? offers.find((o) => o.offerKey === chosen) : undefined;
    if (!offer) continue;
    const days = typeof c.days === 'number' ? c.days : typeof slots.offer_days === 'number' ? slots.offer_days : offer.expiryDays;
    return { offerKey: offer.offerKey, offerLabel: offer.label, offerDays: days, offerExpiresAt: at + days * DAY_MS };
  }
  return {};
}

/** PR S: an example occasion for a scan journey's test (the first picked holiday, a slow Tuesday afternoon, …). */
function sampleOccasion(definition: JourneyDefinition, slots: Record<string, SlotValue>, at: number, offerSlot?: string): Record<string, unknown> {
  const trigger = definition.entry.trigger;
  const today = new Date(at).toISOString().slice(0, 10);
  switch (trigger.type) {
    case 'days_since_visit': {
      // The stage of the preview step (`offer_60` → 60).
      const stage = Number(/^offer_(\d+)$/.exec(offerSlot ?? '')?.[1] ?? 30);
      return { occasionKind: 'winback', winbackDays: stage };
    }
    case 'date_field':
      return { occasionKind: 'birthday', birthdayMonth: Number(today.slice(5, 7)) };
    case 'calendar.holiday': {
      const slot = typeof trigger.config?.slot === 'string' ? trigger.config.slot : 'holidays';
      const key = parseHolidayKeys(slots[slot])[0] ?? 'christmas_eve';
      const def = holidayDef(key)!;
      const year = Number(today.slice(0, 4));
      const date = def.dateIn(year) >= today ? def.dateIn(year) : def.dateIn(year + 1);
      return { occasionKind: 'holiday', holidayKey: key, holidayDate: date };
    }
    case 'computed.slow_daypart':
      return { occasionKind: 'slow', slowWeekday: 2, slowDaypart: 'afternoon' };
    default:
      return {};
  }
}

export async function testSend(tenantUserId: string, venueId: string, body: unknown, actor: Actor) {
  void actor;
  const input = testSendInputSchema.parse(body ?? {});
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
  const settings = await readEngineSettings();
  if (modeFor(settings, tenantUserId) === 'off') throw conflict('Test sends work once Adaptive Campaigns runs for your account');

  // What to render: the venue's own setup of this journey, at its pinned template version.
  const ctx = await loadVenueContext(venueId);
  const preferred = [ctx?.adaptive.activeInstallId ?? '', ctx?.adaptive.utility?.installId ?? venuePlaybookId(venueId, 'guest_info')];
  const setup = await setupWith(venueId, input.journeyKey, preferred);
  const jc = setup?.journeys?.[input.journeyKey];
  if (!setup || !jc) throw notFound('This journey is not set up at this venue');
  const cat = await loadCatalogue();
  const found = templateVersion(cat, input.journeyKey, jc.templateVersion);
  if (!found) throw notFound('This journey is not available');
  const nodeId = input.nodeId ?? Object.entries(found.definition.nodes).find(([, n]) => n.type === 'send')?.[0];
  const node = nodeId ? found.definition.nodes[nodeId] : undefined;
  if (!nodeId || !node || node.type !== 'send') throw new ApiError('bad_request', 'That step of the journey is not a message');
  const cfg = getNodeContract('send')!.configSchema.safeParse(node.config ?? {});
  if (!cfg.success) throw new ApiError('bad_request', 'That message step is not set up correctly');
  const pool = (cfg.data as { pool: string }).pool;
  const purpose = (cfg.data as { purpose?: string }).purpose === 'service' ? 'service' : 'marketing';

  const slots = jc.slots ?? {};
  const offers = setup.offerMenu ?? [];
  // PR PV: WhatsApp sends the message's approved template, not a wording.
  if (input.channel === 'whatsapp') {
    return testSendWhatsApp({
      tenantUserId,
      venueId,
      venueName: ctx?.venueName || venue.name || '',
      tz: ctx?.tz ?? venue.timezone ?? 'Europe/Zurich',
      definition: found.definition,
      nodeId,
      pool,
      purpose,
      slots,
      offers,
      input,
    });
  }
  const lang: Lang = input.lang ?? 'en';
  const eligible = cat.variants
    .filter((v) => v.poolKey === pool && v.status === 'active' && variantEligible(v, slots))
    .sort((a, b) => a.letter.localeCompare(b.letter));
  // PR PV: the first wording that has this channel — as the preview's versions show it.
  const variant = eligible.find((v) => variantContent(v, input.channel as Channel, lang)) ?? eligible[0];
  if (!variant) throw new ApiError('bad_request', 'There is no wording for this step with your settings');
  const content = variantContent(variant, input.channel as Channel, lang);
  if (!content) throw new ApiError('bad_request', `This step has no ${input.channel === 'sms' ? 'SMS' : 'email'} wording`);

  // The recipient: one of the account's saved test recipients, of the right kind.
  const recips = ((await db.collection(TEST_RECIPIENTS).doc(tenantUserId).get()).get('recipients') ?? []) as Array<{ id?: string; kind?: string; value?: string }>;
  const r = recips.find((x) => x?.id === input.recipientId);
  if (!r || typeof r.value !== 'string') throw new ApiError('bad_request', 'Pick one of your saved test recipients');
  let to: string;
  if (input.channel === 'sms') {
    if (r.kind !== 'phone') throw new ApiError('bad_request', 'Pick a saved phone number for an SMS test');
    // '+41…' or '0041…'; a national number (no country code) is refused.
    const e164 = normalizeE164('', r.value);
    const country = e164 ? phoneCountry(e164)?.country ?? null : null;
    if (!e164) throw new ApiError('bad_request', 'Save this number in international format (+41 … or 0041 …)');
    if (!country || !settings.sms.allowedCountries.includes(country)) throw new ApiError('bad_request', 'SMS to that country is not allowed');
    to = e164;
  } else {
    if (r.kind !== 'email') throw new ApiError('bad_request', 'Pick a saved email address for an email test');
    to = r.value;
  }

  await refreshClock();
  const at = now();
  const guestInfo = await loadGuestInfo(venueId);
  const vars = { ...sampleOccasion(found.definition, slots, at, input.offerSlot), ...offerVars(found.definition, slots, offers, at, input.offerSlot) };
  // The engine's link rules (a test shows what a guest would get): booking, info page, offer.
  const gates = linkGates(guestInfo, lang, pool, typeof vars.offerKey === 'string', slots.booking_url);
  const bookingUrl = validBookingUrl(gates.bookingRaw);
  const placeholder = placeholderLink(VISITOR_BASE_URL);
  const links: Partial<Record<LinkKind, string>> = {
    rating: placeholder,
    ...(gates.offer ? { offer: placeholder } : {}),
    ...(gates.hub ? { hub: placeholder } : {}),
    ...(bookingUrl ? { booking: bookingUrl } : {}),
  };
  const isStay = found.definition.entry.trigger.type === 'stay.window';
  // Rendered in the wording's own language, as the engine does (a French guest gets the English
  // wording with English values and the English STOP line when there is no French one).
  const wordingLang = content.locale;
  const values = renderValues({
    lang: wordingLang,
    tz: ctx?.tz ?? venue.timezone ?? 'Europe/Zurich',
    contact: { firstName: 'Anna', lastName: 'Muster' },
    venueName: ctx?.venueName || venue.name || '',
    vars,
    slots,
    offers,
    guestInfo,
    links,
    stay: isStay ? { checkInAt: at + DAY_MS, checkOutAt: at + 4 * DAY_MS + 2 * HOUR_MS, nights: 3, times: resolveStayTimes(guestInfo) } : null,
    // PR A7: an example Bring-a-friend code (a test send mints none).
    referralCode: 'ANNA-7K2Q',
  });
  const rendered = renderMessage(content.content, input.channel as Channel, values);
  if (rendered.missing.length) {
    throw new HttpError(422, 'validation_failed', 'Some values this message needs are missing', { missing: rendered.missing, reason: missingReason(rendered.missing) });
  }
  const masked = renderMessage(content.content, input.channel as Channel, maskSecretValues(values));

  const registry: AdapterRegistry = {};
  registerAdapters(registry); // sandbox provider in the local stack, Adaptive's own clients elsewhere
  const adapter = registry[input.channel];
  if (!adapter || !adapter.ready()) throw unavailable(`${input.channel === 'sms' ? 'SMS' : 'Email'} sending isn't set up on the server`);

  await takeTestSend(tenantUserId);
  // Not a journey send key (no `js_` prefix): provider webhooks for it find nothing to update.
  const sendKey = `test_${randomBytes(12).toString('hex')}`;
  let result;
  if (input.channel === 'sms') {
    const template = String((content.content as { text?: string }).text ?? '');
    result = await adapter.send({ kind: 'sms', to, body: smsFinalText(rendered.text, wordingLang, template), sendKey });
  } else {
    const email = content.content as { preheader?: string; bodyFormat?: 'text' | 'html' | 'blocks' };
    const pre = renderText(email.preheader ?? '', values).text;
    // The footer tag as guests get it: hidden when the account's plan hides it (engine/sendPath.ts).
    const [poweredBy, brand] = await Promise.all([
      getEntitlements(tenantUserId)
        .then((e) => !e.flags?.hidePoweredBy)
        .catch(() => true),
      // The guest's design: the account's branding and this venue's name, address and logo.
      loadDesignBrand(tenantUserId, { name: ctx?.venueName || venue.name || '', address: ctx?.venueAddress ?? venue.address, logoUrl: ctx?.venueLogoUrl }, { fresh: true }),
    ]);
    const offer = typeof vars.offerKey === 'string' ? offers.find((o) => o.offerKey === vars.offerKey) : undefined;
    const composed = composeEmail({
      body: rendered.text,
      bodyFormat: email.bodyFormat ?? 'text',
      preheader: pre,
      lang: wordingLang,
      unsubscribeUrl: null,
      poweredBy,
      design: {
        brand,
        content: content.content as { subject?: string; preheader?: string; body: string; bodyFormat?: 'text' | 'html' | 'blocks' },
        values,
        facts: { purpose, pool, offer: offer ? { kind: offer.kind, value: offer.value, currency: offer.currency } : null },
      },
    });
    if ('error' in composed) throw new ApiError('bad_request', "This email's format can't be sent yet");
    result = await adapter.send({ kind: 'email', to, subject: `[Test] ${rendered.subject ?? ''}`, html: composed.html, text: composed.text, sendKey, unsubscribeUrl: null });
  }
  const sent = result.kind === 'accepted';
  return {
    sent,
    channel: input.channel,
    journeyKey: input.journeyKey,
    nodeId,
    variant: variant.name,
    purpose,
    // The language the wording was in (English when the one asked for has none).
    wordingLang,
    to: input.channel === 'sms' ? maskedPhone(to) : maskedEmail(to),
    ...(sent ? {} : { problem: result.kind === 'rejected' ? `The provider refused it (${result.code})` : 'The provider did not confirm it' }),
    preview: { ...(masked.subject !== undefined ? { subject: masked.subject } : {}), text: masked.text },
  };
}

// ── PR PV: WhatsApp ──────────────────────────────────────────────────────────

interface WhatsAppTestInput {
  tenantUserId: string;
  venueId: string;
  venueName: string;
  tz: string;
  definition: JourneyDefinition;
  nodeId: string;
  pool: string;
  purpose: 'service' | 'marketing';
  slots: Record<string, SlotValue>;
  offers: Offer[];
  input: z.infer<typeof testSendInputSchema>;
}

/** What the owner reads when WhatsApp didn't take the test. */
export function whatsappTestProblem(r: ProviderResult): string {
  if (r.kind === 'retry') return 'WhatsApp is busy right now. Try again in a minute.';
  if (r.kind === 'unknown') return 'WhatsApp didn’t confirm this test. It may still arrive.';
  if (r.kind !== 'rejected') return 'WhatsApp didn’t take this test.';
  switch (r.code) {
    case '131030':
      return 'This number isn’t on the allowed list of HeidiFi’s WhatsApp app yet (Meta test mode).';
    case '131026':
      return 'WhatsApp couldn’t deliver to this number. Is WhatsApp set up on it?';
    case '131049':
      return 'WhatsApp held this marketing message back for this number. Try again tomorrow.';
    case '131050':
      return 'This number has stopped marketing messages from HeidiFi on WhatsApp.';
    case '132001':
      return 'WhatsApp doesn’t know this template in this language (any more). HeidiFi needs to check it.';
    case '132015':
      return 'WhatsApp has paused this template.';
    case '132016':
      return 'WhatsApp has disabled this template.';
    default:
      return r.config ? `WhatsApp sending isn’t set up correctly on the server (Meta code ${r.code}).` : `WhatsApp refused it: ${r.message} (code ${r.code})`;
  }
}

/**
 * Send test on WhatsApp (PR PV, D2): the message's APPROVED template — the asked language if
 * approved, else English (whatsapp/pick.ts, W3's rule) — to a saved phone recipient. Values as the
 * other tests (Anna, the venue's own), in the template's language; never empty, never multi-line.
 * The link button carries the same placeholder as the other tests' links. Same rules as SMS and
 * email: the shared daily cap (plus WHATSAPP_TEST_DAILY_LIMIT), no send record, no credits; not
 * limited to the SMS countries. Every test lands in the WhatsApp activity log (W1's "log everything").
 */
async function testSendWhatsApp(a: WhatsAppTestInput) {
  const { input } = a;
  if (!a.definition.pools?.[a.pool]?.channels.includes('whatsapp')) throw new ApiError('bad_request', 'This message doesn’t go by WhatsApp');
  const lang: Lang = input.lang ?? 'en';
  const pick = pickWaTemplate(await loadWaPickContext(), { journeyKey: input.journeyKey, poolKey: a.pool }, lang, { approvedOnly: true });
  const source = pick?.template.source;
  const compiled = pick?.template.compiled;
  if (!pick || !source || !compiled) {
    throw new HttpError(422, 'validation_failed', 'This message has no approved WhatsApp template yet', { reason: 'whatsapp_template_missing' });
  }

  // The recipient: one of the account's saved test recipients, a phone number.
  const recips = ((await db.collection(TEST_RECIPIENTS).doc(a.tenantUserId).get()).get('recipients') ?? []) as Array<{ id?: string; kind?: string; value?: string }>;
  const r = recips.find((x) => x?.id === input.recipientId);
  if (!r || typeof r.value !== 'string') throw new ApiError('bad_request', 'Pick one of your saved test recipients');
  if (r.kind !== 'phone') throw new ApiError('bad_request', 'Pick a saved phone number for a WhatsApp test');
  const to = normalizeE164('', r.value);
  if (!to) throw new ApiError('bad_request', 'Save this number in international format (+41 … or 0041 …)');

  await refreshClock();
  const at = now();
  const guestInfo = await loadGuestInfo(a.venueId);
  const vars = { ...sampleOccasion(a.definition, a.slots, at, input.offerSlot), ...offerVars(a.definition, a.slots, a.offers, at, input.offerSlot) };
  // The button's link, by the engine's link rules (a test shows what a guest would get).
  const button = compiled.button;
  if (button) {
    // The asked language, as the SMS/email test and the engine (the guest's language): a German guest
    // with only an English template still gets the German Guest info's links.
    const gates = linkGates(guestInfo, lang, a.pool, typeof vars.offerKey === 'string', a.slots.booking_url);
    const kind = button.field.slice('link.'.length);
    const ok = kind === 'rating' || (kind === 'offer' && gates.offer) || (kind === 'hub' && gates.hub) || (kind === 'booking' && Boolean(validBookingUrl(gates.bookingRaw)));
    if (!ok) throw new HttpError(422, 'validation_failed', 'Some values this message needs are missing', { missing: [button.field], reason: missingReason([button.field]) });
  }
  const isStay = a.definition.entry.trigger.type === 'stay.window';
  const values = renderValues({
    lang: pick.lang,
    tz: a.tz,
    contact: { firstName: 'Anna', lastName: 'Muster' },
    venueName: a.venueName,
    vars,
    slots: a.slots,
    offers: a.offers,
    guestInfo,
    links: {},
    stay: isStay ? { checkInAt: at + DAY_MS, checkOutAt: at + 4 * DAY_MS + 2 * HOUR_MS, nights: 3, times: resolveStayTimes(guestInfo) } : null,
    referralCode: 'ANNA-7K2Q',
  });
  const body = waBodyValues(source, compiled, values);
  if (body.missing.length) {
    throw new HttpError(422, 'validation_failed', 'Some values this message needs are missing', { missing: body.missing, reason: missingReason(body.missing) });
  }

  const adapter = whatsappTestAdapter(); // the sandbox in the local stack, Meta elsewhere
  if (!adapter.ready()) throw unavailable('WhatsApp sending isn’t set up on the server');
  await takeTestSend(a.tenantUserId, { whatsapp: true });
  // Not a journey send key: a status webhook for it finds nothing to update.
  const sendKey = `test_${randomBytes(12).toString('hex')}`;
  // Meta's index of the link button we fill: our own templates have one button; a linked one may have more.
  const metaIndex = pick.template.meta?.buttons?.findIndex((b) => b.type === 'URL') ?? -1;
  // The tests' link placeholder (`s/xxxxxxxx`): the button's URL is the visitor host + this.
  const placeholder = `s/${'x'.repeat(SHORT_CODE_LENGTH)}`;
  const result = await adapter.send({
    kind: 'whatsapp',
    to,
    templateName: pick.template.name,
    language: pick.template.language,
    bodyParams: body.params,
    button: button ? { index: metaIndex >= 0 ? metaIndex : 0, param: placeholder } : null,
    previewText: body.text,
    sendKey,
  });
  const sent = result.kind === 'accepted';
  const masked = maskedPhone(to);
  await writeLog(
    {
      kind: sent ? 'test.sent' : 'test.not_sent',
      level: sent ? 'info' : 'warn',
      actor: { kind: 'system', uid: null, label: 'Owner test send' },
      summary: sent
        ? `An owner sent a test of ${pick.template.name} (${pick.template.language}) to ${masked}: Meta took it`
        : `An owner’s test of ${pick.template.name} (${pick.template.language}) to ${masked} wasn’t sent: ${result.kind === 'rejected' ? `${result.code} ${result.message}` : result.reason}`,
      detail: {
        tenantUserId: a.tenantUserId,
        venueId: a.venueId,
        journeyKey: input.journeyKey,
        nodeId: a.nodeId,
        to: masked,
        outcome: result.kind,
        ...(result.kind === 'accepted' ? { messageId: result.providerMessageId } : {}),
        ...(result.kind === 'rejected' ? { code: result.code, message: result.message, setup: result.config === true } : {}),
        ...(result.kind === 'retry' || result.kind === 'unknown' ? { reason: result.reason } : {}),
      },
    },
    { templateId: pick.template.id, name: pick.template.name, language: pick.template.language, poolKey: a.pool },
  );
  return {
    sent,
    channel: 'whatsapp' as const,
    journeyKey: input.journeyKey,
    nodeId: a.nodeId,
    // The template's name stands in for the wording's.
    variant: pick.template.name,
    purpose: a.purpose,
    wordingLang: pick.lang,
    to: masked,
    ...(sent ? {} : { problem: whatsappTestProblem(result) }),
    preview: {
      text: waBodyValues(source, compiled, maskSecretValues(values)).text,
      footer: source.footer ?? null,
      button: button ? { text: button.text } : null,
    },
  };
}
