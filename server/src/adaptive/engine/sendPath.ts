/**
 * One send step, end to end (04-engine-runtime §4–§6):
 *
 *   resume if a send record already exists (a retried task never sends twice)
 *   → time (now, or a slot later in the venue's day)
 *   → facts (contact, consent, blocks, caps, weekly touches, counts, credits)
 *   → channel → wording → render → the 10-rule gate → the "why" record
 *   → test run: write a `dry_run` send record and carry on as if sent
 *     live:     mint the links → phase 1 transaction → provider → record → charge
 *               (send/dispatch.ts)
 *
 * The SMS is priced on exactly the text that goes out: same-length placeholders
 * for the links until the gate says yes, the STOP line in the guest's language.
 */

import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactDoc, ContactPointDoc, ContactVenueDoc, JourneySendDoc, NetworkPersonDoc } from '../store/engineTypes';
import type { AdaptiveConfig, JourneyDefinition } from '../core/schemas';
import type { Channel, Lang } from '../core/constants';
import { canonicalField, getNodeContract, parseMergeExpressions } from '../core/registry';
import { sendKeyFor } from '../core/runtime/ids';
import { checkChannel, pickChannel, pickTime, pickVariant, type ChannelCheck, type ChannelFacts, type ChannelRule } from '../core/runtime/pickers';
import { checkSystem, runGate, type GateInput, type GateResult } from '../core/runtime/gate';
import { buildDecision, type DecisionRecord } from '../core/runtime/decision';
import { DAY_MS, HOUR_MS, MINUTE_MS, atLocalTime, durationMs } from '../core/runtime/time';
import { phoneCountry } from '../core/runtime/phoneCountry';
import type { LastTouch } from '../core/runtime/types';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../core/constants';
import { sha256Hex } from '../core/checksum';
import { consentFor } from '../identity/resolve';
import { loadCatalogue } from '../service/catalogue';
import type { EngineSettings } from '../store/engineSettings';
import { retentionFrom, tsMs } from '../store/time';
import { getCreditConfig, creditsForMessage, getWalletSnapshot, onCreditsSpent, providerCostForMessage } from '../../services/credits';
import { spendableForChannel } from '../../services/creditBuckets';
import { getEntitlements } from '../../services/entitlements';
import { smsSegments } from '../../services/smsBilling';
import { maskDestination } from '../../services/phone';
import type { ChannelAdapter, Outbound } from '../send/adapters/types';
import { composeEmail, maskSecretValues, smsFinalText } from '../send/compose';
import { linkKindsUsed, mintLinks, pricingLinks, unsubscribeUrlFor, validBookingUrl } from '../send/links';
import { MAX_DISPATCH_ATTEMPTS, callProvider, chargeSend, claimSend, dispatchLease, markStuckUnknown, recordResult, scheduleChargeRepair, type LiveSend } from '../send/dispatch';
import { dayKey, raiseAlert } from './alerts';
import { journeyOnState, loadContact, loadGuestInfo, type PinnedConfig, type VenueContext } from './context';
import { DRY_RUN_LINKS, guestInfoField, guestInfoHasContent, missingReason, renderMessage, renderValues, variantContent, variantEligible, type LinkKind } from './renderSend';
import { resolveStayTimes } from '../stays/times';
import type { LoadedStay } from '../stays/store';
import { renderText } from '../core/render';
import { platformLiveSendsSince, venueLiveSendsSince, venueServiceSendsSince } from './counts';
import { instanceRef, type LoadedInstance } from './instanceStore';
import type { EventInput } from './events';
import { eventDoc, eventRef } from './events';

type SendConfig = {
  purpose: 'marketing' | 'service';
  pool: string;
  channel: ChannelRule;
  requireDiff?: Array<'channel' | 'variant' | 'slot'>;
  timing: { mode: 'now' | 'slot' | 'local_time'; default?: 'morning' | 'afternoon' | 'evening'; at?: string };
  expireAfter?: string;
  highValue?: boolean;
  urgent?: boolean;
};

export type SendOutcome =
  | {
      kind: 'done';
      outcome: 'sent' | 'skipped';
      touch: LastTouch | null;
      ladderPos?: number;
      /** The instance rev after the send's own transaction (test run / live dispatch bump it). */
      revAfter: number | null;
      suppress: boolean;
      /** The booking was cancelled: the journey ends as `cancelled` (D-C19), it doesn't move on. */
      stayCancelled?: boolean;
      events: EventInput[];
    }
  | {
      kind: 'later';
      at: number;
      intendedAt: number;
      slot: string;
      reason: string;
      creditsWaitStartedAt?: number;
      /** A provider "try again later": how many so far. */
      dispatchAttempts?: number;
      /** Set when this step already bumped the instance (a dispatch that has to wait). */
      revAfter?: number | null;
      events: EventInput[];
    }
  /** Another worker is in the middle of this send: look again shortly. */
  | { kind: 'busy'; retryAt: number }
  /** The instance moved on while we looked (rev changed): the caller re-reads. */
  | { kind: 'conflict' };

/** The provider adapters (send/adapters/index.ts fills this in the worker). A channel without a ready adapter is not used live. */
export const channelAdapters: Partial<Record<Channel, ChannelAdapter>> = {};

const DISPATCH_BUSY_RETRY_MS = 2 * MINUTE_MS;

function lastClickChannel(contact: ContactDoc): Channel | null {
  return contact.engagement?.lastClickChannel ?? null;
}

