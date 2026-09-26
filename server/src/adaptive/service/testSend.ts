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

import { randomBytes } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { venuePlaybookId } from '../store/collections';
import type { VenuePlaybookDoc } from '../store/types';
import type { Actor, Offer, SlotValue } from '../core/schemas';
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
import { composeEmail, maskSecretValues, placeholderLink, smsFinalText } from '../send/compose';
import { VISITOR_BASE_URL, validBookingUrl } from '../send/links';
import { registerAdapters, type AdapterRegistry } from '../send/adapters';
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
  channel: z.enum(['sms', 'email']),
  lang: z.enum(LANGS).optional(),
  recipientId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
});

/** The shared daily cap — the same doc and limit as `/internal/test-send`, but failing closed. */
async function takeTestSend(tenantUserId: string): Promise<void> {
  const config = await getCreditConfig();
  const limit = Number(config.testSendDailyLimit) || 0;
  if (limit <= 0) return; // 0 = uncapped (as the Campaign test send)
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection(TEST_COUNTERS).doc(`${tenantUserId}_${day}`);
  let allowed: boolean;
  try {
    allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (Number(snap.data()?.count ?? 0) >= limit) return false;
      tx.set(ref, { tenantUserId, day, count: FieldValue.increment(1), updatedAt: new Date() }, { merge: true });
      return true;
    });
  } catch {
    throw unavailable("Test sends can't be counted right now — try again in a minute");
  }
  if (!allowed) throw tooManyRequests(`Daily test-send limit reached (${limit}/day). Try again tomorrow.`);
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

function offerVars(slots: Record<string, SlotValue>, offers: Offer[], at: number): Record<string, unknown> {
  const chosen = slots.offer;
  const offer = typeof chosen === 'string' ? offers.find((o) => o.offerKey === chosen) : undefined;
  if (!offer) return {};
  const days = typeof slots.offer_days === 'number' ? slots.offer_days : offer.expiryDays;
  return { offerKey: offer.offerKey, offerLabel: offer.label, offerDays: days, offerExpiresAt: at + days * DAY_MS };
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
  const variant = cat.variants
    .filter((v) => v.poolKey === pool && v.status === 'active' && variantEligible(v, slots))
    .sort((a, b) => a.letter.localeCompare(b.letter))[0];
  if (!variant) throw new ApiError('bad_request', 'There is no wording for this step with your settings');
  const lang: Lang = input.lang ?? 'en';
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
  const vars = offerVars(slots, offers, at);
  // The engine's link rules (a test shows what a guest would get): booking, info page, offer.
  const gates = linkGates(guestInfo, lang, pool, typeof vars.offerKey === 'string');
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
    const pre = renderMessage({ text: email.preheader ?? '' }, 'sms', values).text;
    // The footer tag as guests get it: hidden when the account's plan hides it (engine/sendPath.ts).
    const poweredBy = await getEntitlements(tenantUserId)
      .then((e) => !e.flags?.hidePoweredBy)
      .catch(() => true);
    const composed = composeEmail({ body: rendered.text, bodyFormat: email.bodyFormat ?? 'text', preheader: pre, lang: wordingLang, unsubscribeUrl: null, poweredBy });
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
