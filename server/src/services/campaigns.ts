/**
 * Tenant Campaign Manager — broadcast sending engine.
 *
 * The CMS authors campaigns (Firestore `CaptivePortal_Campaigns`) and authorizes
 * requests, then calls the internal `/internal/campaigns/*` endpoints. This
 * module is the executor: it materializes the audience from `CaptivePortal_Users`
 * (re-enforcing consent), dispatches each message through the existing channel
 * services, writes a per-recipient `CaptivePortal_CampaignSends` record, and
 * keeps the campaign's status + stats up to date.
 *
 * Scheduling lives here (see jobs/campaignScheduler.ts) — the CMS owns no cron.
 *
 * Phase 3 scope: broadcast send (send-now + scheduled) + pause/resume/cancel.
 * Open/click/bounce tracking (delivery webhooks → CampaignSends) is Phase 4 —
 * provider ids are stored under the SAME field names the existing Twilio/WhatsApp
 * webhooks already match (messageSid / wamid) so that wiring is a small addition.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { sendEmail } from './brevo';
import { scheduleSms, toE164 } from './twilio';
import { sendWhatsAppTemplate, WhatsAppTemplateComponent } from './whatsapp';
import {
  getEntitlements,
  isLapsedForSending,
  quotasEnforced,
  type Channel as MessagingChannel,
} from './entitlements';
import { recordSends } from './usage';
import {
  creditsEnforcementMode,
  getCreditConfig,
  creditsForMessage,
  providerCostForMessage,
  smsSegments,
  reserveCredits,
  reserveInTransaction,
  releaseReservation,
  settleCampaignRun,
  getWalletSnapshot,
  maybeNotifyLowBalance,
  debitOne,
  InsufficientCreditsError,
  normalizeReservation,
  allocateReservation,
  availableTotal,
  spendableForChannel,
  type ChannelShortfall,
  type CreditConfig,
  type NormalizedReservation,
  type SettleBreakdown,
} from './credits';
import { injectPoweredBy } from './poweredBy';
import { injectOpenPixel } from './openPixel';
import { interpolate } from './mergeTags';
import { getVenueName } from './venue';
import {
  VISITOR_BASE_URL,
  createShortLink,
  swapVenueRatingUrl,
  swapTrackedLinks,
} from './shortlinks';
import { buildUnsubscribeUrl } from './unsubscribe';
import {
  matchesLanguageFilter,
  normalizeLanguage,
  resolveVariant,
  UNKNOWN_LANGUAGE,
} from './guestLanguage';
import { ensureSmsOptOutSuffix, smsBillingText, smsSegmentsFor } from './smsBilling';

const CAMPAIGNS = 'CaptivePortal_Campaigns';
const CAMPAIGN_SENDS = 'CaptivePortal_CampaignSends';
const USERS = 'CaptivePortal_Users';
const VENUES = 'CaptivePortal_Venues';
const ACCESS_POINTS = 'CaptivePortal_AccessPoints';

const FIRESTORE_IN_LIMIT = 30;
/** Safety cap on a single broadcast's audience (guards runaway tenant sends). */
const MAX_AUDIENCE = 10000;
/** How many recipients to dispatch concurrently. */
const DISPATCH_CONCURRENCY = 8;
type Channel = 'email' | 'sms' | 'whatsapp';

/** Iteration order must match CREDIT_CHANNELS — see services/creditBuckets.ts. */
const CAMPAIGN_CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
/** Tenant-facing nouns for credit warnings. */
const CHANNEL_NOUNS: Record<Channel, string> = { email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };

interface CampaignMessage {
  id: string;
  channel: Channel;
  delayMinutes: number;
  subject?: string;
  body?: string;
  content?: string;
  templateName?: string;
  languageCode?: string;
  builtInTemplateId?: string;
  /**
   * Per-language overrides of this message's own content fields, keyed by
   * language code. The base fields above ARE the campaign's default-language
   * copy, so a guest whose language has no variant simply gets them — that is
   * the spec's "fall back to the default language" with no lookup required.
   *
   * Structural fields (id, channel, delayMinutes) are never present in a
   * variant; the CMS validator rejects them, so one message stays one message
   * across every language and its metrics stay attributable.
   */
  translations?: Record<string, Partial<Pick<CampaignMessage,
    'subject' | 'body' | 'content' | 'templateName' | 'languageCode'>>>;
}

interface CampaignSegment {
  venueIds?: string[];
  entityType?: string;
  signedUpAfter?: string;
  signedUpBefore?: string;
  /**
   * Optional language targeting: a supported code, or 'unknown' for guests
   * captured before the venue offered a language choice. Absent means every
   * language — adding this field must never shrink an existing campaign's
   * audience.
   */
  language?: string;
}

interface CampaignTrigger {
  kind?: 'wifiEvent' | 'dateRelative';
  wifiEvent?: 'onConnect' | 'onReconnect' | 'onDisconnect';
}

/**
 * Wallet hold made at claim time; cleared by settle (spec §5.3).
 *
 * `reserved` keeps its original name and meaning (the Σ across channels)
 * because the sweeper query, the log lines and any older deploy still read it —
 * keeping it is what makes a rollback degrade gracefully instead of breaking.
 * `reservedAt` must stay at exactly this path: sweepStaleReservations queries
 * `creditReservation.reservedAt`.
 *
 * `perChannel` absent ⇒ a pre-per-channel scalar reservation, released from
 * `shared` (see NormalizedReservation in services/credits.ts).
 */
interface CreditReservation {
  runId: string;
  reserved: number;
  rateCardVersion: number;
  reservedAt: string;
  perChannel?: Record<Channel, { own: number; shared: number }>;
}

interface CampaignDoc {
  id: string;
  tenantUserId: string;
  type: 'broadcast' | 'automation';
  status: string;
  channels: Channel[];
  segment?: CampaignSegment;
  messages?: CampaignMessage[];
  schedule?: { mode?: 'now' | 'scheduled'; sendAt?: string };
  trigger?: CampaignTrigger;
  creditReservation?: CreditReservation | null;
  heldCount?: number;
}

