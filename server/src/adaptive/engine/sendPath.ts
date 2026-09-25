/**
 * One send step, end to end (04-engine-runtime §4–§6):
 *
 *   resume if a send record already exists (a retried task never sends twice)
 *   → time (now, or a slot later in the venue's day)
 *   → facts (contact, consent, blocks, caps, weekly touches, counts, credits)
 *   → channel → wording → render → the 10-rule gate → the "why" record
 *   → test run: write a `dry_run` send record and carry on as if sent
 *     live:     (PR B) phase 1 transaction → provider → record
 *
 * PR A has no provider adapters at all: a live account is stopped by rule 1
 * ("sending isn't set up"), so nothing can leave the building.
 */

import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactDoc, ContactPointDoc, ContactVenueDoc, JourneySendDoc, NetworkPersonDoc } from '../store/engineTypes';
import type { AdaptiveConfig, JourneyDefinition } from '../core/schemas';
import type { Channel, Lang } from '../core/constants';
import { getNodeContract } from '../core/registry';
import { sendKeyFor } from '../core/runtime/ids';
import { checkChannel, pickChannel, pickTime, pickVariant, type ChannelCheck, type ChannelFacts, type ChannelRule } from '../core/runtime/pickers';
import { checkSystem, runGate, type GateInput } from '../core/runtime/gate';
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
import { getCreditConfig, creditsForMessage, getWalletSnapshot } from '../../services/credits';
import { spendableForChannel } from '../../services/creditBuckets';
import { getEntitlements } from '../../services/entitlements';
import { ensureSmsOptOutSuffix } from '../../services/smsBilling';
import { maskDestination } from '../../services/phone';
import { journeyStillOn, loadContact, loadGuestInfo, type PinnedConfig, type VenueContext } from './context';
import { DRY_RUN_LINKS, missingReason, renderMessage, renderValues, variantContent } from './renderSend';
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
      events: EventInput[];
    }
  | { kind: 'later'; at: number; intendedAt: number; slot: string; reason: string; creditsWaitStartedAt?: number; events: EventInput[] }
  /** Another worker is in the middle of this send: look again shortly. */
  | { kind: 'busy'; retryAt: number }
  /** The instance moved on while we looked (rev changed): the caller re-reads. */
  | { kind: 'conflict' };

/** Adapters register here in PR B. PR A registers none, so live sends are blocked by rule 1. */
export const channelAdapters: Partial<Record<Channel, { ready(): boolean }>> = {};

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
}