export interface SendArgs {
  inst: LoadedInstance;
  nodeId: string;
  definition: JourneyDefinition;
  ctx: VenueContext | null;
  pinned: PinnedConfig;
  now: number;
  /** Fired by the send_due timer: the time was already chosen. */
  dueRun: boolean;
  /** When the timer or event that led to this step was due — a late one makes the send stale. */
  reachedAt: number;
  taskDueAt: number;
  settings: EngineSettings;
  workerId: string;
  /** Events earlier steps of this run produced, not yet committed: a live claim writes them (and removes them here). */
  pendingEvents?: EventInput[];
  /** A stay journey's booking, read fresh by `advance` (null when it is gone). */
  stay?: LoadedStay | null;
}

export async function runSend(a: SendArgs): Promise<SendOutcome> {
  const { inst, nodeId, now } = a;
  const node = a.definition.nodes[nodeId];
  const parsed = getNodeContract('send')!.configSchema.safeParse(node?.config ?? {});
  if (!parsed.success) return skipOutcome('bad_step_config', a.now);
  const cfg = parsed.data as SendConfig;
  const sendKey = sendKeyFor(inst.id, nodeId);
  const mode = inst.meta.mode;
  const lang = inst.meta.context.lang;
  const tz = inst.meta.context.venueTz;

  // ── 0. Resume: a record for this step means it was already decided ──
  const existing = await db.collection(COL.journeySends).doc(sendKey).get();
  if (existing.exists) {
    const s = existing.data() as JourneySendDoc;
    if (s.status === 'dispatching') {
      const leaseUntil = tsMs(s.dispatchLease?.until) ?? 0;
      if (leaseUntil > Date.now()) return { kind: 'busy', retryAt: now + DISPATCH_BUSY_RETRY_MS };
      // The worker died mid-send: it may have left, so never send again (compare-and-set).
      await markStuckUnknown(sendKey);
    }
    // Accepted but not yet charged (the worker died between the two): charge now.
    if (s.mode === 'live' && s.sentAt && s.credits && s.credits.amount >= 1 && !s.credits.ledgerId) {
      await chargeSend(sendKey).catch(() => scheduleChargeRepair(inst.meta.tenantUserId, inst.meta.venueId, sendKey, now));
    }
    const went = !['failed', 'bounced', 'cancelled'].includes(s.status);
    // Keep the ladder position the send moved to, so "next on ladder" moves on.
    const ladderPos = typeof s.ladderPos === 'number' ? s.ladderPos : a.definition.channelLadder.indexOf(s.channel);
    return {
      kind: 'done',
      outcome: went ? 'sent' : 'skipped',
      touch: went ? { channel: s.channel, variantId: s.variantId ?? '', slot: s.slot, sendKey, purpose: s.purpose, at: tsMs(s.createdAt) ?? now } : null,
      ...(went && ladderPos >= 0 ? { ladderPos } : {}),
      revAfter: null,
      suppress: false,
      events: [],
    };
  }

  const cat = await loadCatalogue();
  const rules: AdaptiveConfig = cat.config;

  // ── 1. Time ──
  let intendedAt = now;
  let slot = 'now';
  let slotRule = 'now';
  if (!a.dueRun) {
    if (now - a.reachedAt > a.settings.safety.staleAfterHours * HOUR_MS) {
      // Reached by a timer that fired long after it was due (the worker was stopped):
      // keep the planned time, so rule 1 skips it as stale instead of sending late.
      intendedAt = a.reachedAt;
      slotRule = 'reached_late';
    } else {
      const pick = pickTime(cfg.timing, now, tz, rules.slots, sendKey);
      slot = pick.slot;
      slotRule = pick.rule;
      if (pick.at > now + MINUTE_MS) {
        return { kind: 'later', at: pick.at, intendedAt: pick.at, slot, reason: 'slot', events: [] };
      }
    }
  } else {
    intendedAt = inst.state.waiting?.intendedAt ?? a.taskDueAt;
    slot = inst.state.waiting?.slot ?? 'now';
    slotRule = `slot:${slot}`;
  }

  // ── 2. Facts ──
  const contact = await loadContact(inst.meta.contactId);
  if (!contact || contact.status !== 'active') return skipOutcome('contact_gone', now);

  const [cvSnap, cpEmailSnap, cpPhoneSnap, npSnap, guestInfo, tenantSnap] = await Promise.all([
    db.collection(COL.contactVenues).doc(contactVenueId(inst.meta.contactId, inst.meta.venueId)).get(),
    contact.emailPointId ? db.collection(COL.contactPoints).doc(contact.emailPointId).get() : Promise.resolve(null),
    contact.phonePointId ? db.collection(COL.contactPoints).doc(contact.phonePointId).get() : Promise.resolve(null),
    db.collection(COL.networkPeople).doc(inst.meta.networkId).get(),
    loadGuestInfo(inst.meta.venueId),
    db.collection(COL.tenantUsers).doc(inst.meta.tenantUserId).get(),
  ]);
  const cv = (cvSnap.data() ?? {}) as Partial<ContactVenueDoc>;
  const cpEmail = (cpEmailSnap?.data() ?? null) as ContactPointDoc | null;
  const cpPhone = (cpPhoneSnap?.data() ?? null) as ContactPointDoc | null;
  const np = (npSnap.data() ?? null) as NetworkPersonDoc | null;
  const consent = consentFor(contact, inst.meta.venueId);

  // Wording the owner's values allow (D-C22: no "late check-out for CHF 0"); built once, so
  // the channel check and the pick below see the same list.
  const variants = cat.variants.filter((v) => v.poolKey === cfg.pool && v.status === 'active' && variantEligible(v, a.pinned.slots));
  const unsubscribeReady = Boolean(process.env.UNSUBSCRIBE_SIGNING_SECRET && process.env.SERVER_PUBLIC_URL);

  const channelFacts = (channel: Channel): ChannelFacts => {
    const email = channel === 'email';
    const cp = email ? cpEmail : cpPhone;
    const audience = email ? a.ctx?.audience.email ?? 'all' : a.ctx?.audience.sms ?? 'verified';
    const verified = email ? contact.emailVerified : contact.phoneVerified;
    let ruleFail: string | null = null;
    if (channel === 'whatsapp') ruleFail = 'whatsapp_off';
    else if (channel === 'sms') {
      const country = phoneCountry(contact.phoneE164)?.country ?? null;
      if (!country || !a.settings.sms.allowedCountries.includes(country)) ruleFail = 'country_not_allowed';
    } else if (email && cfg.purpose === 'marketing' && !unsubscribeReady) ruleFail = 'email_unsubscribe_not_configured';
    // Live: a channel whose provider isn't set up is skipped, so the ladder moves on (e.g. to email).
    if (!ruleFail && mode === 'live' && !channelAdapters[channel]?.ready()) ruleFail = 'channel_not_ready';
    return {
      channel,
      hasAddress: email ? Boolean(contact.email) : Boolean(contact.phoneE164),
      consent: consent[channel]?.state ?? 'none',
      suppressed: cp?.suppression?.[channel]?.reason ?? null,
      audienceOk: audience === 'all' || Boolean(verified),
      hasWording: variants.some((v) => Boolean(variantContent(v, channel, lang))),
      ruleFail,
    };
  };

  // ── 3. The account and the venue (channel-independent) — rule 1 runs first, so a
  //       paused venue or a stale send stops even a guest with no usable channel ──
  const live = mode === 'live';
  const dayStart = atLocalTime(new Date(now), tz, '00:00', 0).getTime();
  const monthStart = now - 30 * DAY_MS;
  let lapsed: boolean | 'unknown' = false;
  let wallet: Awaited<ReturnType<typeof getWalletSnapshot>> | null = null;
  let venueToday = 0;
  let platformToday = 0;
  let serviceMonth = 0;
  if (live) {
    const [ent, w, vt, pt, sm] = await Promise.all([
      getEntitlements(inst.meta.tenantUserId).then((e) => e.suspended).catch(() => 'unknown' as const),
      cfg.purpose === 'marketing' ? getWalletSnapshot(inst.meta.tenantUserId).catch(() => null) : Promise.resolve(null),
      venueLiveSendsSince(inst.meta.venueId, dayStart),
      platformLiveSendsSince(now - DAY_MS),
      cfg.purpose === 'service' ? venueServiceSendsSince(inst.meta.venueId, monthStart) : Promise.resolve(0),
    ]);
    lapsed = ent;
    wallet = w;
    venueToday = vt;
    platformToday = pt;
    serviceMonth = sm;
  }
  const onState = await journeyOnState(a.ctx, inst.meta.installId, inst.meta.journeyKey);
  const system: GateInput['system'] = {
    paused: a.settings.paused,
    lapsed,
    tenantActive: tenantSnap.get('active') !== false,
    venueOn: onState.venueOn,
    journeyOn: onState.journeyOn,
    offSinceAt: onState.offSinceAt,
    freezeWindowMs: Number.isFinite(rules.freezeWindowMinutes) ? rules.freezeWindowMinutes * MINUTE_MS : undefined,
    staleAfterMs: a.settings.safety.staleAfterHours * HOUR_MS,
    venueSendsToday: venueToday,
    venueCeiling: a.settings.safety.maxSendsPerVenuePerDay,
    platformSendsToday: platformToday,
    platformCeiling: a.settings.safety.maxSendsPlatformPerDay,
    channelReady: true,
    // Rule 1: the stay isn't cancelled (a stay journey whose Stay is gone counts as cancelled).
    stayCancelled: Boolean(inst.meta.context.stayId) && (!a.stay || a.stay.status === 'cancelled'),
  };

  const versions = { template: inst.meta.templateVersion, config: inst.meta.configVersion, playbook: inst.meta.playbookKey, engine: ENGINE_VERSION };
  const slotRecord = { picked: slot, rule: slotRule, plannedAt: intendedAt };
  const pre = checkSystem({ now, mode, purpose: cfg.purpose, channel: 'email', intendedAt, system } as GateInput);
  if (pre.verdict !== 'allow') {
    const gate = { verdict: pre.verdict, rule: 'system' as const, reason: pre.reason ?? null, until: pre.until ?? null, checks: [pre] };
    const decision = buildDecision({ now, mode, poolKey: cfg.pool, purpose: cfg.purpose, gate, channelChecks: [], channel: { picked: null, rule: 'not reached' }, variant: { picked: null, method: 'none' }, slot: slotRecord, credits: null, versions });
    if (pre.verdict === 'defer' && pre.until !== undefined) {
      const firstOfReason = inst.state.waiting?.lastDeferReason !== pre.reason;
      if (firstOfReason) void alertFor(pre.reason ?? null, a, tz);
      return {
        kind: 'later',
        at: pre.until,
        intendedAt,
        slot,
        reason: pre.reason ?? 'defer',
        creditsWaitStartedAt: inst.state.waiting?.creditsWaitStartedAt,
        ...(inst.state.waiting?.nodeId === nodeId && inst.state.waiting?.dispatchAttempts !== undefined ? { dispatchAttempts: inst.state.waiting.dispatchAttempts } : {}),
        events: firstOfReason ? [{ tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, contactId: inst.meta.contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, mode, nodeId, sendKey, type: 'send.deferred', occurredAt: now, data: { decision, until: pre.until } }] : [],
      };
    }
    return skipWith(decision, a, sendKey, undefined, pre.reason === 'switched_off', pre.reason === 'stay_cancelled');
  }

  // ── 4. Channel ──
  const ladder = a.definition.channelLadder;
  const allChannels = Array.from(new Set<Channel>([...ladder, 'email', 'sms', 'whatsapp']));
  const checks: ChannelCheck[] = allChannels.map((c) => checkChannel(cfg.purpose, channelFacts(c)));
  // A channel skipped because HeidiFi's setup is missing (worker env): one alert a day, platform-wide.
  for (const c of checks) {
    if (!c.ok && (c.reason === 'channel_not_ready' || c.reason === 'email_unsubscribe_not_configured') && ladder.includes(c.channel)) void alertSkippedChannel(c.channel, c.reason, a);
  }
  const eligible = checks.filter((c) => c.ok).map((c) => c.channel);
  const pick = pickChannel({
    rule: cfg.channel,
    eligible,
    ladder,
    state: inst.state,
    preferredChannel: contact.engagement?.preferredChannel ?? null,
    consecutiveNoClickOnPreferred: contact.engagement?.consecutiveNoClickOnPreferred ?? 0,
    lastClickChannel: lastClickChannel(contact),
  });

  const baseDecision = {
    now,
    mode,
    poolKey: cfg.pool,
    purpose: cfg.purpose,
    channelChecks: checks,
    channel: { picked: pick.channel, rule: pick.rule },
    slot: slotRecord,
    versions,
  };

  if (!pick.channel) {
    // Say why in the owner's words when the only obstacle was their own audience choice.
    // Among the channels this guest could be reached on at all (has an address, not switched off).
    const reachable = checks.filter((c) => !c.ok && ladder.includes(c.channel) && c.reason !== 'no_address' && c.reason !== 'whatsapp_off');
    const onlyAudience = reachable.length > 0 && reachable.every((c) => c.reason === 'audience');
    const decision = buildDecision({
      ...baseDecision,
      gate: null,
      variant: { picked: null, method: 'none' },
      credits: null,
      ...(onlyAudience ? { noChannel: { rule: 'channel_rules' as const, reason: 'audience', fact: 'the owner chose to message verified guests only' } } : {}),
    });
    return skipWith(decision, a, sendKey);
  }
  const channel = pick.channel;

  // ── 5. Wording + render ──
  const vpick = pickVariant(
    variants.filter((v) => variantContent(v, channel, lang)).map((v) => ({ id: v.id, letter: v.letter })),
    inst.state.lastTouch?.variantId ?? null,
  );
  const variant = variants.find((v) => v.id === vpick.variantId)!;
  const vc = variantContent(variant, channel, lang)!;
  // Links: same-length stand-ins for pricing and the gate (real ones are minted only
  // once the gate says yes), readable ones for the stored preview.
  const bookingUrl = validBookingUrl(guestInfo?.locales?.[lang]?.directBookingUrl ?? guestInfo?.locales?.en?.directBookingUrl);
  const guestId = inst.meta.context.guestId ?? contact.guestIds?.[contact.guestIds.length - 1] ?? null;
  const priceLinks: Partial<Record<LinkKind, string>> = pricingLinks(['offer', 'rating', 'hub', 'booking']);
  const previewLinks: Partial<Record<LinkKind, string>> = { ...DRY_RUN_LINKS };
  // D-C21: the info page link only goes out when Guest info has something on it — and
  // Local tips only when there are tips — else the send is skipped as guest_info_missing.
  const hubReady = guestInfoHasContent(guestInfo) && (cfg.pool !== 'local_tips' || guestInfoField(guestInfo, lang, 'localTips') !== null);
  for (const links of [priceLinks, previewLinks]) {
    if (!bookingUrl) delete links.booking;
    if (typeof inst.state.vars.offerKey !== 'string') delete links.offer;
    if (!hubReady) delete links.hub;
  }
  const unsubscribeUrl = channel === 'email' && cfg.purpose === 'marketing' && mode === 'live' ? unsubscribeUrlFor(guestId, inst.meta.venueId, sendKey) : '';
  if (unsubscribeUrl) priceLinks.unsubscribe = unsubscribeUrl;
  else if (channel === 'email' && cfg.purpose === 'marketing' && mode === 'test') priceLinks.unsubscribe = DRY_RUN_LINKS.unsubscribe;
  const valuesWith = (links: Partial<Record<LinkKind, string>>) =>
    renderValues({
      lang: vc.locale,
      tz,
      contact,
      venueName: a.ctx?.venueName ?? '',
      vars: inst.state.vars,
      slots: a.pinned.slots,
      offers: a.pinned.offers,
      guestInfo,
      links,
      // Stay dates and nights, and the check-in/out times the stay was scheduled with (D-C20).
      stay: inst.meta.context.stayId && a.stay ? { checkInAt: a.stay.checkInAt, checkOutAt: a.stay.checkOutAt, nights: a.stay.nights, times: resolveStayTimes(guestInfo) } : null,
    });
  const values = valuesWith(priceLinks);
  const rendered = renderMessage(vc.content, channel, values);
  const preheader = channel === 'email' ? renderText(String((vc.content as { preheader?: string }).preheader ?? ''), values) : null;
  if (preheader?.unknown.length) rendered.missing.push(...preheader.unknown);
  const previewRendered = renderMessage(vc.content, channel, maskSecretValues(valuesWith(previewLinks)));
  const smsText = channel === 'sms' ? smsFinalText(rendered.text, vc.locale, String((vc.content as { text?: string }).text ?? '')) : undefined;

  // ── 6. Price + the full gate ──
  const creditConfig = await getCreditConfig();
  const price = cfg.purpose === 'marketing' ? creditsForMessage(creditConfig, channel, smsText) : 0;
  const providerCostMinor = providerCostForMessage(creditConfig, channel, smsText);
  const segments = smsText !== undefined ? smsSegments(smsText) : null;
  // A wallet in the red is suspended: nothing is spendable.
  const spendable = wallet ? (wallet.suspended ? 0 : spendableForChannel(wallet.channelBalances, channel)) : null;
  const weekAgo = now - 7 * DAY_MS;
  const weekly = (np?.recentMarketingTouches ?? []).filter((t) => (tsMs(t.at) ?? 0) >= weekAgo).length;
  const tmplCaps = a.definition.caps;
  const maxTouches = Math.min(tmplCaps?.maxTouches ?? rules.caps.maxTouchesPerJourney, rules.caps.maxTouchesPerJourney);
  const stopAfterClicks = Math.min(tmplCaps?.stopAfterClicks ?? rules.caps.stopAfterClicks, rules.caps.stopAfterClicks);

  const gateInput: GateInput = {
    now,
    mode,
    purpose: cfg.purpose,
    channel,
    urgent: Boolean(cfg.urgent),
    enteredAt: inst.state.cursor.enteredAt,
    expireAfterMs: cfg.expireAfter ? durationMs(cfg.expireAfter) : null,
    intendedAt,
    jitterKey: sendKey,
    system: { ...system, channelReady: Boolean(channelAdapters[channel]?.ready()) },
    address: { blocked: null, lowRatingAt: tsMs(cv.lowRatingAt) },
    consent: { state: consent[channel]?.state ?? 'none' },
    channelRules: {
      audienceOk: true,
      audienceFact:
        channel === 'sms'
          ? `${contact.phoneVerified ? 'verified' : 'unverified'} number (owner: ${a.ctx?.audience.sms === 'all' ? 'everyone' : 'verified only'})`
          : `email${contact.emailVerified ? ' (verified)' : ''}`,
      ruleFail: rendered.missing.length ? missingReason(rendered.missing) : null,
    },
    caps: { touches: inst.state.counters.touches, maxTouches, clicks: inst.state.counters.clicks, stopAfterClicks },
    diff: { lastTouch: inst.state.lastTouch, variantId: variant.id, slot },
    weekly: { count: weekly, limit: rules.caps.globalMarketingPer7Days },
    quiet: {
      venueTz: tz,
      phoneTz: inst.meta.context.phoneTz,
      window: rules.quietHours,
      utilityWindow: rules.utilityQuietHours,
      jitterMinutes: rules.deferJitterMinutes,
    },
    fairUse: { count: serviceMonth, limit: rules.utilityFairUsePerVenuePerMonth },
    credits: { price, spendable: live ? spendable : null, waitStartedAt: inst.state.waiting?.creditsWaitStartedAt ?? null, queueHours: rules.creditQueueHours },
  };
  const gate = runGate(gateInput);
  const decisionFor = (g: GateResult) =>
    buildDecision({
      ...baseDecision,
      gate: g,
      variant: { picked: variant.id, method: `${vpick.method}${vc.fallback ? ':en_fallback' : ''}` },
      credits: cfg.purpose === 'marketing' ? { price, balance: spendable } : null,
    });
  const decision = decisionFor(gate);

  const common = { tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, contactId: inst.meta.contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, mode, nodeId, sendKey, channel, variantId: variant.id, slot };

  // ── 5. Outcome ──
  if (gate.verdict === 'defer' && gate.until !== null) return deferred(gate, decision, a, { intendedAt, slot, sendKey, common, tz });

  if (gate.verdict === 'allow' && mode === 'test') {
    return dryRun({ a, sendKey, channel, variantId: variant.id, lang: vc.locale, slot, cfg, rendered: previewRendered, decision, price, ladderPos: pick.ladderPos, contact, common });
  }

  if (gate.verdict === 'allow') {
    return dispatchLive({
      a,
      sendKey,
      channel,
      cfg,
      decision,
      decisionFor,
      gateInput,
      variantId: variant.id,
      locale: vc.locale,
      content: vc.content,
      slot,
      intendedAt,
      ladderPos: pick.ladderPos,
      contact,
      rendered,
      previewRendered,
      valuesWith,
      price,
      providerCostMinor,
      rateCardVersion: creditConfig.rateCardVersion,
      creditConfig,
      guestId,
      bookingUrl,
      unsubscribeUrl,
      common,
      tz,
    });
  }

  if (gate.verdict === 'block') void alertFor(gate.reason, a, tz);
  return skipWith(decision, a, sendKey, common, gate.reason === 'switched_off', gate.reason === 'stay_cancelled');
}