interface AudienceMember {
  guestId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneCountryCode: string;
  accessPointId: string | null;
  venueId: string | null;
  /** Splash language the guest chose; null when never recorded. */
  language: string | null;
  /** Channel-specific suppressions captured at materialization time. */
  optOuts?: { email?: boolean; sms?: boolean; whatsapp?: boolean };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Base marketing consent = active + explicitly opted in + not withdrawn. */
function hasMarketingConsent(u: any): boolean {
  if (u.status === 'archived') return false;
  if (u.marketingConsent && u.marketingConsent.given === false) return false;
  return u.marketingOptIn === true || (u.marketingConsent && u.marketingConsent.given === true);
}

/**
 * Channel-aware opt-in. Suppressions are independent per channel: an email
 * unsubscribe (`unsubscribed`, via /u/:token) doesn't block SMS, and an SMS
 * STOP (`smsOptOut`, via the Twilio inbound webhook) doesn't block email.
 */
export function isOptedInFor(u: any, channel: 'email' | 'sms' | 'whatsapp'): boolean {
  if (!hasMarketingConsent(u)) return false;
  if (channel === 'email' && u.unsubscribed === true) return false;
  if (channel === 'sms' && u.smsOptOut === true) return false;
  if (channel === 'whatsapp' && u.whatsappOptOut === true) return false;
  return true;
}

// CTIA opt-out suffix + segment maths live in services/smsBilling.ts, so the
// text a send is PRICED on and the text it is SENT with come from one place.

/**
 * Resolve the tenant's access points + an apId→venueId map. Union of APs owned
 * via tenantUserId AND APs belonging to the tenant's venues (catches APs lacking
 * tenantUserId), mirroring the CMS analytics/audience-preview logic.
 */
async function resolveTenantApVenueMap(tenantUserId: string): Promise<Map<string, string | null>> {
  const apVenue = new Map<string, string | null>();

  const venueSnap = await db.collection(VENUES).where('tenantUserId', '==', tenantUserId).get();
  const venueIds: string[] = [];
  venueSnap.forEach((d) => venueIds.push(d.id));

  const ownedSnap = await db.collection(ACCESS_POINTS).where('tenantUserId', '==', tenantUserId).get();
  ownedSnap.forEach((d) => apVenue.set(d.id, (d.data().venueId as string) || null));

  if (venueIds.length > 0) {
    await Promise.all(
      chunk(venueIds, FIRESTORE_IN_LIMIT).map(async (ids) => {
        const snap = await db.collection(ACCESS_POINTS).where('venueId', 'in', ids).get();
        snap.forEach((d) => apVenue.set(d.id, (d.data().venueId as string) || null));
      }),
    );
  }

  return apVenue;
}

/**
 * Materialize a campaign's audience: opted-in, non-archived guests across the
 * tenant's access points, restricted by the segment. Consent is re-enforced here
 * so a guest who opted out AFTER authoring is never messaged.
 */
export async function materializeAudience(campaign: CampaignDoc): Promise<AudienceMember[]> {
  const apVenue = await resolveTenantApVenueMap(campaign.tenantUserId);

  const segment = campaign.segment || {};
  let apIds = Array.from(apVenue.keys());
  if (segment.venueIds && segment.venueIds.length > 0) {
    const wanted = new Set(segment.venueIds);
    apIds = apIds.filter((apId) => wanted.has(String(apVenue.get(apId))));
  }
  if (apIds.length === 0) return [];

  const after = segment.signedUpAfter ? new Date(segment.signedUpAfter).getTime() : null;
  const before = segment.signedUpBefore ? new Date(segment.signedUpBefore).getTime() : null;
  const wantEntityType = segment.entityType || null;
  const wantLanguage = segment.language || null;

  const out: AudienceMember[] = [];
  const seen = new Set<string>();

  await Promise.all(
    chunk(apIds, FIRESTORE_IN_LIMIT).map(async (ids) => {
      const snap = await db.collection(USERS).where('captivePortalAccessPointId', 'in', ids).get();
      snap.forEach((doc) => {
        if (out.length >= MAX_AUDIENCE) return;
        const u = doc.data();
        if (seen.has(doc.id)) return;
        // Base consent gates audience membership; channel-specific opt-outs
        // (email unsubscribe / SMS STOP / WhatsApp STOP) suppress per message
        // in dispatchOne via the optOuts flags captured below.
        if (!hasMarketingConsent(u)) return;
        if (wantEntityType && u.entityType !== wantEntityType) return;
        if (wantLanguage && !matchesLanguageFilter(u.language, wantLanguage)) return;
        if (after !== null || before !== null) {
          const raw = u.createdAt || u.timestamp;
          const t = raw ? new Date(raw?.toDate ? raw.toDate() : raw).getTime() : NaN;
          if (Number.isNaN(t)) return;
          if (after !== null && t < after) return;
          if (before !== null && t > before) return;
        }
        seen.add(doc.id);
        out.push({
          guestId: doc.id,
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          email: typeof u.email === 'string' && u.email.includes('@') ? u.email : null,
          phone: typeof u.phone === 'string' && u.phone.trim() ? u.phone : null,
          phoneCountryCode: u.phoneCountryCode || '',
          accessPointId: u.captivePortalAccessPointId || null,
          venueId: apVenue.get(u.captivePortalAccessPointId) ?? null,
          language: normalizeLanguage(u.language),
          optOuts: {
            email: u.unsubscribed === true,
            sms: u.smsOptOut === true,
            whatsapp: u.whatsappOptOut === true,
          },
        });
      });
    }),
  );

  // Hard cap: the per-iteration check above is best-effort across concurrent
  // chunk queries, so enforce the ceiling once collection completes.
  return out.length > MAX_AUDIENCE ? out.slice(0, MAX_AUDIENCE) : out;
}

// ── Credit costing (spec §5.3) ───────────────────────────────────────────────

/**
 * Credits one (message × recipient) unit consumes.
 *
 * SMS is costed on the RECIPIENT'S language variant plus the CTIA opt-out
 * suffix — `smsBillingText` — not on the base body. `dispatchOne` resolves the
 * variant before sending, and a German or Italian translation routinely pushes
 * a 1-segment English SMS to 2; pricing the base body under-charged every
 * multi-language SMS campaign. Estimate, reservation, in-run counter and settle
 * all go through here, so reserve and debit cannot disagree.
 */
function unitCredits(config: CreditConfig, msg: CampaignMessage, language: unknown): number {
  if (msg.channel === 'sms') {
    return creditsForMessage(config, 'sms', smsBillingText(msg, language));
  }
  return creditsForMessage(config, msg.channel);
}

function unitProviderCost(config: CreditConfig, msg: CampaignMessage, language: unknown): number {
  if (msg.channel === 'sms') {
    return providerCostForMessage(config, 'sms', smsBillingText(msg, language));
  }
  return providerCostForMessage(config, msg.channel);
}

function unitSegments(msg: CampaignMessage, language: unknown): number | null {
  if (msg.channel !== 'sms') return null;
  return smsSegmentsFor(msg, language);
}

/**
 * Memoized pricing for a run.
 *
 * A campaign has a handful of messages and a handful of languages, but an
 * audience has thousands of guests — so resolve and price each
 * (message × language) pair once rather than per recipient. Without this the
 * language fix would add an object allocation and a full string scan for every
 * unit of a 10k-guest send.
 */
function createUnitPricer(config: CreditConfig) {
  const credits = new Map<string, number>();
  const providerCost = new Map<string, number>();
  const segments = new Map<string, number | null>();
  // Only SMS pricing varies by language, so everything else collapses to one key.
  const keyOf = (msg: CampaignMessage, language: unknown) =>
    msg.channel === 'sms' ? `${msg.id}|${normalizeLanguage(language) ?? ''}` : msg.id;

  const memo = <T>(cache: Map<string, T>, key: string, compute: () => T): T => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = compute();
    cache.set(key, value);
    return value;
  };

  return {
    credits: (msg: CampaignMessage, language: unknown) =>
      memo(credits, keyOf(msg, language), () => unitCredits(config, msg, language)),
    providerCost: (msg: CampaignMessage, language: unknown) =>
      memo(providerCost, keyOf(msg, language), () => unitProviderCost(config, msg, language)),
    segments: (msg: CampaignMessage, language: unknown) =>
      memo(segments, keyOf(msg, language), () => unitSegments(msg, language)),
  };
}

type UnitPricer = ReturnType<typeof createUnitPricer>;

/** Can this member possibly receive this message? Mirrors dispatchOne's gates. */
function memberEligible(msg: CampaignMessage, member: AudienceMember): boolean {
  if (member.optOuts?.[msg.channel] === true) return false;
  if (msg.channel === 'email') return Boolean(member.email);
  return Boolean(member.phone);
}

function newRunId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

interface CampaignEstimate {
  audienceCount: number;
  unitsPerChannel: Record<Channel, number>;
  creditsPerChannel: Record<Channel, number>;
  smsSegmentsPerMessage: number | null;
  creditsNeeded: number;
  config: CreditConfig;
}

/** Audience × message credit estimate — the number reserve() will hold. */
async function estimateCampaign(campaign: CampaignDoc): Promise<CampaignEstimate> {
  const config = await getCreditConfig();
  const audience = await materializeAudience(campaign);
  const messages = (campaign.messages || []).filter((m) => campaign.channels.includes(m.channel));

  const unitsPerChannel: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
  const creditsPerChannel: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
  let creditsNeeded = 0;
  let smsSegs: number | null = null;

  // Priced PER RECIPIENT, because an SMS costs what the guest's language
  // variant costs — pricing the base body once per message under-reserves every
  // multi-language SMS campaign, which then holds units the tenant paid for.
  // The pricer memoizes each (message × language) pair, so this stays one
  // computation per pair rather than per guest.
  const pricer = createUnitPricer(config);

  for (const msg of messages) {
    for (const member of audience) {
      if (!memberEligible(msg, member)) continue;
      const cost = pricer.credits(msg, member.language);
      unitsPerChannel[msg.channel] += 1;
      creditsPerChannel[msg.channel] += cost;
      creditsNeeded += cost;
      if (msg.channel === 'sms') {
        // Report the WORST case across the audience: the Review step shows this
        // as "SMS message uses N segments", and quoting the shortest variant
        // would understate what the tenant is about to spend.
        const segs = pricer.segments(msg, member.language);
        if (segs !== null && (smsSegs === null || segs > smsSegs)) smsSegs = segs;
      }
    }
  }

  return {
    audienceCount: audience.length,
    unitsPerChannel,
    creditsPerChannel,
    smsSegmentsPerMessage: smsSegs,
    creditsNeeded,
    config,
  };
}

/** Run an array of async thunks with bounded concurrency. */
async function pMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

interface DispatchOutcome {
  ok: boolean;
  status: 'sent' | 'scheduled' | 'failed';
  providerField?: 'messageSid' | 'messageId' | 'wamid';
  providerId?: string | null;
  reason?: string;
  shortCodes?: string[];
  rendered?: { subject?: string; body?: string; content?: string };
}

