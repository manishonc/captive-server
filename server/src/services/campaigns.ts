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
import { getVenueName } from './venue';
import {
  VISITOR_BASE_URL,
  createShortLink,
  swapVenueRatingUrl,
  swapTrackedLinks,
} from './shortlinks';

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
/** Public base URL for the open-tracking pixel (email only). No tracking if unset. */
const TRACKING_BASE = (process.env.SERVER_PUBLIC_URL || '').replace(/\/$/, '');

/** Append a 1×1 open-tracking pixel to an email body, keyed by the send id. */
function injectOpenPixel(body: string, sendId: string): string {
  if (!TRACKING_BASE) return body;
  const pixel = `<img src="${TRACKING_BASE}/t/o/${sendId}" width="1" height="1" alt="" style="display:none" />`;
  return `${body}${pixel}`;
}

type Channel = 'email' | 'sms' | 'whatsapp';

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
}

interface CampaignSegment {
  venueIds?: string[];
  entityType?: string;
  signedUpAfter?: string;
  signedUpBefore?: string;
}

interface CampaignTrigger {
  kind?: 'wifiEvent' | 'dateRelative';
  wifiEvent?: 'onConnect' | 'onReconnect' | 'onDisconnect';
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
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Opted-in = active + explicitly opted in + consent not explicitly withdrawn. */
function isOptedIn(u: any): boolean {
  if (u.status === 'archived') return false;
  if (u.marketingConsent && u.marketingConsent.given === false) return false;
  return u.marketingOptIn === true || (u.marketingConsent && u.marketingConsent.given === true);
}

/** Replace {{token}} placeholders from a per-guest context. Unknowns → empty. */
function interpolate(tpl: string, ctx: Record<string, string>): string {
  if (!tpl) return tpl;
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

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

  const out: AudienceMember[] = [];
  const seen = new Set<string>();

  await Promise.all(
    chunk(apIds, FIRESTORE_IN_LIMIT).map(async (ids) => {
      const snap = await db.collection(USERS).where('captivePortalAccessPointId', 'in', ids).get();
      snap.forEach((doc) => {
        if (out.length >= MAX_AUDIENCE) return;
        const u = doc.data();
        if (seen.has(doc.id)) return;
        if (!isOptedIn(u)) return;
        if (wantEntityType && u.entityType !== wantEntityType) return;
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
        });
      });
    }),
  );

  // Hard cap: the per-iteration check above is best-effort across concurrent
  // chunk queries, so enforce the ceiling once collection completes.
  return out.length > MAX_AUDIENCE ? out.slice(0, MAX_AUDIENCE) : out;
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
  msg: CampaignMessage,
  member: AudienceMember,
  venueNameCache: Map<string, string>,
  sendId: string,
): Promise<DispatchOutcome> {
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
  };
  const linkCtx = {
    venueId,
    marketingDocId: `campaign_${campaign.id}`,
    wifiGuestId: member.guestId,
    channel: msg.channel,
  };

  const scheduledForSend = msg.delayMinutes > 0;

  if (msg.channel === 'email') {
    if (!member.email) return { ok: false, status: 'failed', reason: 'no_email' };
    const subject = interpolate(String(msg.subject ?? ''), ctx);
    let body = interpolate(String(msg.body ?? ''), ctx);
    const rateSwap = await swapVenueRatingUrl(body, linkCtx);
    body = rateSwap.content;
    const trackedSwap = await swapTrackedLinks(body, linkCtx);
    body = trackedSwap.content;
    body = injectOpenPixel(body, sendId);
    const id = await sendEmail(member.email, subject || '(no subject)', body, msg.delayMinutes);
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
): Promise<{ ok: boolean }> {
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
  return { ok: outcome.ok };
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

  // One unit of work per (message, guest).
  const work: Array<{ msg: CampaignMessage; member: AudienceMember; messageIndex: number }> = [];
  messages.forEach((msg, messageIndex) => {
    for (const member of audience) work.push({ msg, member, messageIndex });
  });

  await pMap(work, DISPATCH_CONCURRENCY, async ({ msg, member, messageIndex }) => {
    const r = await recordAndDispatch(campaign, msg, messageIndex, member, venueNameCache);
    if (r.ok) sent += 1;
    else failed += 1;
  });

  await ref.update({
    status: 'sent',
    'stats.sent': FieldValue.increment(sent),
    sentAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[CAMPAIGN] ${campaign.id} dispatched: ${sent} sent, ${failed} failed (audience ${audience.length})`);
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
 */
async function claimForSending(
  campaignId: string,
  tenantUserId: string,
): Promise<{ ok: true; campaign: CampaignDoc } | { ok: false; reason: string }> {
  const ref = db.collection(CAMPAIGNS).doc(campaignId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false as const, reason: 'not_found' };
    const data = snap.data() as CampaignDoc;
    if (data.tenantUserId !== tenantUserId) return { ok: false as const, reason: 'forbidden' };
    if (data.type !== 'broadcast') return { ok: false as const, reason: 'not_broadcast' };
    if (!['draft', 'scheduled'].includes(data.status)) {
      return { ok: false as const, reason: `cannot_send_from_${data.status}` };
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
): Promise<{ ok: boolean; status?: string; scheduledFor?: string; error?: string }> {
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
  if (!claim.ok) return { ok: false, error: claim.reason };

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

/** Run any scheduled broadcasts whose send time has arrived. Called by the cron. */
export async function runDueScheduledCampaigns(): Promise<void> {
  const snap = await db.collection(CAMPAIGNS).where('status', '==', 'scheduled').get();
  const now = Date.now();
  for (const doc of snap.docs) {
    const data = doc.data() as CampaignDoc;
    const sendAt = data.schedule?.sendAt;
    if (!sendAt || new Date(sendAt).getTime() > now) continue;
    const claim = await claimForSending(doc.id, data.tenantUserId);
    if (!claim.ok) continue;
    dispatchCampaign(claim.campaign).catch(async (err) => {
      console.error(`[CAMPAIGN] scheduled dispatch failed for ${doc.id}:`, err);
      await doc.ref.update({ status: 'scheduled', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
  }
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
  fields: { firstName?: string; lastName?: string; email?: string; phone?: string; phoneCountryCode?: string },
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
  };
  const venueNameCache = new Map<string, string>();

  for (const doc of snap.docs) {
    const campaign = { id: doc.id, ...(doc.data() as Omit<CampaignDoc, 'id'>) };
    if (campaign.status !== 'active' || campaign.type !== 'automation') continue;
    const trigger = campaign.trigger;
    // Phase 4 fires Wi-Fi-event automations; date-relative triggers are handled
    // by a daily scan (future) and skipped here.
    if (!trigger || trigger.kind !== 'wifiEvent' || trigger.wifiEvent !== wifiEvent) continue;

    const seg = campaign.segment || {};
    if (seg.venueIds && seg.venueIds.length > 0 && !seg.venueIds.includes(venueId)) continue;

    const messages = (campaign.messages || []).filter((m) => campaign.channels.includes(m.channel));
    let sent = 0;
    for (let i = 0; i < messages.length; i++) {
      const r = await recordAndDispatch(campaign, messages[i], i, member, venueNameCache, {
        wifiEvent,
        source: 'automation',
      });
      if (r.ok) sent += 1;
    }
    if (sent > 0) {
      await doc.ref
        .update({ 'stats.sent': FieldValue.increment(sent) })
        .catch((err) => console.error('[CAMPAIGN AUTOMATION stats]', err));
    }
  }
}