/** A held-back send: when to look again, and the "why" once per reason. */
function deferred(
  gate: GateResult,
  decision: DecisionRecord,
  a: SendArgs,
  x: { intendedAt: number; slot: string; sendKey: string; common: Record<string, unknown>; tz: string; revAfter?: number | null; dispatchAttempts?: number },
): SendOutcome {
  const { inst } = a;
  const keepsIntended = gate.reason === 'paused' || gate.reason === 'lapse_unknown';
  const firstOfReason = inst.state.waiting?.lastDeferReason !== gate.reason;
  if (firstOfReason) {
    void alertFor(gate.reason, a, x.tz);
    // Waiting for credits: nudge the auto top-up once (plan §3.5 rule 10).
    if (gate.reason === 'credits') void onCreditsSpent(inst.meta.tenantUserId).catch(() => undefined);
  }
  return {
    kind: 'later',
    at: gate.until!,
    intendedAt: keepsIntended ? x.intendedAt : gate.until!,
    slot: x.slot,
    reason: gate.reason ?? 'defer',
    // The 72 h credit wait keeps counting through quiet hours and pauses.
    creditsWaitStartedAt: gate.reason === 'credits' ? inst.state.waiting?.creditsWaitStartedAt ?? a.now : inst.state.waiting?.creditsWaitStartedAt,
    ...(x.revAfter !== undefined ? { revAfter: x.revAfter } : {}),
    // "Try later" attempts survive a quiet-hours or credits hold of the same step.
    ...((x.dispatchAttempts ?? (inst.state.waiting?.nodeId === a.nodeId ? inst.state.waiting?.dispatchAttempts : undefined)) !== undefined
      ? { dispatchAttempts: x.dispatchAttempts ?? inst.state.waiting!.dispatchAttempts }
      : {}),
    events: firstOfReason ? [{ ...x.common, type: 'send.deferred', occurredAt: a.now, data: { decision, until: gate.until } } as EventInput] : [],
  };
}