/** Dispatch one message to one guest through the right channel service. */
async function dispatchOne(
  campaign: CampaignDoc,
  baseMsg: CampaignMessage,
  member: AudienceMember,
  venueNameCache: Map<string, string>,
  sendId: string,
): Promise<DispatchOutcome> {
  // Resolve the guest's language variant once, here, so every branch below
  // reads translated content without knowing languages exist. Falls through to
  // the base message when the guest has no language or the campaign has no
  // variant for it.
  const msg = resolveVariant(baseMsg, member.language);
  const venueId = member.venueId || '';
  let venueName = venueNameCache.get(venueId) || '';
  if (!venueName && venueId) {
    venueName = await getVenueName(venueId);
    venueNameCache.set(venueId, venueName);
  }

  const ctx: Record<string, string> = {
    firstName: member.firstName,
    lastName: member.lastName,
    venueName,
    ratingUrl: venueId ? `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate` : '',
    // Signed, per-recipient unsubscribe link. Fills the {{unsubscribeUrl}} token
    // the CMS guarantees in every marketing body, and feeds the List-Unsubscribe
    // header below. Empty string when the feature is unconfigured.
    unsubscribeUrl: buildUnsubscribeUrl({
      g: member.guestId,
      v: venueId || undefined,
      c: campaign.id,
    }),
  };
  const linkCtx = {
    venueId,
    marketingDocId: `campaign_${campaign.id}`,
    wifiGuestId: member.guestId,
    channel: msg.channel,
  };

  const scheduledForSend = msg.delayMinutes > 0;

  // Channel-scoped suppression: an email unsubscribe doesn't block SMS and
  // vice versa; each message honors its own channel's opt-out flag.
  if (member.optOuts?.[msg.channel] === true) {
    return { ok: false, status: 'failed', reason: 'opted_out_channel' };
  }

  if (msg.channel === 'email') {
    if (!member.email) return { ok: false, status: 'failed', reason: 'no_email' };
    const subject = interpolate(String(msg.subject ?? ''), ctx);
    let body = interpolate(String(msg.body ?? ''), ctx);
    const rateSwap = await swapVenueRatingUrl(body, linkCtx);
    body = rateSwap.content;
    const trackedSwap = await swapTrackedLinks(body, linkCtx);
    body = trackedSwap.content;
    body = injectOpenPixel(body, sendId);
    // "Powered by HeidiFi" footer — removable per plan (hidePoweredBy flag).
    try {
      const entitlements = await getEntitlements(campaign.tenantUserId);
      if (!entitlements.flags.hidePoweredBy) body = injectPoweredBy(body);
    } catch {
      body = injectPoweredBy(body); // fail-open to branded
    }
    const id = await sendEmail(
      member.email,
      subject || '(no subject)',
      body,
      msg.delayMinutes,
      ctx.unsubscribeUrl || undefined,
    );
    if (!id) return { ok: false, status: 'failed', reason: 'email_not_configured' };
    return {
      ok: true,
      status: scheduledForSend ? 'scheduled' : 'sent',
      providerField: 'messageId',
      providerId: id,
      shortCodes: [...(rateSwap.code ? [rateSwap.code] : []), ...trackedSwap.codes],
      rendered: { subject, body },
    };
  }

  if (msg.channel === 'sms') {
    if (!member.phone) return { ok: false, status: 'failed', reason: 'no_phone' };
    const to = toE164(member.phoneCountryCode, member.phone);
    if (!to) return { ok: false, status: 'failed', reason: 'invalid_phone' };
    let content = interpolate(String(msg.content ?? ''), ctx);
    const rateSwap = await swapVenueRatingUrl(content, linkCtx);
    content = rateSwap.content;
    const trackedSwap = await swapTrackedLinks(content, linkCtx);
    content = trackedSwap.content;
    content = ensureSmsOptOutSuffix(content);
    const id = await scheduleSms(to, content, msg.delayMinutes);
    if (!id) return { ok: false, status: 'failed', reason: 'sms_not_configured' };
    return {
      ok: true,
      status: scheduledForSend ? 'scheduled' : 'sent',
      providerField: 'messageSid',
      providerId: id,
      shortCodes: [...(rateSwap.code ? [rateSwap.code] : []), ...trackedSwap.codes],
      rendered: { content },
    };
  }

  // whatsapp — uses the guest's approved Meta template. Body params mirror the
  // live entity-marketing dispatch: [firstName, venueName] + optional rating button.
  if (!member.phone) return { ok: false, status: 'failed', reason: 'no_phone' };
  const to = toE164(member.phoneCountryCode, member.phone);
  if (!to) return { ok: false, status: 'failed', reason: 'invalid_phone' };
  const templateName = String(msg.templateName ?? '').trim();
  const languageCode = String(msg.languageCode ?? '').trim() || 'en_US';
  if (!templateName) return { ok: false, status: 'failed', reason: 'missing_template' };

  const components: WhatsAppTemplateComponent[] = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: member.firstName || 'Guest' },
        { type: 'text', text: venueName || 'our venue' },
      ],
    },
  ];
  const codes: string[] = [];
  if (venueId) {
    const code = await createShortLink({
      targetType: 'venue-rate',
      targetUrl: `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`,
      ...linkCtx,
    });
    codes.push(code);
    components.push({
      type: 'button',
      sub_type: 'url',
      index: 0,
      parameters: [{ type: 'text', text: `s/${code}` }],
    });
  }
  const id = await sendWhatsAppTemplate(to, { templateName, languageCode, components });
  if (!id) return { ok: false, status: 'failed', reason: 'whatsapp_not_configured' };
  // WhatsApp has no native scheduling; an id means it was accepted now.
  return { ok: true, status: 'sent', providerField: 'wamid', providerId: id, shortCodes: codes };
}

/**
 * Dispatch one message to one guest AND persist its send record. Shared by the
 * broadcast executor and the automation listener. Pre-generates the send id so
 * the email open-pixel can reference it.
 */
async function recordAndDispatch(
  campaign: CampaignDoc,
  msg: CampaignMessage,
  messageIndex: number,
  member: AudienceMember,
  venueNameCache: Map<string, string>,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; sendId: string }> {
  const sendRef = db.collection(CAMPAIGN_SENDS).doc();
  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchOne(campaign, msg, member, venueNameCache, sendRef.id);
  } catch (err) {
    outcome = { ok: false, status: 'failed', reason: err instanceof Error ? err.message : 'dispatch_error' };
  }

  const record: Record<string, unknown> = {
    campaignId: campaign.id,
    tenantUserId: campaign.tenantUserId,
    wifiGuestId: member.guestId,
    channel: msg.channel,
    messageIndex,
    templateMessageId: msg.id || null,
    to: msg.channel === 'email' ? member.email : member.phone,
    accessPointId: member.accessPointId,
    venueId: member.venueId,
    deliveryStatus: outcome.status,
    delayMinutes: msg.delayMinutes,
    scheduledFor: new Date(Date.now() + msg.delayMinutes * 60 * 1000).toISOString(),
    scheduledAt: FieldValue.serverTimestamp(),
    statusUpdatedAt: FieldValue.serverTimestamp(),
    ...extra,
  };
  if (outcome.providerField && outcome.providerId) record[outcome.providerField] = outcome.providerId;
  if (outcome.reason) record.failureReason = outcome.reason;
  if (outcome.shortCodes && outcome.shortCodes.length) record.shortCodes = outcome.shortCodes;
  if (outcome.rendered?.subject !== undefined) record.subject = outcome.rendered.subject;
  if (outcome.rendered?.body !== undefined) record.body = outcome.rendered.body;
  if (outcome.rendered?.content !== undefined) record.content = outcome.rendered.content;

  await sendRef.set(record);
  return { ok: outcome.ok, sendId: sendRef.id };
}

/**
 * Core executor: dispatch every (guest × message) for a campaign, write send
 * records, and roll up stats. Sets status sending → sent. Safe to call once a
 * campaign has been transitioned into "sending".
 */