export async function runSend(a: SendArgs): Promise<SendOutcome> {
  const { inst, nodeId, now } = a;
  const node = a.definition.nodes[nodeId];
  const parsed = getNodeContract('send')!.configSchema.safeParse(node?.config ?? {});
  if (!parsed.success) return skipOutcome('bad_step_config');
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
      await existing.ref.update({ status: 'unknown', updatedAt: new Date() });
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
  if (!contact || contact.status !== 'active') return skipOutcome('contact_gone');

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

  const variants = cat.variants.filter((v) => v.poolKey === cfg.pool && v.status === 'active');
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
  const onState = journeyStillOn(a.ctx, inst.meta.installId, inst.meta.journeyKey);
  const installLive = Boolean(a.ctx && (a.ctx.marketing?.installId === inst.meta.installId || a.ctx.utility?.installId === inst.meta.installId));
  const system: GateInput['system'] = {
    paused: a.settings.paused,
    lapsed,
    tenantActive: tenantSnap.get('active') !== false,
    venueOn: installLive,
    journeyOn: onState.on,
    offSinceAt: onState.offSinceAt,
    staleAfterMs: a.settings.safety.staleAfterHours * HOUR_MS,
    venueSendsToday: venueToday,
    venueCeiling: a.settings.safety.maxSendsPerVenuePerDay,
    platformSendsToday: platformToday,
    platformCeiling: a.settings.safety.maxSendsPlatformPerDay,
    channelReady: true,
  };

  const versions = { template: inst.meta.templateVersion, config: inst.meta.configVersion, playbook: inst.meta.playbookKey, engine: ENGINE_VERSION };
  const slotRecord = { picked: slot, rule: slotRule, plannedAt: intendedAt };
  const pre = checkSystem({ now, mode, purpose: cfg.purpose, channel: 'email', intendedAt, system } as GateInput);
  if (pre.verdict !== 'allow') {
    const gate = { verdict: pre.verdict, rule: 'system' as const, reason: pre.reason ?? null, until: pre.until ?? null, checks: [pre] };
    const decision = buildDecision({ now, mode, poolKey: cfg.pool, purpose: cfg.purpose, gate, channelChecks: [], channel: { picked: null, rule: 'not reached' }, variant: { picked: null, method: 'none' }, slot: slotRecord, credits: null, versions });
    if (pre.verdict === 'defer' && pre.until !== undefined) {
      const firstOfReason = inst.state.waiting?.lastDeferReason !== pre.reason;
      return {
        kind: 'later',
        at: pre.until,
        intendedAt,
        slot,
        reason: pre.reason ?? 'defer',
        events: firstOfReason ? [{ tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, contactId: inst.meta.contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, nodeId, sendKey, type: 'send.deferred', occurredAt: now, data: { decision, until: pre.until } }] : [],
      };
    }
    return skipWith(decision, a, sendKey, undefined, pre.reason === 'switched_off');
  }

  // ── 4. Channel ──
  const ladder = a.definition.channelLadder;
  const allChannels = Array.from(new Set<Channel>([...ladder, 'email', 'sms', 'whatsapp']));
  const checks: ChannelCheck[] = allChannels.map((c) => checkChannel(cfg.purpose, channelFacts(c)));
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
    const decision = buildDecision({ ...baseDecision, gate: null, variant: { picked: null, method: 'none' }, credits: null });
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
  const links = { ...DRY_RUN_LINKS };
  if (!guestInfo?.locales?.[lang]?.directBookingUrl && !guestInfo?.locales?.en?.directBookingUrl) delete (links as any).booking;
  const values = renderValues({
    lang: vc.locale,
    tz,
    contact,
    venueName: a.ctx?.venueName ?? '',
    vars: inst.state.vars,
    slots: a.pinned.slots,
    offers: a.pinned.offers,
    guestInfo,
    links,
  });
  const rendered = renderMessage(vc.content, channel, values);
  const smsText = channel === 'sms' ? ensureSmsOptOutSuffix(rendered.text) : undefined;

  // ── 6. Price + the full gate ──
  const creditConfig = await getCreditConfig();
  const price = cfg.purpose === 'marketing' ? creditsForMessage(creditConfig, channel, smsText) : 0;
  const spendable = wallet ? spendableForChannel(wallet.channelBalances, channel) : null;
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
  const decision = buildDecision({
    ...baseDecision,
    gate,
    variant: { picked: variant.id, method: `${vpick.method}${vc.fallback ? ':en_fallback' : ''}` },
    credits: cfg.purpose === 'marketing' ? { price, balance: spendable } : null,
  });

  const common = { tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, contactId: inst.meta.contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, nodeId, sendKey, channel, variantId: variant.id, slot };

  // ── 5. Outcome ──
  if (gate.verdict === 'defer' && gate.until !== null) {
    const keepsIntended = gate.reason === 'paused' || gate.reason === 'lapse_unknown';
    const firstOfReason = inst.state.waiting?.lastDeferReason !== gate.reason;
    return {
      kind: 'later',
      at: gate.until,
      intendedAt: keepsIntended ? intendedAt : gate.until,
      slot,
      reason: gate.reason ?? 'defer',
      creditsWaitStartedAt: gate.reason === 'credits' ? inst.state.waiting?.creditsWaitStartedAt ?? now : undefined,
      events: firstOfReason ? [{ ...common, type: 'send.deferred', occurredAt: now, data: { decision, until: gate.until } }] : [],
    };
  }

  if (gate.verdict === 'allow' && mode === 'test') {
    return dryRun({ a, sendKey, channel, variantId: variant.id, lang: vc.locale, slot, cfg, rendered, decision, price, ladderPos: pick.ladderPos, contact, common });
  }

  if (gate.verdict === 'allow') {
    // Live dispatch arrives with the adapters in PR B; until then rule 1 blocks it.
    return skipWith({ ...decision, result: 'block', rule: 'system', reason: 'channel_not_ready' }, a, sendKey, common);
  }

  return skipWith(decision, a, sendKey, common, gate.reason === 'switched_off');
}

function skipOutcome(reason: string): SendOutcome {
  return { kind: 'done', outcome: 'skipped', touch: null, revAfter: null, suppress: false, events: [{ type: 'send.skipped', occurredAt: Date.now(), data: { reason } }] };
}

function skipWith(decision: DecisionRecord, a: SendArgs, sendKey: string, common?: Record<string, unknown>, suppress = false): SendOutcome {
  return {
    kind: 'done',
    outcome: 'skipped',
    touch: null,
    revAfter: null,
    suppress,
    events: [
      {
        ...(common ?? { tenantUserId: a.inst.meta.tenantUserId, venueId: a.inst.meta.venueId, contactId: a.inst.meta.contactId, instanceId: a.inst.id, journeyKey: a.inst.meta.journeyKey, nodeId: a.nodeId, sendKey }),
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