const SETUP_BLOCKS = new Set(['channel_not_ready', 'rate_card_invalid', 'provider_unavailable', 'email_unsubscribe_not_configured', 'unsupported_format']);

/** Tells HeidiFi — once per venue, reason and day — when sends stop for a reason a person must fix. */
async function alertFor(reason: string | null, a: SendArgs, tz: string): Promise<void> {
  if (!reason || a.inst.meta.mode !== 'live') return;
  const day = dayKey(a.now, tz);
  const venue = a.ctx?.venueName || a.inst.meta.venueId;
  if (reason === 'venue_ceiling' || reason === 'platform_ceiling') {
    const venueWide = reason === 'venue_ceiling';
    await raiseAlert({
      kind: venueWide ? 'venue_ceiling' : 'platform_ceiling',
      dedupeKey: `${reason}:${venueWide ? a.inst.meta.venueId : 'all'}:${day}`,
      audience: 'heidifi',
      tenantUserId: a.inst.meta.tenantUserId,
      venueId: a.inst.meta.venueId,
      subject: venueWide ? `Adaptive: daily send limit reached at ${venue}` : 'Adaptive: platform daily send limit reached',
      text: venueWide
        ? `${venue} reached ${a.settings.safety.maxSendsPerVenuePerDay} messages today. Further sends wait until tomorrow.`
        : `The platform reached ${a.settings.safety.maxSendsPlatformPerDay} messages in 24 hours. Further sends wait.`,
    });
    return;
  }
  if (SETUP_BLOCKS.has(reason)) {
    await raiseAlert({
      kind: 'setup_block',
      dedupeKey: `setup:${reason}:${a.inst.meta.venueId}:${day}`,
      audience: 'heidifi',
      tenantUserId: a.inst.meta.tenantUserId,
      venueId: a.inst.meta.venueId,
      subject: `Adaptive: sends blocked at ${venue} (${reason})`,
      text: `A ${a.inst.meta.journeyKey} message at ${venue} was not sent: ${reason}. This needs a fix on HeidiFi's side.`,
    });
  }
}