async function dispatchCampaign(campaign: CampaignDoc): Promise<{ sent: number; failed: number }> {
  const ref = db.collection(CAMPAIGNS).doc(campaign.id);
  const audience = await materializeAudience(campaign);
  const messages = (campaign.messages || []).filter((m) => campaign.channels.includes(m.channel));

  await ref.update({
    audienceCount: audience.length,
    audienceSnapshotAt: FieldValue.serverTimestamp(),
  });

  const venueNameCache = new Map<string, string>();
  let sent = 0;
  let failed = 0;
  let skippedQuota = 0;
  let heldCredits = 0;

  // Quota accounting for this run. `remaining` snapshots plan+credits before
  // the run; per-channel counters track this run's accepted sends. Hard
  // enforcement (ENFORCE_QUOTAS=true) stops a channel at its limit and marks
  // the rest skipped_quota; soft mode only records a quotaWarning.
  const entitlements = await getEntitlements(campaign.tenantUserId).catch(() => null);
  const enforce = quotasEnforced() && entitlements !== null;
  const sentPerChannel: Record<MessagingChannel, number> = { email: 0, sms: 0, whatsapp: 0 };

  const channelBlocked = (channel: MessagingChannel): boolean => {
    if (!enforce || !entitlements) return false;
    const remaining = entitlements.remaining[channel];
    return remaining !== null && sentPerChannel[channel] >= remaining;
  };

  // Credit accounting (spec §5.3.3): the reservation made at claim time is the
  // budget; an in-run counter checked before each dispatch replaces per-send
  // wallet writes (which would serialize on one doc at 10k-unit audiences).
  // In 'warn' mode nothing was reserved — the counter still runs so the
  // would-be outcome is logged, but no unit is ever held.
  const creditMode = creditsEnforcementMode();
  const creditConfig = creditMode !== 'off' ? await getCreditConfig().catch(() => null) : null;
  const reservation =
    creditMode === 'enforce' ? normalizeReservation(campaign.creditReservation ?? null) : null;
  const warnWallet =
    creditMode === 'warn' && creditConfig
      ? await getWalletSnapshot(campaign.tenantUserId).catch(() => null)
      : null;

  // Per-channel budget vs per-channel counter. Credits are earmarked, so one
  // channel running out must not stop the others — and must not be able to
  // spend their reservation either.
  //
  // The check-and-claim below stays safe under pMap concurrency for the same
  // reason the old single counter did: JS runs a coroutine to completion
  // between awaits, and there is no await between reading `used[ch]` and
  // writing it. The predicate touches exactly ONE channel's counter, so the
  // single-counter argument simply applies three times independently, giving
  // the stronger post-condition ∀c: used[c] ≤ budget[c].
  //
  // Do NOT add borrowing between channels here. It would need to read and write
  // two counters, and one campaign could then consume shared credits another
  // campaign had reserved — a cross-campaign safety violation, not a policy
  // choice.
  const budget: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
  const used: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
  if (reservation?.kind === 'perChannel') {
    for (const c of CAMPAIGN_CHANNELS) {
      budget[c] = reservation.perChannel[c].own + reservation.perChannel[c].shared;
    }
  }
  // A reservation taken before per-channel budgets existed: one pooled ceiling,
  // exactly the old behaviour. Only reachable on a redeploy mid-dispatch.
  const legacyBudget = reservation?.kind === 'legacyScalar' ? reservation.total : null;
  let legacyUsed = 0;

  const heldPerChannel: Record<Channel, { count: number; credits: number }> = {
    email: { count: 0, credits: 0 },
    sms: { count: 0, credits: 0 },
    whatsapp: { count: 0, credits: 0 },
  };
  const creditBreakdown: SettleBreakdown = { perChannel: {}, providerCostMinorSnapshot: 0 };
  // Same memoized pricer the estimate used, so the reservation and the debit
  // price an SMS on identical text.
  const pricer = creditConfig ? createUnitPricer(creditConfig) : null;

  const countCredits = (msg: CampaignMessage, language: unknown): void => {
    if (!creditConfig || !pricer) return;
    const cost = pricer.credits(msg, language);
    const bucket = (creditBreakdown.perChannel[msg.channel] ??= { messages: 0, credits: 0 });
    bucket.messages += 1;
    bucket.credits += cost;
    if (msg.channel === 'sms') {
      bucket.segments = (bucket.segments ?? 0) + (pricer.segments(msg, language) ?? 1);
    }
    creditBreakdown.providerCostMinorSnapshot += pricer.providerCost(msg, language);
  };

  // One unit of work per (message, guest).
  const work: Array<{ msg: CampaignMessage; member: AudienceMember; messageIndex: number }> = [];
  messages.forEach((msg, messageIndex) => {
    for (const member of audience) work.push({ msg, member, messageIndex });
  });

  const writeSkippedRecord = async (
    msg: CampaignMessage,
    member: AudienceMember,
    messageIndex: number,
    deliveryStatus: 'skipped_quota' | 'held_insufficient_credits',
  ): Promise<void> => {
    await db.collection(CAMPAIGN_SENDS).add({
      campaignId: campaign.id,
      tenantUserId: campaign.tenantUserId,
      wifiGuestId: member.guestId,
      channel: msg.channel,
      messageIndex,
      to: msg.channel === 'email' ? member.email : member.phone,
      deliveryStatus,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      scheduledAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  };

  let heldCount = 0;

  await pMap(work, DISPATCH_CONCURRENCY, async ({ msg, member, messageIndex }) => {
    if (channelBlocked(msg.channel as MessagingChannel)) {
      skippedQuota += 1;
      await writeSkippedRecord(msg, member, messageIndex, 'skipped_quota');
      return;
    }

    // Hard stop when THIS CHANNEL's reservation is exhausted (spec §5.3.4): the
    // unit is recorded as held, retryable via /internal/campaigns/retry-held
    // after a top-up or a transfer. The other channels keep sending on their
    // own budgets. Check-and-claim happens synchronously (no await between the
    // test and the increment), so concurrent workers can't overshoot.
    let unitCost = 0;
    if (reservation && creditConfig && pricer && memberEligible(msg, member)) {
      const ch = msg.channel as Channel;
      // Priced on THIS guest's language variant — the same text dispatchOne is
      // about to render and the same the estimate reserved for.
      unitCost = pricer.credits(msg, member.language);
      const overBudget =
        legacyBudget !== null ? legacyUsed + unitCost > legacyBudget : used[ch] + unitCost > budget[ch];
      if (overBudget) {
        heldCount += 1;
        heldCredits += unitCost;
        heldPerChannel[ch].count += 1;
        heldPerChannel[ch].credits += unitCost;
        unitCost = 0;
        await writeSkippedRecord(msg, member, messageIndex, 'held_insufficient_credits');
        return;
      }
      // Optimistic claim; refunded below on provider failure. Under per-channel
      // budgets a failed SMS frees budget only for later SMS — the pooled
      // version leaked it to whichever channel asked next.
      //
      // `used[ch]` is always maintained so settle gets an accurate per-channel
      // breakdown; `legacyUsed` is only the pooled CEILING for the legacy case.
      used[ch] += unitCost;
      if (legacyBudget !== null) legacyUsed += unitCost;
    }

    const r = await recordAndDispatch(campaign, msg, messageIndex, member, venueNameCache);
    if (r.ok) {
      sent += 1;
      sentPerChannel[msg.channel as MessagingChannel] += 1;
      countCredits(msg, member.language);
    } else {
      failed += 1;
      // Provider rejected — not charged. Refund to the same counter the claim
      // took it from, so freed budget stays on its own channel.
      if (unitCost > 0) {
        used[msg.channel as Channel] -= unitCost;
        if (legacyBudget !== null) legacyUsed -= unitCost;
      }
    }
  });

  // Meter accepted sends (single choke point for all campaign messaging).
  await Promise.all(
    (Object.keys(sentPerChannel) as MessagingChannel[])
      .filter((channel) => sentPerChannel[channel] > 0)
      .map((channel) => recordSends(campaign.tenantUserId, channel, sentPerChannel[channel])),
  );

  // Settle the credit run (spec §5.3.5): one transaction debits what was
  // actually used and frees the unused remainder of the reservation.
  // What was actually consumed, per channel. Uses the BUDGET counters, not the
  // breakdown: in warn mode the breakdown accumulates while the counters stay
  // zero, and that asymmetry is deliberate. For a legacy scalar reservation
  // this is still accurate per channel — capsFor() routes every channel's drain
  // to `shared`, which is where the heal parked that hold.
  const usedPerChannel: Record<Channel, number> = { ...used };
  const creditsUsed = CAMPAIGN_CHANNELS.reduce((sum, c) => sum + usedPerChannel[c], 0);

  if (reservation) {
    try {
      await settleCampaignRun({
        tenantUserId: campaign.tenantUserId,
        campaignId: campaign.id,
        runId: reservation.runId,
        reservation,
        usedPerChannel,
        rateCardVersion: reservation.rateCardVersion,
        breakdown: creditBreakdown,
      });
      await maybeNotifyLowBalance(campaign.tenantUserId);
    } catch (err) {
      // Leave creditReservation on the doc — the sweeper releases it later.
      console.error(`[CAMPAIGN] settle failed for ${campaign.id} (sweeper will release):`, err);
    }
  }

  const update: Record<string, unknown> = {
    status: 'sent',
    'stats.sent': FieldValue.increment(sent),
    sentAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (reservation) {
    update.creditReservation = FieldValue.delete();
    update.creditsUsed = FieldValue.increment(creditsUsed);
  }
  if (heldCount > 0) {
    update.heldCount = FieldValue.increment(heldCount);
    update.heldPerChannel = heldPerChannel;
    // Naming the channel is load-bearing under per-channel credits: a tenant
    // with 200k email credits whose SMS ran out would otherwise read "not
    // enough credits" as a bug. Offer the move first — it is free and instant.
    const starved = CAMPAIGN_CHANNELS.filter((c) => heldPerChannel[c].count > 0);
    const parts = starved.map(
      (c) => `${heldPerChannel[c].count.toLocaleString()} ${CHANNEL_NOUNS[c]} (needs ~${heldPerChannel[c].credits.toLocaleString()} more credits)`,
    );
    update.creditsWarning =
      `${parts.join(', ')} held: those channels ran out of credits. ` +
      `Move credits to ${starved.map((c) => CHANNEL_NOUNS[c]).join('/')} under Billing & Credits, or top up, ` +
      `then retry the held messages.`;
  } else if (creditMode === 'warn' && creditConfig && warnWallet) {
    // Warn-only rollout: report what enforcement WOULD have done — PER CHANNEL,
    // or the soak that justifies flipping the flag would report "fine" for
    // exactly the campaigns hard lock is about to block.
    const short = CAMPAIGN_CHANNELS.map((c) => {
      const wouldUse = creditBreakdown.perChannel[c]?.credits ?? 0;
      const available = warnWallet.channelSpendable?.[c] ?? 0;
      const shared = warnWallet.channelSpendable?.shared ?? 0;
      return { channel: c, wouldUse, available: available + shared };
    }).filter((r) => r.wouldUse > r.available);

    const wouldUse = Object.values(creditBreakdown.perChannel).reduce((sum, b) => sum + (b?.credits ?? 0), 0);
    if (short.length > 0) {
      update.creditsWarning =
        `Once credit enforcement is on, part of this campaign would be held: ` +
        short
          .map((r) => `${CHANNEL_NOUNS[r.channel]} needs ~${r.wouldUse} credits but only ${Math.max(0, r.available)} are available to it`)
          .join('; ') +
        `. Top up, or move credits between channels.`;
      console.warn(
        `[CAMPAIGN][credits-warn] ${campaign.id}: per-channel shortfall ${JSON.stringify(short)}`,
      );
    } else if (wouldUse > warnWallet.spendable) {
      update.creditsWarning =
        `This campaign used ~${wouldUse} credits but your spendable balance is ${Math.max(0, warnWallet.spendable)}. ` +
        `Once credit enforcement is on, part of it would be held — consider topping up.`;
      console.warn(
        `[CAMPAIGN][credits-warn] ${campaign.id}: would use ${wouldUse}, spendable ${warnWallet.spendable}`,
      );
    }
  }
  if (skippedQuota > 0) {
    update.quotaWarning = `${skippedQuota} message(s) skipped: monthly quota reached. Top up credits or raise the plan quota.`;
  } else if (entitlements) {
    // Soft warning when this run pushed a channel past its allowance.
    const over = (Object.keys(sentPerChannel) as MessagingChannel[]).filter((channel) => {
      const remaining = entitlements.remaining[channel];
      return remaining !== null && sentPerChannel[channel] > remaining;
    });
    if (over.length > 0) {
      update.quotaWarning = `Sent past the monthly quota on: ${over.join(', ')}. Enforcement is off, but consider topping up credits.`;
    }
  }
  await ref.update(update);

  console.log(
    `[CAMPAIGN] ${campaign.id} dispatched: ${sent} sent, ${failed} failed, ${skippedQuota} skipped_quota, ` +
      `${heldCount} held (audience ${audience.length}${reservation ? `, credits ${creditsUsed}/${reservation.total}` : ''})`,
  );
  return { sent, failed };
}

async function loadCampaign(campaignId: string): Promise<CampaignDoc | null> {
  const snap = await db.collection(CAMPAIGNS).doc(campaignId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as Omit<CampaignDoc, 'id'>) };
}

/**
 * Atomically claim a campaign for sending: only a draft/scheduled broadcast owned
 * by `tenantUserId` may transition to "sending". Returns the campaign or a reason.
 *
 * With ENFORCE_CREDITS=true the SAME transaction also reserves the estimated
 * credits (spec §5.3.2) — the status flip and the wallet hold are one atomic
 * unit, so a claimed campaign always has its budget and an unclaimed one
 * never holds credits. Insufficient balance fails the claim with a shortfall
 * payload (same shape family as the `cannot_send_from_*` errors).
 */
async function claimForSending(
  campaignId: string,
  tenantUserId: string,
): Promise<
  | { ok: true; campaign: CampaignDoc }
  | {
      ok: false;
      reason: string;
      needed?: number;
      spendable?: number;
      shortfalls?: ChannelShortfall[];
      sharedContended?: boolean;
    }
> {
  const ref = db.collection(CAMPAIGNS).doc(campaignId);

  // Estimate outside the transaction (audience materialization is heavy);
  // the counter inside dispatch trues everything up at settle time.
  //
  // Only the NEED is precomputed here. Which buckets it comes out of is decided
  // inside the transaction by reserveInTransaction, because that depends on
  // wallet state and Firestore re-runs the callback on contention — allocating
  // out here would let two concurrent claims hand out the same shared credits.
  let plan: {
    runId: string;
    need: Record<Channel, number>;
    total: number;
    rateCardVersion: number;
    reservedAt: string;
  } | null = null;
  if (creditsEnforcementMode() === 'enforce') {
    const campaign = await loadCampaign(campaignId);
    if (campaign && campaign.tenantUserId === tenantUserId && campaign.type === 'broadcast') {
      const estimate = await estimateCampaign(campaign);
      plan = {
        // Generated outside runTransaction so it is stable across SDK retries —
        // that is what makes reserveInTransaction's already-reserved branch a
        // correct no-op rather than a second reservation.
        runId: newRunId(),
        need: estimate.creditsPerChannel,
        total: estimate.creditsNeeded,
        rateCardVersion: estimate.config.rateCardVersion,
        reservedAt: new Date().toISOString(),
      };
    }
  }

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false as const, reason: 'not_found' };
    const data = snap.data() as CampaignDoc;
    if (data.tenantUserId !== tenantUserId) return { ok: false as const, reason: 'forbidden' };
    if (data.type !== 'broadcast') return { ok: false as const, reason: 'not_broadcast' };
    if (!['draft', 'scheduled'].includes(data.status)) {
      return { ok: false as const, reason: `cannot_send_from_${data.status}` };
    }

    if (plan) {
      const reserved = await reserveInTransaction(tx, {
        tenantUserId,
        campaignId,
        runId: plan.runId,
        need: plan.need,
        rateCardVersion: plan.rateCardVersion,
      });
      if (!reserved.ok) {
        return {
          ok: false as const,
          reason: 'insufficient_credits',
          needed: reserved.needed,
          spendable: reserved.spendable,
          shortfalls: reserved.shortfalls,
          sharedContended: reserved.sharedContended,
        };
      }
      const reservation: CreditReservation = {
        runId: plan.runId,
        reserved: reserved.total,
        rateCardVersion: plan.rateCardVersion,
        reservedAt: plan.reservedAt,
        perChannel: reserved.allocation,
      };
      tx.update(ref, {
        status: 'sending',
        creditReservation: reservation,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        ok: true as const,
        campaign: { ...data, id: snap.id, status: 'sending', creditReservation: reservation },
      };
    }

    tx.update(ref, { status: 'sending', updatedAt: FieldValue.serverTimestamp() });
    return { ok: true as const, campaign: { ...data, id: snap.id, status: 'sending' } };
  });
}