/** A channel skipped for every guest because the worker lacks its settings (not a venue problem). */
async function alertSkippedChannel(channel: Channel, reason: string, a: SendArgs): Promise<void> {
  if (a.inst.meta.mode !== 'live') return;
  const what = reason === 'channel_not_ready' ? 'its provider credentials are missing on the adaptive-worker app' : 'UNSUBSCRIBE_SIGNING_SECRET / SERVER_PUBLIC_URL are missing on the adaptive-worker app';
  await raiseAlert({
    kind: 'setup_block',
    dedupeKey: `setup_skip:${reason}:${channel}:${dayKey(a.now, 'Europe/Zurich')}`,
    audience: 'heidifi',
    subject: `Adaptive: ${channel.toUpperCase()} is skipped for live guests (${reason})`,
    text: `${channel.toUpperCase()} messages are skipped at live venues because ${what}. Guests get the next channel on their journey's ladder where they have one.`,
  });
}

interface LiveArgs {
  a: SendArgs;
  sendKey: string;
  channel: Channel;
  cfg: SendConfig;
  decision: DecisionRecord;
  decisionFor: (g: GateResult) => DecisionRecord;
  gateInput: GateInput;
  variantId: string;
  locale: Lang;
  content: any;
  slot: string;
  intendedAt: number;
  ladderPos: number;
  contact: ContactDoc;
  rendered: { subject?: string; text: string; fieldsUsed: string[] };
  previewRendered: { subject?: string; text: string };
  valuesWith: (links: Partial<Record<LinkKind, string>>) => Record<string, string | undefined>;
  price: number;
  providerCostMinor: number;
  rateCardVersion: number;
  creditConfig: Awaited<ReturnType<typeof getCreditConfig>>;
  guestId: string | null;
  bookingUrl: string | null;
  unsubscribeUrl: string;
  common: Record<string, unknown>;
  tz: string;
}

/** Live: mint the links, build the exact message, then the three phases (send/dispatch.ts). */
async function dispatchLive(d: LiveArgs): Promise<SendOutcome> {
  const { a, sendKey } = d;
  const { inst } = a;
  const marketing = d.cfg.purpose === 'marketing';
  const block = (reason: string): SendOutcome => {
    void alertFor(reason, a, d.tz);
    return skipWith({ ...d.decision, result: 'block', rule: 'system', reason }, a, sendKey, d.common);
  };
  if (d.channel === 'whatsapp') return block('channel_not_ready');
  const channel = d.channel;
  const adapter = channelAdapters[channel];
  if (!adapter?.ready()) return block('channel_not_ready');
  if (marketing && (!Number.isInteger(d.price) || d.price < 1)) return block('rate_card_invalid');
  const attempts = inst.state.waiting?.nodeId === a.nodeId ? inst.state.waiting?.dispatchAttempts ?? 0 : 0;
  if (attempts >= MAX_DISPATCH_ATTEMPTS) return block('provider_unavailable');
  const address = channel === 'email' ? d.contact.email : d.contact.phoneE164;
  if (!address) return skipWith({ ...d.decision, result: 'skip', reason: 'no_address' }, a, sendKey, d.common);
  if (channel === 'email' && marketing && !d.unsubscribeUrl) return block('email_unsubscribe_not_configured');

  // Real links, only now that the gate said yes.
  const preheaderFields = parseMergeExpressions(String(d.content.preheader ?? '')).map((e) => canonicalField(e.name));
  const kinds = linkKindsUsed([...d.rendered.fieldsUsed, ...preheaderFields]);
  const minted = await mintLinks(kinds, {
    venueId: inst.meta.venueId,
    sendKey,
    instanceId: inst.id,
    contactId: inst.meta.contactId,
    variantId: d.variantId,
    channel,
    guestId: d.guestId ?? '',
    bookingUrl: d.bookingUrl,
  });
  const finalValues = d.valuesWith({ ...minted.urls, ...(d.unsubscribeUrl ? { unsubscribe: d.unsubscribeUrl } : {}) });
  const final = renderMessage(d.content, channel, finalValues);
  if (final.missing.length) return block(missingReason(final.missing));

  let message: Outbound;
  let smsBody: string | null = null;
  if (channel === 'sms') {
    smsBody = smsFinalText(final.text, d.locale, String(d.content.text ?? ''));
    message = { kind: 'sms', to: address, body: smsBody, sendKey };
  } else {
    const poweredBy = await getEntitlements(inst.meta.tenantUserId)
      .then((e) => !e.flags?.hidePoweredBy)
      .catch(() => true);
    const composed = composeEmail({
      body: final.text,
      bodyFormat: d.content.bodyFormat ?? 'text',
      preheader: renderText(String(d.content.preheader ?? ''), finalValues).text,
      lang: d.locale,
      unsubscribeUrl: marketing ? d.unsubscribeUrl : null,
      poweredBy,
    });
    if ('error' in composed) return block('unsupported_format');
    message = { kind: 'email', to: address, subject: final.subject ?? '', html: composed.html, text: composed.text, sendKey, unsubscribeUrl: marketing ? d.unsubscribeUrl : null };
  }
  // Priced on the placeholders; the real links have the same length, so this is the same number.
  const price = marketing ? creditsForMessage(d.creditConfig, channel, smsBody ?? undefined) : 0;
  if (price !== d.price) console.warn('[ADAPTIVE] final SMS priced differently than the gate saw:', sendKey, d.price, price);
  const segments = smsBody !== null ? smsSegments(smsBody) : null;
  const preview = (d.previewRendered.subject ? `${d.previewRendered.subject} — ` : '') + d.previewRendered.text;
  const pointId = channel === 'email' ? d.contact.emailPointId : d.contact.phonePointId;
  const doc: JourneySendDoc = {
    tenantUserId: inst.meta.tenantUserId,
    venueId: inst.meta.venueId,
    contactId: inst.meta.contactId,
    instanceId: inst.id,
    journeyKey: inst.meta.journeyKey,
    nodeId: a.nodeId,
    templateVersion: inst.meta.templateVersion,
    configVersion: inst.meta.configVersion,
    mode: 'live',
    purpose: d.cfg.purpose,
    channel,
    toPointId: pointId ?? null,
    toMasked: maskDestination(channel, address),
    variantId: d.variantId,
    locale: d.locale,
    slot: d.slot,
    status: 'dispatching',
    provider: adapter.provider,
    providerMessageId: null,
    errorCode: null,
    errorMessage: null,
    credits: marketing ? { amount: price, ledgerId: null, rateCardVersion: d.rateCardVersion } : null,
    providerCostMinor: d.providerCostMinor,
    smsSegments: segments,
    shortCodes: minted.codes,
    content: { ...(d.previewRendered.subject ? { subject: d.previewRendered.subject } : {}), preview: preview.slice(0, 280), bodyHash: sha256Hex(d.rendered.text).slice(0, 32) },
    engagement: { deliveredAt: null, openedAt: null, firstClickAt: null, clicks: 0, repliedAt: null },
    attribution: null,
    decision: d.decision,
    dispatchLease: dispatchLease(a.workerId),
    createdAt: new Date(a.now),
    sentAt: null,
    updatedAt: new Date(a.now),
    expireAt: retentionFrom(a.now),
    schemaVersion: SCHEMA_VERSION,
    ladderPos: d.ladderPos,
    kind: 'journey',
  };
  const live: LiveSend = {
    inst,
    nodeId: a.nodeId,
    sendKey,
    now: a.now,
    workerId: a.workerId,
    channel,
    purpose: d.cfg.purpose,
    adapter,
    doc,
    message,
    gateInput: d.gateInput,
    pointId: pointId ?? null,
    intendedAt: d.intendedAt,
    slot: d.slot,
    variantId: d.variantId,
    ladderPos: d.ladderPos,
    common: d.common,
    pendingEvents: [...(a.pendingEvents ?? [])],
  };

  // ── Phase 1: re-check and claim ──
  const claim = await claimSend(live);
  // The claim wrote this run's earlier events; the final commit must not write them again.
  if (claim.kind === 'ok') a.pendingEvents?.splice(0, live.pendingEvents.length);
  if (claim.kind === 'conflict') return { kind: 'conflict' };
  if (claim.kind === 'gate') {
    // Something changed since the first look (paused, a STOP, the weekly limit…).
    const g = claim.gate;
    const decision = d.decisionFor(g);
    if (g.verdict === 'defer' && g.until !== null) return deferred(g, decision, a, { intendedAt: d.intendedAt, slot: d.slot, sendKey, common: d.common, tz: d.tz });
    return skipWith(decision, a, sendKey, d.common, g.reason === 'switched_off', g.reason === 'stay_cancelled');
  }

  // ── Phase 2 + 3: the provider, then the record ──
  const result = await callProvider(adapter, message);
  const recorded = await recordResult(live, result, attempts);
  if (recorded.kind === 'sent') {
    return {
      kind: 'done',
      outcome: 'sent',
      touch: { channel, variantId: d.variantId, slot: d.slot, sendKey, purpose: d.cfg.purpose, at: a.now },
      ladderPos: d.ladderPos,
      revAfter: claim.revAfter,
      suppress: false,
      events: [],
    };
  }
  if (recorded.kind === 'failed') return { kind: 'done', outcome: 'skipped', touch: null, revAfter: claim.revAfter, suppress: false, events: [] };
  return {
    kind: 'later',
    at: a.now + recorded.delayMs,
    intendedAt: d.intendedAt,
    slot: d.slot,
    reason: 'provider_retry',
    creditsWaitStartedAt: inst.state.waiting?.creditsWaitStartedAt,
    dispatchAttempts: attempts + 1,
    revAfter: claim.revAfter,
    events: [],
  };
}