/**
 * Send a broadcast. If it's scheduled for the future, park it as "scheduled" for
 * the cron to pick up; otherwise start dispatching in the background and return
 * immediately (dispatch can be long for big audiences).
 */
export async function sendBroadcast(
  campaignId: string,
  tenantUserId: string,
): Promise<{
  ok: boolean;
  status?: string;
  scheduledFor?: string;
  error?: string;
  needed?: number;
  spendable?: number;
  shortfalls?: ChannelShortfall[];
  sharedContended?: boolean;
}> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'not_found' };
  if (campaign.tenantUserId !== tenantUserId) return { ok: false, error: 'forbidden' };
  if (campaign.type !== 'broadcast') return { ok: false, error: 'not_broadcast' };
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    return { ok: false, error: `cannot_send_from_${campaign.status}` };
  }

  const sendAt = campaign.schedule?.mode === 'scheduled' ? campaign.schedule?.sendAt : null;
  if (sendAt && new Date(sendAt).getTime() > Date.now()) {
    await db.collection(CAMPAIGNS).doc(campaignId).update({
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, status: 'scheduled', scheduledFor: sendAt };
  }

  const claim = await claimForSending(campaignId, tenantUserId);
  if (!claim.ok) {
    return {
      ok: false,
      error: claim.reason,
      needed: claim.needed,
      spendable: claim.spendable,
      shortfalls: claim.shortfalls,
      sharedContended: claim.sharedContended,
    };
  }

  // Fire-and-forget: don't block the HTTP response on a large dispatch.
  dispatchCampaign(claim.campaign).catch(async (err) => {
    console.error(`[CAMPAIGN] dispatch failed for ${campaignId}:`, err);
    await db
      .collection(CAMPAIGNS)
      .doc(campaignId)
      .update({ status: 'draft', updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {});
  });

  return { ok: true, status: 'sending' };
}

/** How old a reservation must be before the sweeper releases it. */
const RESERVATION_SWEEP_HOURS = 6;

/**
 * How long a campaign may sit in `sending` before the run is presumed dead.
 *
 * `dispatchCampaign` is fire-and-forget in memory, so a deploy, crash or OOM
 * kills the run and leaves the doc at `sending` forever. Six hours is a wide
 * margin: MAX_AUDIENCE is 10 000 at DISPATCH_CONCURRENCY 8, so even a slow
 * provider finishes in well under an hour.
 */
const STUCK_SENDING_SWEEP_HOURS = 6;

/**
 * A campaign stuck in `sending` is unreachable by BOTH recovery paths:
 * `claimForSending` requires `draft|scheduled`, `retryHeldSends` requires
 * `sent`. So it sits there forever with its held send records orphaned and no
 * button in the UI that does anything.
 *
 * Closing it out as `sent` is the only safe move. Sending it back to `draft`
 * would let the tenant re-send to everyone who already received the message.
 *
 * Note what this does NOT recover: units the dead run never reached have no
 * `CampaignSends` record at all — they were never written — so `retryHeldSends`
 * cannot find them. Only units explicitly held for credits come back. The
 * warning says so rather than implying a clean recovery.
 */
async function recoverStuckSending(
  ref: FirebaseFirestore.DocumentReference,
  campaignId: string,
  detail: string,
): Promise<void> {
  await ref.update({
    status: 'sent',
    sentAt: FieldValue.serverTimestamp(),
    interruptedAt: FieldValue.serverTimestamp(),
    creditsWarning:
      'This send was interrupted before it finished (the server restarted mid-run). ' +
      'Messages already sent were delivered. Any messages held for credits can be retried below; ' +
      'recipients the run never reached were not recorded, so check the send list before sending a follow-up.',
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.warn(`[CAMPAIGN SWEEPER] recovered stuck campaign ${campaignId} (${detail}) — sending → sent`);
}

/**
 * Reservation-leak + stuck-run sweeper (spec §9).
 *
 * Two independent failures, both from a dispatch that died mid-run:
 *
 *  1. `creditReservation` left on the campaign and credits still held on the
 *     wallet. Any reservation older than RESERVATION_SWEEP_HOURS is released —
 *     a healthy dispatch settles within minutes, so age alone marks the leak.
 *     `releaseReservation` shares the settle's ledger doc id, so racing a
 *     late-but-alive settle is safe (whichever runs second no-ops).
 *  2. The campaign left at `status: 'sending'`, which no recovery path accepts.
 *
 * They need separate queries. Pass 1 keys on the reservation, so it misses a
 * campaign that crashed with NO reservation — which is EVERY campaign while
 * `ENFORCE_CREDITS` is off or in warn mode, i.e. production today. Pass 2 keys
 * on the status, so it misses a campaign whose settle succeeded but whose doc
 * update then failed, leaving a dangling reservation on an already-`sent` doc.
 */
export async function sweepStaleReservations(): Promise<void> {
  const now = Date.now();
  const recovered = new Set<string>();

  // ── Pass 1: stale reservations (credits held by a dead run) ────────────────
  const cutoffIso = new Date(now - RESERVATION_SWEEP_HOURS * 60 * 60 * 1000).toISOString();
  const staleReservations = await db
    .collection(CAMPAIGNS)
    .where('creditReservation.reservedAt', '<', cutoffIso)
    .get();

  for (const doc of staleReservations.docs) {
    const data = doc.data() as CampaignDoc;
    const reservation = normalizeReservation(data.creditReservation);
    if (!reservation) continue;
    try {
      await releaseReservation({
        tenantUserId: data.tenantUserId,
        campaignId: doc.id,
        runId: reservation.runId,
        reservation,
        note: `Stale reservation swept (status ${data.status}, reserved ${data.creditReservation?.reservedAt})`,
      });
      await doc.ref.update({
        creditReservation: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.warn(
        `[CAMPAIGN SWEEPER] released stale reservation of ${reservation.total} credits on ${doc.id} (status ${data.status})`,
      );

      // The credits are back, but the campaign is still unreachable unless we
      // also move it out of `sending`.
      if (data.status === 'sending') {
        await recoverStuckSending(doc.ref, doc.id, 'stale reservation');
        recovered.add(doc.id);
      }
    } catch (err) {
      console.error(`[CAMPAIGN SWEEPER] failed to release reservation on ${doc.id}:`, err);
    }
  }

  // ── Pass 2: stuck in `sending` with no reservation to key off ──────────────
  // Single-field equality only, with the age filter applied in memory. Adding
  // `.where('updatedAt','<',…)` would make this a composite query, and this
  // Firestore project is shared — docs/firestore-indexes.md says indexes must
  // be created by hand in the console, so a composite query here would throw
  // FAILED_PRECONDITION inside a cron job and quietly never sweep. The result
  // set is naturally tiny (only campaigns actively dispatching, plus the stuck
  // ones this pass then drains).
  const stuckCutoff = now - STUCK_SENDING_SWEEP_HOURS * 60 * 60 * 1000;
  const sending = await db.collection(CAMPAIGNS).where('status', '==', 'sending').get();

  for (const doc of sending.docs) {
    if (recovered.has(doc.id)) continue;
    const data = doc.data() as CampaignDoc;

    // `updatedAt` is stamped when the status flips to `sending` and nothing
    // touches the doc again until the run finishes, so it dates the run.
    const updatedAt = (doc.get('updatedAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis?.();
    if (updatedAt === undefined) continue; // never stamped — leave it alone
    if (updatedAt >= stuckCutoff) continue; // still young; the run may be alive

    // A reservation younger than the pass-1 cutoff means the run may still be
    // alive; leave it for the next tick rather than closing out a live send.
    if (data.creditReservation?.reservedAt && data.creditReservation.reservedAt >= cutoffIso) continue;

    try {
      await recoverStuckSending(doc.ref, doc.id, 'no live dispatch');
    } catch (err) {
      console.error(`[CAMPAIGN SWEEPER] failed to recover stuck campaign ${doc.id}:`, err);
    }
  }
}

/** Run any scheduled broadcasts whose send time has arrived. Called by the cron. */
export async function runDueScheduledCampaigns(): Promise<void> {
  const snap = await db.collection(CAMPAIGNS).where('status', '==', 'scheduled').get();
  const now = Date.now();
  for (const doc of snap.docs) {
    const data = doc.data() as CampaignDoc;
    const sendAt = data.schedule?.sendAt;
    if (!sendAt || new Date(sendAt).getTime() > now) continue;
    // Dispatch-time lapse gate. The CMS's requireActiveSubscription ran when
    // the tenant clicked schedule, but the subscription can end between then
    // and sendAt — without this, cancelling on Aug 20 still sends the full
    // Sep 1 volume at the business's provider cost. Same parking mechanism as
    // insufficient credits below: the campaign stays `scheduled` with a
    // visible warning, so re-subscribing lets it out on the next tick with no
    // further action. Fails open inside isLapsedForSending — a billing-check
    // outage must not kill a legitimate scheduled send.
    if (await isLapsedForSending(data.tenantUserId)) {
      console.warn(
        `[CAMPAIGN] withholding scheduled dispatch of ${doc.id} — tenant ${data.tenantUserId} has no active subscription`,
      );
      await doc.ref
        .update({
          creditsWarning:
            'Scheduled send is on hold: this account has no active subscription. ' +
            'Choose a plan under Billing & Credits and it goes out on the next check.',
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
      continue;
    }
    const claim = await claimForSending(doc.id, data.tenantUserId);
    if (!claim.ok) {
      // A scheduled campaign short on credits stays parked; surface why so the
      // tenant sees it on the dashboard, and retry on the next tick (a top-up
      // unblocks it without further action).
      if (claim.reason === 'insufficient_credits') {
        // Name the channel: under earmarked credits the pooled total can look
        // healthy while one channel is what's actually blocking the send.
        const starved = (claim.shortfalls ?? []).filter((s) => s.short > 0);
        const warning = claim.sharedContended
          ? `Scheduled send is waiting on ${starved.map((s) => CHANNEL_NOUNS[s.channel as Channel]).join('/')} credits. ` +
            `You have enough overall — move credits to that channel under Billing & Credits and it goes out on the next check.`
          : starved.length > 0
            ? `Scheduled send is waiting for credits: ` +
              starved
                .map((s) => `${CHANNEL_NOUNS[s.channel as Channel]} needs ${s.short.toLocaleString()} more`)
                .join(', ') +
              `. Top up, or move credits between channels, to let it go out.`
            : `Scheduled send is waiting for credits: needs ${claim.needed ?? '?'} but only ` +
              `${claim.spendable ?? 0} are spendable. Top up to let it go out.`;
        await doc.ref
          .update({ creditsWarning: warning, updatedAt: FieldValue.serverTimestamp() })
          .catch(() => {});
        await maybeNotifyLowBalance(data.tenantUserId).catch(() => {});
      }
      continue;
    }
    dispatchCampaign(claim.campaign).catch(async (err) => {
      console.error(`[CAMPAIGN] scheduled dispatch failed for ${doc.id}:`, err);
      await doc.ref.update({ status: 'scheduled', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
  }
}

/**
 * Launch-preview estimate (spec §5.3.1): materialize the audience and price it
 * against the current rate card, next to the tenant's spendable balance. The
 * CMS Review step renders "This campaign needs ~1,240 credits; you have 4,230."
 */
export async function estimateCampaignCredits(
  campaignId: string,
  tenantUserId: string,
): Promise<
  | {
      ok: true;
      audienceCount: number;
      unitsPerChannel: Record<Channel, number>;
      creditsPerChannel: Record<Channel, number>;
      smsSegmentsPerMessage: number | null;
      creditsNeeded: number;
      spendable: number;
      sufficient: boolean;
      shortfall: number;
      /** Per-channel feasibility — additive, older CMS builds ignore it. */
      perChannel: Array<{ channel: Channel; needed: number; available: number; short: number }>;
      /** Enough credits overall, wrong channels — the fix is "move", not "top up". */
      sharedContended: boolean;
      rateCardVersion: number;
      enforcementMode: string;
    }
  | { ok: false; error: string }
> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'not_found' };
  if (campaign.tenantUserId !== tenantUserId) return { ok: false, error: 'forbidden' };

  const [estimate, wallet] = await Promise.all([
    estimateCampaign(campaign),
    getWalletSnapshot(tenantUserId).catch(() => null),
  ]);
  const spendable = wallet?.spendable ?? 0;

  // Feasibility is PER CHANNEL, not `spendable >= creditsNeeded`. Under
  // earmarked credits the pooled comparison can say "fine" for a campaign the
  // claim will reject with 402 — a green check on the Review step followed by a
  // hard failure is the worst possible first impression of this feature.
  const balances = wallet?.channelBalances ?? null;
  const allocation = balances ? allocateReservation(balances, estimate.creditsPerChannel) : null;
  const perChannel = CAMPAIGN_CHANNELS.filter((c) => estimate.creditsPerChannel[c] > 0).map((c) => {
    const needed = estimate.creditsPerChannel[c];
    const available = balances ? spendableForChannel(balances, c) : spendable;
    const short = allocation && !allocation.ok ? allocation.remaining[c] : 0;
    return { channel: c, needed, available, short };
  });

  // With no wallet reading available, fall back to the pooled comparison rather
  // than blocking — the estimate is advisory, the claim is the authority.
  const sufficient = allocation ? allocation.ok : spendable >= estimate.creditsNeeded;

  return {
    ok: true,
    audienceCount: estimate.audienceCount,
    unitsPerChannel: estimate.unitsPerChannel,
    creditsPerChannel: estimate.creditsPerChannel,
    smsSegmentsPerMessage: estimate.smsSegmentsPerMessage,
    creditsNeeded: estimate.creditsNeeded,
    spendable,
    sufficient,
    shortfall: Math.max(0, estimate.creditsNeeded - spendable),
    perChannel,
    sharedContended: !sufficient && spendable >= estimate.creditsNeeded,
    rateCardVersion: estimate.config.rateCardVersion,
    enforcementMode: creditsEnforcementMode(),
  };
}

/**
 * Re-dispatch a campaign's held sends after a top-up (spec §5.3.4). There is
 * no generic mid-send pause in this engine — held units are the resume
 * mechanism: re-estimate them, re-reserve, dispatch only those, settle.
 * Consent is re-checked per guest at send time (spec §9).
 */
export async function retryHeldSends(
  campaignId: string,
  tenantUserId: string,
): Promise<
  | { ok: true; retried: number; sent: number; failed: number; stillHeld: number }
  | {
      ok: false;
      error: string;
      needed?: number;
      spendable?: number;
      shortfalls?: ChannelShortfall[];
      sharedContended?: boolean;
    }
> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return { ok: false, error: 'not_found' };
  if (campaign.tenantUserId !== tenantUserId) return { ok: false, error: 'forbidden' };
  if (campaign.type !== 'broadcast') return { ok: false, error: 'not_broadcast' };
  if (campaign.status !== 'sent') return { ok: false, error: `cannot_retry_from_${campaign.status}` };

  const heldSnap = await db
    .collection(CAMPAIGN_SENDS)
    .where('campaignId', '==', campaignId)
    .where('deliveryStatus', '==', 'held_insufficient_credits')
    .get();
  if (heldSnap.empty) return { ok: false, error: 'no_held_sends' };

  const messages = campaign.messages || [];
  const config = await getCreditConfig();
  const mode = creditsEnforcementMode();
  // Prices each held unit on the guest's CURRENT language — the same variant
  // the retry is about to send, which may differ from the original run if the
  // guest switched languages in between.
  const pricer = createUnitPricer(config);

  // Rebuild audience members from the live guest docs — consent re-checked NOW.
  const guestIds = Array.from(new Set(heldSnap.docs.map((d) => String(d.data().wifiGuestId || '')))).filter(Boolean);
  const guestDocs = new Map<string, FirebaseFirestore.DocumentData>();
  await Promise.all(
    chunk(guestIds, FIRESTORE_IN_LIMIT).map(async (ids) => {
      const refs = ids.map((id) => db.collection(USERS).doc(id));
      const snaps = await db.getAll(...refs);
      snaps.forEach((s) => {
        if (s.exists) guestDocs.set(s.id, s.data() as FirebaseFirestore.DocumentData);
      });
    }),
  );

  interface RetryUnit {
    recordRef: FirebaseFirestore.DocumentReference;
    msg: CampaignMessage;
    messageIndex: number;
    member: AudienceMember;
    cost: number;
  }
  const units: RetryUnit[] = [];
  let droppedOptOut = 0;

  const apVenue = await resolveTenantApVenueMap(tenantUserId);
  for (const recordDoc of heldSnap.docs) {
    const record = recordDoc.data();
    const messageIndex = Number(record.messageIndex ?? -1);
    const msg = messages[messageIndex];
    if (!msg || !campaign.channels.includes(msg.channel)) continue;
    const guest = guestDocs.get(String(record.wifiGuestId));
    if (!guest || !isOptedInFor(guest, msg.channel)) {
      // Guest opted out (or vanished) since the original run — never retry.
      droppedOptOut += 1;
      await recordDoc.ref
        .update({
          deliveryStatus: 'failed',
          failureReason: 'opted_out_channel',
          statusUpdatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
      continue;
    }
    const accessPointId = (guest.captivePortalAccessPointId as string) || null;
    units.push({
      recordRef: recordDoc.ref,
      msg,
      messageIndex,
      member: {
        guestId: recordDoc.data().wifiGuestId,
        firstName: (guest.firstName as string) || '',
        lastName: (guest.lastName as string) || '',
        email: typeof guest.email === 'string' && guest.email.includes('@') ? guest.email : null,
        phone: typeof guest.phone === 'string' && guest.phone.trim() ? guest.phone : null,
        phoneCountryCode: (guest.phoneCountryCode as string) || '',
        // Re-read on retry rather than trusting the original run: a guest who
        // switched language between the failed send and the retry should get
        // the retry in the language they now read.
        language: normalizeLanguage(guest.language),
        accessPointId,
        venueId: accessPointId ? (apVenue.get(accessPointId) ?? null) : null,
        optOuts: {
          email: guest.unsubscribed === true,
          sms: guest.smsOptOut === true,
          whatsapp: guest.whatsappOptOut === true,
        },
      },
      cost: pricer.credits(msg, normalizeLanguage(guest.language)),
    });
  }

  if (units.length === 0) {
    return { ok: true, retried: 0, sent: 0, failed: droppedOptOut, stillHeld: 0 };
  }

  // Re-reserve for the held units only, per channel.
  const runId = newRunId();
  const needFor = (list: typeof units): Record<Channel, number> => {
    const need: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
    for (const u of list) need[u.msg.channel as Channel] += u.cost;
    return need;
  };

  let dispatchUnits = units;
  let stillHeldUnits: typeof units = [];
  let reservation: NormalizedReservation | null = null;

  if (mode === 'enforce') {
    const attempt = async (list: typeof units) => {
      const need = needFor(list);
      const res = await reserveCredits({
        tenantUserId,
        campaignId,
        runId,
        need,
        rateCardVersion: config.rateCardVersion,
      });
      return {
        kind: 'perChannel' as const,
        runId,
        total: res.total,
        rateCardVersion: config.rateCardVersion,
        perChannel: res.allocation,
      };
    };

    try {
      reservation = await attempt(units);
    } catch (err) {
      if (!(err instanceof InsufficientCreditsError)) throw err;

      // Partial retry. Credits are per channel, so a tenant who topped up email
      // but not SMS should get their email units back — all-or-nothing would
      // make them wait on an unrelated channel.
      const short = new Set(err.shortfalls.map((s) => s.channel as Channel));
      const covered = units.filter((u) => !short.has(u.msg.channel as Channel));
      if (covered.length === 0 || short.size === 0) {
        return {
          ok: false,
          error: 'insufficient_credits',
          needed: err.needed,
          spendable: err.spendable,
          shortfalls: err.shortfalls,
          sharedContended: err.sharedContended,
        };
      }
      try {
        reservation = await attempt(covered);
        dispatchUnits = covered;
        stillHeldUnits = units.filter((u) => short.has(u.msg.channel as Channel));
      } catch (err2) {
        if (!(err2 instanceof InsufficientCreditsError)) throw err2;
        return {
          ok: false,
          error: 'insufficient_credits',
          needed: err2.needed,
          spendable: err2.spendable,
          shortfalls: err2.shortfalls,
          sharedContended: err2.sharedContended,
        };
      }
    }
  }
  const reserved = reservation?.total ?? 0;

  const venueNameCache = new Map<string, string>();
  let sent = 0;
  let failed = 0;
  let creditsUsed = 0;
  const usedPerChannel: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
  const sentPerChannel: Record<MessagingChannel, number> = { email: 0, sms: 0, whatsapp: 0 };
  const breakdown: SettleBreakdown = { perChannel: {}, providerCostMinorSnapshot: 0 };

  await pMap(dispatchUnits, DISPATCH_CONCURRENCY, async (unit) => {
    let outcome: DispatchOutcome;
    try {
      outcome = await dispatchOne(campaign, unit.msg, unit.member, venueNameCache, unit.recordRef.id);
    } catch (err) {
      outcome = { ok: false, status: 'failed', reason: err instanceof Error ? err.message : 'dispatch_error' };
    }

    const patch: Record<string, unknown> = {
      deliveryStatus: outcome.status,
      retriedAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
    };
    if (outcome.providerField && outcome.providerId) patch[outcome.providerField] = outcome.providerId;
    if (outcome.reason) patch.failureReason = outcome.reason;
    if (outcome.shortCodes && outcome.shortCodes.length) patch.shortCodes = outcome.shortCodes;
    if (outcome.rendered?.subject !== undefined) patch.subject = outcome.rendered.subject;
    if (outcome.rendered?.body !== undefined) patch.body = outcome.rendered.body;
    if (outcome.rendered?.content !== undefined) patch.content = outcome.rendered.content;
    await unit.recordRef.update(patch).catch(() => {});

    if (outcome.ok) {
      sent += 1;
      sentPerChannel[unit.msg.channel as MessagingChannel] += 1;
      creditsUsed += unit.cost;
      usedPerChannel[unit.msg.channel as Channel] += unit.cost;
      const bucket = (breakdown.perChannel[unit.msg.channel] ??= { messages: 0, credits: 0 });
      bucket.messages += 1;
      bucket.credits += unit.cost;
      if (unit.msg.channel === 'sms') {
        bucket.segments = (bucket.segments ?? 0) + (pricer.segments(unit.msg, unit.member.language) ?? 1);
      }
      breakdown.providerCostMinorSnapshot += pricer.providerCost(unit.msg, unit.member.language);
    } else {
      failed += 1;
    }
  });

  await Promise.all(
    (Object.keys(sentPerChannel) as MessagingChannel[])
      .filter((channel) => sentPerChannel[channel] > 0)
      .map((channel) => recordSends(tenantUserId, channel, sentPerChannel[channel])),
  );

  if (mode === 'enforce' && reservation) {
    try {
      await settleCampaignRun({
        tenantUserId,
        campaignId,
        runId,
        reservation,
        usedPerChannel,
        rateCardVersion: config.rateCardVersion,
        breakdown,
      });
      await maybeNotifyLowBalance(tenantUserId);
    } catch (err) {
      console.error(`[CAMPAIGN] retry settle failed for ${campaignId} (sweeper will release):`, err);
    }
  }

  // With partial retry, "all held records were handled" is no longer true —
  // units on a channel we couldn't cover stay held. Clearing heldCount and
  // deleting creditsWarning unconditionally would hide them: the tenant's
  // banner would vanish while their SMS were still parked.
  const stillHeld = stillHeldUnits.length;
  const heldPerChannel: Record<Channel, { count: number; credits: number }> = {
    email: { count: 0, credits: 0 },
    sms: { count: 0, credits: 0 },
    whatsapp: { count: 0, credits: 0 },
  };
  for (const u of stillHeldUnits) {
    const c = u.msg.channel as Channel;
    heldPerChannel[c].count += 1;
    heldPerChannel[c].credits += u.cost;
  }

  const ref = db.collection(CAMPAIGNS).doc(campaignId);
  const patch: Record<string, unknown> = {
    'stats.sent': FieldValue.increment(sent),
    heldCount: stillHeld,
    ...(mode === 'enforce' ? { creditsUsed: FieldValue.increment(creditsUsed) } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (stillHeld > 0) {
    const starved = CAMPAIGN_CHANNELS.filter((c) => heldPerChannel[c].count > 0);
    patch.heldPerChannel = heldPerChannel;
    patch.creditsWarning =
      starved
        .map((c) => `${heldPerChannel[c].count.toLocaleString()} ${CHANNEL_NOUNS[c]} (needs ~${heldPerChannel[c].credits.toLocaleString()} more credits)`)
        .join(', ') +
      ` still held. Move credits to ${starved.map((c) => CHANNEL_NOUNS[c]).join('/')} under Billing & Credits, ` +
      `or top up, then retry again.`;
  } else {
    patch.creditsWarning = FieldValue.delete();
    patch.heldPerChannel = FieldValue.delete();
  }
  await ref.update(patch);

  console.log(
    `[CAMPAIGN] ${campaignId} retry-held: ${sent} sent, ${failed + droppedOptOut} failed, ${stillHeld} still held (credits ${creditsUsed}/${reserved})`,
  );
  return { ok: true, retried: dispatchUnits.length, sent, failed: failed + droppedOptOut, stillHeld };
}

/** Pause a not-yet-sent (scheduled) broadcast so the cron skips it. */
export async function pauseCampaign(campaignId: string, tenantUserId: string) {
  return setStatusIf(campaignId, tenantUserId, ['scheduled'], 'paused');
}

/** Resume a paused broadcast back to scheduled. */
export async function resumeCampaign(campaignId: string, tenantUserId: string) {
  return setStatusIf(campaignId, tenantUserId, ['paused'], 'scheduled');
}

/** Cancel a scheduled/paused broadcast (drops it back to draft). */
export async function cancelCampaign(campaignId: string, tenantUserId: string) {
  return setStatusIf(campaignId, tenantUserId, ['scheduled', 'paused'], 'draft');
}

async function setStatusIf(
  campaignId: string,
  tenantUserId: string,
  fromStatuses: string[],
  toStatus: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const ref = db.collection(CAMPAIGNS).doc(campaignId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, error: 'not_found' };
    const data = snap.data() as CampaignDoc;
    if (data.tenantUserId !== tenantUserId) return { ok: false, error: 'forbidden' };
    if (!fromStatuses.includes(data.status)) {
      return { ok: false, error: `cannot_transition_from_${data.status}` };
    }
    tx.update(ref, { status: toStatus, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, status: toStatus };
  });
}

/**
 * Fire active automation campaigns for a guest who just produced a Wi-Fi event.
 * Called from the captive portal connect path (same gate as entity-marketing:
 * the guest opted in to marketing). Matches campaigns by the guest's venue +
 * trigger, then dispatches each message (honoring per-message delays).
 *
 * Best-effort & fire-and-forget — never blocks the guest's connection response.
 */
export async function fireAutomationsForGuest(
  accessPointId: string,
  guestId: string,
  fields: {
    firstName?: string; lastName?: string; email?: string;
    phone?: string; phoneCountryCode?: string; language?: string | null;
  },
  wifiEvent: 'onConnect' | 'onReconnect' | 'onDisconnect',
): Promise<void> {
  if (!accessPointId || !guestId) return;

  const apDoc = await db.collection(ACCESS_POINTS).doc(accessPointId).get();
  const venueId = (apDoc.data()?.venueId as string) || null;
  if (!venueId) return;

  const venueDoc = await db.collection(VENUES).doc(venueId).get();
  const tenantUserId = (venueDoc.data()?.tenantUserId as string) || null;
  if (!tenantUserId) return;

  // Single-field query (no composite index needed); filter status/type in memory.
  const snap = await db.collection(CAMPAIGNS).where('tenantUserId', '==', tenantUserId).get();
  if (snap.empty) return;

  const member: AudienceMember = {
    guestId,
    firstName: fields.firstName || '',
    lastName: fields.lastName || '',
    email: typeof fields.email === 'string' && fields.email.includes('@') ? fields.email : null,
    phone: typeof fields.phone === 'string' && fields.phone.trim() ? fields.phone : null,
    phoneCountryCode: fields.phoneCountryCode || '',
    accessPointId,
    venueId,
    language: normalizeLanguage(fields.language),
  };
  const venueNameCache = new Map<string, string>();

  // Credit gate for automations (spec §5.3.6): no reservation at this volume —
  // check spendable up front, debit per accepted message. The snapshot is one
  // read per firing; drift between concurrent firings is the bounded overspend
  // the spec accepts, and it settles on the next read.
  const creditMode = creditsEnforcementMode();
  const creditConfig = creditMode !== 'off' ? await getCreditConfig().catch(() => null) : null;
  // Automations fire for one guest, so this prices on that guest's language —
  // the variant fireAutomationsForGuest is about to dispatch.
  const pricer = creditConfig ? createUnitPricer(creditConfig) : null;

  // Per-channel availability plus the shared pool, tracked separately: credits
  // are earmarked, so an automation on a starved channel must be held even when
  // the account total looks healthy. `null` = fail open (spec §5.3.6).
  let autoAvail: { own: Record<Channel, number>; sharedPool: number } | null = null;
  if (creditMode === 'enforce' && creditConfig) {
    autoAvail = await getWalletSnapshot(tenantUserId)
      .then((w) => {
        if (w.suspended) return { own: { email: 0, sms: 0, whatsapp: 0 }, sharedPool: 0 };
        const own = { email: 0, sms: 0, whatsapp: 0 } as Record<Channel, number>;
        for (const c of CAMPAIGN_CHANNELS) own[c] = availableTotal(w.channelBalances[c]);
        return { own, sharedPool: availableTotal(w.channelBalances.shared) };
      })
      .catch(() => null); // wallet read failure fails open (spec: fail-open)
  }
  let debited = false;

  for (const doc of snap.docs) {
    const campaign = { id: doc.id, ...(doc.data() as Omit<CampaignDoc, 'id'>) };
    if (campaign.status !== 'active' || campaign.type !== 'automation') continue;
    const trigger = campaign.trigger;
    // Phase 4 fires Wi-Fi-event automations; date-relative triggers are handled
    // by a daily scan (future) and skipped here.
    if (!trigger || trigger.kind !== 'wifiEvent' || trigger.wifiEvent !== wifiEvent) continue;

    const seg = campaign.segment || {};
    if (seg.venueIds && seg.venueIds.length > 0 && !seg.venueIds.includes(venueId)) continue;
    // Automations re-check the segment per firing because they never go through
    // materializeAudience — without this a language-targeted automation would
    // fire for every guest.
    if (seg.language && !matchesLanguageFilter(member.language, seg.language)) continue;

    const messages = (campaign.messages || []).filter((m) => campaign.channels.includes(m.channel));

    // Quota check (5-min-cached entitlements — good enough for the low
    // per-guest volume of automations). Hard enforcement skips over-quota
    // channels; soft mode sends and lets metering surface the overage.
    const entitlements = quotasEnforced()
      ? await getEntitlements(campaign.tenantUserId).catch(() => null)
      : null;

    let sent = 0;
    const sentPerChannel: Record<MessagingChannel, number> = { email: 0, sms: 0, whatsapp: 0 };
    for (let i = 0; i < messages.length; i++) {
      const channel = messages[i].channel as MessagingChannel;
      if (entitlements) {
        const remaining = entitlements.remaining[channel];
        if (remaining !== null && remaining <= 0) continue; // skipped_quota
      }

      const msgCost = pricer ? pricer.credits(messages[i], member.language) : 0;
      // Admissibility only — debitOne does the real expiry-first bucket maths.
      // Spending own-before-shared here is deliberate: it is the order that
      // admits the most subsequent messages.
      const fromOwn = autoAvail ? Math.min(msgCost, autoAvail.own[channel as Channel]) : 0;
      const fromShared = msgCost - fromOwn;
      if (autoAvail && fromShared > autoAvail.sharedPool) {
        // This CHANNEL is out of credits — record the held message + alert
        // (24h-deduped). heldChannel/heldReason so a tenant with a starved SMS
        // automation and a full wallet has something to act on.
        await db
          .collection(CAMPAIGN_SENDS)
          .add({
            campaignId: campaign.id,
            tenantUserId: campaign.tenantUserId,
            wifiGuestId: member.guestId,
            channel,
            messageIndex: i,
            to: channel === 'email' ? member.email : member.phone,
            deliveryStatus: 'held_insufficient_credits',
            heldChannel: channel,
            heldCredits: msgCost,
            heldReason: 'channel_budget',
            wifiEvent,
            source: 'automation',
            statusUpdatedAt: FieldValue.serverTimestamp(),
            scheduledAt: FieldValue.serverTimestamp(),
          })
          .catch(() => {});
        await maybeNotifyLowBalance(campaign.tenantUserId).catch(() => {});
        continue;
      }

      const r = await recordAndDispatch(campaign, messages[i], i, member, venueNameCache, {
        wifiEvent,
        source: 'automation',
      });
      if (r.ok) {
        sent += 1;
        sentPerChannel[channel] += 1;
        if (creditMode === 'enforce' && creditConfig && msgCost > 0) {
          if (autoAvail) {
            autoAvail.own[channel as Channel] -= fromOwn;
            autoAvail.sharedPool -= fromShared;
          }
          debited = true;
          await debitOne({
            tenantUserId: campaign.tenantUserId,
            sendId: r.sendId,
            credits: msgCost,
            channel: channel as MessagingChannel,
            segments: pricer?.segments(messages[i], member.language) ?? undefined,
            campaignId: campaign.id,
            rateCardVersion: creditConfig.rateCardVersion,
            providerCostMinorSnapshot: pricer ? pricer.providerCost(messages[i], member.language) : 0,
          }).catch((err) => console.error('[CAMPAIGN AUTOMATION credits]', err));
        }
      }
    }
    if (sent > 0) {
      await doc.ref
        .update({ 'stats.sent': FieldValue.increment(sent) })
        .catch((err) => console.error('[CAMPAIGN AUTOMATION stats]', err));
      await Promise.all(
        (Object.keys(sentPerChannel) as MessagingChannel[])
          .filter((channel) => sentPerChannel[channel] > 0)
          .map((channel) => recordSends(campaign.tenantUserId, channel, sentPerChannel[channel])),
      );
    }
  }

  if (debited) await maybeNotifyLowBalance(tenantUserId).catch(() => {});
}