function skipOutcome(reason: string, at: number = Date.now()): SendOutcome {
  return { kind: 'done', outcome: 'skipped', touch: null, revAfter: null, suppress: false, events: [{ type: 'send.skipped', occurredAt: at, data: { reason } }] };
}

function skipWith(decision: DecisionRecord, a: SendArgs, sendKey: string, common?: Record<string, unknown>, suppress = false, stayCancelled = false): SendOutcome {
  return {
    kind: 'done',
    outcome: 'skipped',
    touch: null,
    revAfter: null,
    suppress,
    stayCancelled,
    events: [
      {
        ...(common ?? { tenantUserId: a.inst.meta.tenantUserId, venueId: a.inst.meta.venueId, contactId: a.inst.meta.contactId, instanceId: a.inst.id, journeyKey: a.inst.meta.journeyKey, mode: a.inst.meta.mode, nodeId: a.nodeId, sendKey }),
        type: decision.result === 'block' ? 'send.blocked' : 'send.skipped',
        occurredAt: a.now,
        data: { decision },
      } as EventInput,
    ],
  };
}

/** Test run: one transaction writes the `dry_run` record and bumps the instance, then the journey carries on. */
async function dryRun(p: {
  a: SendArgs;
  sendKey: string;
  channel: Channel;
  variantId: string;
  lang: Lang;
  slot: string;
  cfg: SendConfig;
  rendered: { subject?: string; text: string };
  decision: DecisionRecord;
  price: number;
  ladderPos: number;
  contact: ContactDoc;
  common: Record<string, unknown>;
}): Promise<SendOutcome> {
  const { a, sendKey } = p;
  const now = a.now;
  const address = p.channel === 'email' ? p.contact.email ?? '' : p.contact.phoneE164 ?? '';
  const preview = (p.rendered.subject ? `${p.rendered.subject} — ` : '') + p.rendered.text;
  const doc: JourneySendDoc = {
    tenantUserId: a.inst.meta.tenantUserId,
    venueId: a.inst.meta.venueId,
    contactId: a.inst.meta.contactId,
    instanceId: a.inst.id,
    journeyKey: a.inst.meta.journeyKey,
    nodeId: a.nodeId,
    templateVersion: a.inst.meta.templateVersion,
    configVersion: a.inst.meta.configVersion,
    mode: 'test',
    purpose: p.cfg.purpose,
    channel: p.channel,
    ladderPos: p.ladderPos,
    toPointId: p.channel === 'email' ? p.contact.emailPointId : p.contact.phonePointId,
    toMasked: address ? maskDestination(p.channel === 'email' ? 'email' : 'sms', address) : '',
    variantId: p.variantId,
    locale: p.lang,
    slot: p.slot,
    status: 'dry_run',
    provider: null,
    providerMessageId: null,
    errorCode: null,
    errorMessage: null,
    credits: p.cfg.purpose === 'marketing' ? { amount: p.price, ledgerId: null } : null,
    providerCostMinor: null,
    smsSegments: null,
    shortCodes: [],
    content: { ...(p.rendered.subject ? { subject: p.rendered.subject } : {}), preview: preview.slice(0, 280), bodyHash: sha256Hex(p.rendered.text).slice(0, 32) },
    engagement: { deliveredAt: null, openedAt: null, firstClickAt: null, clicks: 0, repliedAt: null },
    attribution: null,
    decision: p.decision,
    dispatchLease: null,
    createdAt: new Date(now),
    sentAt: null,
    updatedAt: new Date(now),
    expireAt: retentionFrom(now),
    schemaVersion: SCHEMA_VERSION,
  };

  const readRev = a.inst.state.rev;
  const ok = await db.runTransaction(async (tx) => {
    const ref = instanceRef(a.inst.id);
    const [snap, sendSnap] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.journeySends).doc(sendKey))]);
    if (!snap.exists || Number(snap.get('rev')) !== readRev || snap.get('status') !== 'active') return false;
    if (sendSnap.exists) return false;
    tx.create(db.collection(COL.journeySends).doc(sendKey), doc);
    tx.update(ref, { rev: readRev + 1, updatedAt: new Date(now) });
    tx.set(eventRef(), eventDoc({ ...(p.common as any), type: 'send.dry_run', occurredAt: now, data: { decision: p.decision } }));
    return true;
  });
  if (!ok) return { kind: 'conflict' };
  return {
    kind: 'done',
    outcome: 'sent',
    touch: { channel: p.channel, variantId: p.variantId, slot: p.slot, sendKey, purpose: p.cfg.purpose, at: now },
    ladderPos: p.ladderPos,
    revAfter: readRev + 1,
    suppress: false,
    events: [],
  };
}
