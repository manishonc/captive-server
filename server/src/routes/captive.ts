import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { CreateUserRequestBody, CaptivePortalUserDocument, CaptivePortalMarketingDocument, CaptivePortalSessionDocument, ConnectedPageField, ConsentRecord, WifiEvent, UnifiAuthorizeRequestBody, UnifiConfig } from '../types/captive';
import { scheduleSms, toE164 } from '../services/twilio';
import { sendEmail } from '../services/brevo';
import { sendWhatsAppTemplate, toE164 as toE164WA, WhatsAppTemplateComponent } from '../services/whatsapp';
import { swapVenueRatingUrl, swapTrackedLinks, createShortLink, VISITOR_BASE_URL, ShortLinkContext } from '../services/shortlinks';
import { authorizeGuest as unifiAuthorizeGuest, effectiveControllerUrl } from '../services/unifi';
import { getVenueName } from '../services/venue';
import { fireAutomationsForGuest } from '../services/campaigns';

const router = Router();

const defaultConsent = (): ConsentRecord => ({
  given: false,
  timestamp: new Date().toISOString(),
  version: '1.0',
});

router.post('/create-user', async (req: Request<{}, {}, CreateUserRequestBody>, res: Response) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    phoneCountryCode,
    mac,
    apmac,
    ip,
    url,
    post,
    privacyPolicyConsent,
    termsConsent,
    marketingConsent,
  } = req.body;
  const timestamp = req.body.timestamp || new Date().toISOString();

  let captivePortalAccessPointId: string | null = null;

  try {
    const snapshot = await db
      .collection('CaptivePortal_AccessPoints')
      .where('mac', '==', apmac || '')
      .limit(1)
      .get();

    if (!snapshot.empty) {
      captivePortalAccessPointId = snapshot.docs[0].id;
      snapshot.docs[0].ref.update({ lastSeen: FieldValue.serverTimestamp() })
        .catch((err) => console.error('[AP LASTSEEN ERROR]', err));
    } else {
      console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
    }
  } catch (err) {
    console.error('[APMAC LOOKUP ERROR]', err);
  }

  // Reconnect detection
  let existingWifiGuestId: string | null = null;
  if (email && captivePortalAccessPointId) {
    try {
      const existingSnap = await db
        .collection('CaptivePortal_Users')
        .where('email', '==', email)
        .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
        .limit(1)
        .get();
      if (!existingSnap.empty) existingWifiGuestId = existingSnap.docs[0].id;
    } catch (err) {
      console.error('[RECONNECT LOOKUP ERROR]', err); // non-fatal, falls through as onConnect
    }
  }

  const wifiEvent: WifiEvent = existingWifiGuestId ? 'onReconnect' : 'onConnect';
  const marketingOptIn = marketingConsent?.given ?? false;

  let wifiGuestId: string;

  if (!existingWifiGuestId) {
    const doc: CaptivePortalUserDocument = {
      firstName: firstName || '',
      lastName: lastName || '',
      email: email || '',
      phone: phone || '',
      phoneCountryCode: phoneCountryCode || '',
      mac: mac || '',
      ip: ip || '',
      url: url || '',
      post: post || '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
      captivePortalAccessPointId,
      connectionCount: 1,
      marketingOptIn,
      privacyPolicyConsent: privacyPolicyConsent || defaultConsent(),
      termsConsent: termsConsent || defaultConsent(),
      marketingConsent: marketingConsent || defaultConsent(),
    };

    try {
      const ref = await db.collection('CaptivePortal_Users').add(doc);
      wifiGuestId = ref.id;
      console.log('[NEW CONNECTION]', wifiGuestId, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
    } catch (err) {
      console.error('[FIRESTORE ERROR]', err);
      return res.status(500).json({ success: false, message: 'Failed to save wifi guest' });
    }
  } else {
    wifiGuestId = existingWifiGuestId;
    console.log('[RECONNECT]', wifiGuestId, email, captivePortalAccessPointId);
    db.collection('CaptivePortal_Users').doc(wifiGuestId)
      .update({ connectionCount: FieldValue.increment(1) })
      .catch((err) => console.error('[RECONNECT COUNT ERROR]', err));
  }

  // Session history log (fire-and-forget)
  if (captivePortalAccessPointId) {
    const sessionDoc: CaptivePortalSessionDocument = {
      wifiEvent,
      wifiGuestId,
      accessPointId: captivePortalAccessPointId,
      mac: mac || '',
      ip: ip || '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
    };
    db.collection('CaptivePortal_Sessions').add(sessionDoc)
      .catch((err) => console.error('[SESSION LOG ERROR]', err));
  }

  // Marketing scheduling (event-aware)
  if (marketingOptIn && captivePortalAccessPointId) {
    scheduleSmsForEvent(captivePortalAccessPointId, wifiGuestId, phone || '', phoneCountryCode || '', wifiEvent)
      .catch((err) => console.error('[SMS SCHEDULE ERROR]', err));
    scheduleEmailForEvent(captivePortalAccessPointId, wifiGuestId, email || '', wifiEvent)
      .catch((err) => console.error('[EMAIL SCHEDULE ERROR]', err));
    scheduleWhatsAppForEvent(captivePortalAccessPointId, wifiGuestId, firstName || '', phone || '', phoneCountryCode || '', wifiEvent)
      .catch((err) => console.error('[WHATSAPP SCHEDULE ERROR]', err));
    // Tenant Campaign Manager: fire any active automation campaigns for this event.
    fireAutomationsForGuest(
      captivePortalAccessPointId,
      wifiGuestId,
      { firstName, lastName, email, phone, phoneCountryCode },
      wifiEvent,
    ).catch((err) => console.error('[CAMPAIGN AUTOMATION ERROR]', err));
  }

  res.json({ success: true, id: wifiGuestId });
});

async function scheduleSmsForEvent(
  accessPointId: string,
  wifiGuestId: string,
  phone: string,
  phoneCountryCode: string,
  wifiEvent: WifiEvent
): Promise<void> {
  const to = toE164(phoneCountryCode, phone);
  if (!to) {
    console.warn('[SMS] Skipping: no valid phone for E.164', { phone, phoneCountryCode });
    return;
  }

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) {
    console.warn('[SMS] Skipping: AP doc not found:', accessPointId);
    return;
  }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) {
    console.warn('[SMS] Skipping: AP has no venueId:', accessPointId);
    return;
  }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) {
    console.warn('[SMS] Skipping: no EntityMarketing doc for venueId:', venueId);
    return;
  }
  const smsConfig = marketingDoc.data()?.events?.[wifiEvent]?.sms;
  if (!smsConfig?.enabled) {
    console.warn('[SMS] Skipping: sms not enabled for event=%s, venue:', wifiEvent, venueId);
    return;
  }
  if (!smsConfig?.messages?.length) {
    console.warn('[SMS] Skipping: sms.messages empty for event=%s, venue:', wifiEvent, venueId);
    return;
  }

  for (let i = 0; i < smsConfig.messages.length; i++) {
    const msg = smsConfig.messages[i];
    if (!msg.content) continue;

    const delayMinutes = msg.delayMinutes ?? 0;

    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = {
      venueId,
      marketingDocId: mRef.id,
      wifiGuestId,
      channel: 'sms',
    };
    const shortCodes: string[] = [];
    let finalContent = msg.content;
    try {
      const rateSwap = await swapVenueRatingUrl(finalContent, ctx);
      finalContent = rateSwap.content;
      if (rateSwap.code) shortCodes.push(rateSwap.code);
      const trackedSwap = await swapTrackedLinks(finalContent, ctx);
      finalContent = trackedSwap.content;
      shortCodes.push(...trackedSwap.codes);
    } catch (err) {
      console.error('[SHORTLINK SWAP ERROR - sms]', err);
    }

    const messageSid = await scheduleSms(to, finalContent, delayMinutes);

    if (messageSid) {
      console.log('[SMS] Scheduled msg %d for wifi guest %s, sid=%s, delay=%d min', i, wifiGuestId, messageSid, delayMinutes);
      const record: CaptivePortalMarketingDocument = {
        wifiEvent,
        channel: 'sms',
        accessPointId,
        wifiGuestId,
        messageSid,
        to,
        content: finalContent,
        messageIndex: i,
        templateMessageId: msg.id || null,
        delayMinutes,
        sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        scheduledAt: FieldValue.serverTimestamp(),
        deliveryStatus: 'scheduled',
        shortCodes,
        clickCount: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        firstVisitId: null,
        visitedAt: null,
        visitCount: 0,
        ratingId: null,
        ratedAt: null,
        rating: null,
      };
      await mRef.set(record)
        .catch((err) => console.error('[MARKETING ANALYTICS ERROR]', err));
    }
  }
}

async function scheduleWhatsAppForEvent(
  accessPointId: string,
  wifiGuestId: string,
  firstName: string,
  phone: string,
  phoneCountryCode: string,
  wifiEvent: WifiEvent
): Promise<void> {
  const to = toE164WA(phoneCountryCode, phone);
  if (!to) {
    console.warn('[WHATSAPP] Skipping: no valid phone for E.164', { phone, phoneCountryCode });
    return;
  }

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) {
    console.warn('[WHATSAPP] Skipping: AP doc not found:', accessPointId);
    return;
  }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) {
    console.warn('[WHATSAPP] Skipping: AP has no venueId:', accessPointId);
    return;
  }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) {
    console.warn('[WHATSAPP] Skipping: no EntityMarketing doc for venueId:', venueId);
    return;
  }

  const whatsappConfig = marketingDoc.data()?.events?.[wifiEvent]?.whatsapp;
  if (!whatsappConfig?.enabled) {
    console.warn('[WHATSAPP] Skipping: whatsapp not enabled for event=%s, venue:', wifiEvent, venueId);
    return;
  }
  if (!whatsappConfig?.messages?.length) {
    console.warn('[WHATSAPP] Skipping: whatsapp.messages empty for event=%s, venue:', wifiEvent, venueId);
    return;
  }

  const venueName: string = await getVenueName(venueId, marketingDoc.data()?.venueName);

  for (let i = 0; i < whatsappConfig.messages.length; i++) {
    const msg = whatsappConfig.messages[i];
    if (!msg.templateName || !msg.languageCode) continue;

    const delayMinutes: number = msg.delayMinutes ?? 0;

    // Pre-allocate the analytics doc so the rating short-link can reference it.
    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = {
      venueId,
      marketingDocId: mRef.id,
      wifiGuestId,
      channel: 'whatsapp',
    };
    const shortCodes: string[] = [];

    // Build components. An admin-supplied components array wins; otherwise inject
    // firstName/venueName into the body ({{1}}/{{2}}) and a freshly-minted tracked
    // short link into the dynamic "Rate Us" URL button. The button base lives in the
    // approved template (https://visit.askheidi.app/), so we pass only the suffix
    // `s/<code>` — identical short-link click tracking as SMS/email.
    let components: WhatsAppTemplateComponent[] | undefined = msg.components;
    if (!components) {
      const built: WhatsAppTemplateComponent[] = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: firstName || 'Guest' },
            { type: 'text', text: venueName || 'our venue' },
          ],
        },
      ];
      try {
        const rateUrl = `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`;
        const code = await createShortLink({ targetType: 'venue-rate', targetUrl: rateUrl, ...ctx });
        shortCodes.push(code);
        built.push({
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [{ type: 'text', text: `s/${code}` }],
        });
      } catch (err) {
        console.error('[SHORTLINK SWAP ERROR - whatsapp]', err);
      }
      components = built;
    }

    // Meta Cloud API has no native scheduling — use setTimeout for short delays
    // For production with long delays, replace with a job queue (e.g. Bull, GCP Tasks)
    const sendFn = async () => {
      const wamid = await sendWhatsAppTemplate(to, {
        templateName: msg.templateName,
        languageCode: msg.languageCode,
        components,
        delayMinutes,
      });

      if (wamid) {
        console.log('[WHATSAPP] Sent msg %d for wifi guest %s, wamid=%s, delay=%d min', i, wifiGuestId, wamid, delayMinutes);
        const record = {
          wifiEvent,
          channel: 'whatsapp' as const,
          accessPointId,
          wifiGuestId,
          wamid,
          to,
          templateName: msg.templateName,
          languageCode: msg.languageCode,
          messageIndex: i,
          templateMessageId: msg.id || null,
          delayMinutes,
          sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
          scheduledAt: FieldValue.serverTimestamp(),
          deliveryStatus: 'sent',
          shortCodes,
          clickCount: 0,
          firstClickedAt: null,
          lastClickedAt: null,
          firstVisitId: null,
          visitedAt: null,
          visitCount: 0,
          ratingId: null,
          ratedAt: null,
          rating: null,
        };
        await mRef.set(record)
          .catch((err) => console.error('[WHATSAPP ANALYTICS ERROR]', err));
      }
    };

    if (delayMinutes > 0) {
      setTimeout(() => {
        sendFn().catch((err) => console.error('[WHATSAPP DELAYED SEND ERROR]', err));
      }, delayMinutes * 60 * 1000);
      console.log('[WHATSAPP] Queued msg %d for wifi guest %s in %d min', i, wifiGuestId, delayMinutes);
    } else {
      await sendFn();
    }
  }
}

async function scheduleEmailForEvent(
  accessPointId: string,
  wifiGuestId: string,
  userEmail: string,
  wifiEvent: WifiEvent
): Promise<void> {
  if (!userEmail) {
    console.warn('[EMAIL] Skipping: no email address for wifi guest', wifiGuestId);
    return;
  }

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) {
    console.warn('[EMAIL] Skipping: AP doc not found:', accessPointId);
    return;
  }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) {
    console.warn('[EMAIL] Skipping: AP has no venueId:', accessPointId);
    return;
  }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) {
    console.warn('[EMAIL] Skipping: no EntityMarketing doc for venueId:', venueId);
    return;
  }
  const emailConfig = marketingDoc.data()?.events?.[wifiEvent]?.email;
  if (!emailConfig?.enabled) {
    console.warn('[EMAIL] Skipping: email not enabled for event=%s, venue:', wifiEvent, venueId);
    return;
  }
  if (!emailConfig?.messages?.length) {
    console.warn('[EMAIL] Skipping: email.messages empty for event=%s, venue:', wifiEvent, venueId);
    return;
  }

  for (let i = 0; i < emailConfig.messages.length; i++) {
    const msg = emailConfig.messages[i];
    if (!msg.subject || !msg.body) continue;

    const delayMinutes = msg.delayMinutes ?? 0;

    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = {
      venueId,
      marketingDocId: mRef.id,
      wifiGuestId,
      channel: 'email',
    };
    const shortCodes: string[] = [];
    let finalBody = msg.body;
    try {
      const rateSwap = await swapVenueRatingUrl(finalBody, ctx);
      finalBody = rateSwap.content;
      if (rateSwap.code) shortCodes.push(rateSwap.code);
      const trackedSwap = await swapTrackedLinks(finalBody, ctx);
      finalBody = trackedSwap.content;
      shortCodes.push(...trackedSwap.codes);
    } catch (err) {
      console.error('[SHORTLINK SWAP ERROR - email]', err);
    }

    const messageId = await sendEmail(userEmail, msg.subject, finalBody, delayMinutes);

    if (messageId) {
      console.log('[EMAIL] Scheduled msg %d for wifi guest %s, id=%s, delay=%d min', i, wifiGuestId, messageId, delayMinutes);
      const record = {
        wifiEvent,
        channel: 'email' as const,
        accessPointId,
        wifiGuestId,
        messageId,
        to: userEmail,
        subject: msg.subject,
        body: finalBody,
        messageIndex: i,
        templateMessageId: msg.id || null,
        delayMinutes,
        sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        scheduledAt: FieldValue.serverTimestamp(),
        deliveryStatus: 'scheduled',
        shortCodes,
        clickCount: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        firstVisitId: null,
        visitedAt: null,
        visitCount: 0,
        ratingId: null,
        ratedAt: null,
        rating: null,
      };
      await mRef.set(record)
        .catch((err) => console.error('[EMAIL ANALYTICS ERROR]', err));
    }
  }
}

// TODO: onDisconnect – call scheduleSmsForEvent / scheduleEmailForEvent
//       when a user disconnects from the WiFi network.

// ── Field names in CaptivePortal_Documents — update if your schema differs ──
const DOC_TYPE_FIELD      = 'type';        // field that identifies the document kind
const DOC_PUBLISHED_FIELD = 'published';   // boolean field — true means live
const DOC_TYPE_PRIVACY    = 'privacy_policy';
const DOC_TYPE_TERMS      = 'terms_of_service';

async function fetchDocument(type: string): Promise<{ title?: string; content?: string } | null> {
  const snapshot = await db
    .collection('CaptivePortal_Documents')
    .where(DOC_TYPE_FIELD, '==', type)
    .where(DOC_PUBLISHED_FIELD, '==', true)
    .limit(1)
    .get();

  if (snapshot.empty) {
    console.warn(`[DOCUMENTS] No published document found for type="${type}"`);
    return null;
  }

  const data = snapshot.docs[0].data();
  console.log(`[DOCUMENTS] Fetched type="${type}" doc=${snapshot.docs[0].id}`);
  return { title: data?.title, content: data?.latestContent };
}

router.get('/privacy-policy', async (_req, res) => {
  try {
    const doc = await fetchDocument(DOC_TYPE_PRIVACY);
    if (!doc) return res.status(404).json({ success: false });
    res.json({ success: true, ...doc });
  } catch (err) {
    console.error('[PRIVACY POLICY ERROR]', err);
    res.status(500).json({ success: false });
  }
});

router.get('/terms', async (_req, res) => {
  try {
    const doc = await fetchDocument(DOC_TYPE_TERMS);
    if (!doc) return res.status(404).json({ success: false });
    res.json({ success: true, ...doc });
  } catch (err) {
    console.error('[TERMS ERROR]', err);
    res.status(500).json({ success: false });
  }
});

const CONNECTED_PAGE_DEFAULTS = {
  title: "You're Connected!",
  subtitle: 'You now have internet access.',
  showTitle: true,
  showSubtitle: true,
  showLogo: true,
  buttonText: 'Open heidifi.ai',
  buttonUrl: 'https://heidifi.ai/',
  showButton: true,
  autoSubmit: false,
  customFields: [] as ConnectedPageField[],
};

const SPLASH_DEFAULTS = {
  templateId: 'classic',
  title: 'Connect to WiFi',
  subtitle: 'Enter your details to get online',
  logoUrl: '',
  showLogo: true,
  primaryColor: '#1c2b4a',
  backgroundColor: '#ffffff',
  collectEmail: true,
  collectName: true,
  showMarketingOptIn: true,
  showPrivacyPolicy: true,
  showTermsOfService: true,
  redirectUrl: '',
  connectedPage: CONNECTED_PAGE_DEFAULTS,
};

router.get('/splash-config', async (req: Request, res: Response) => {
  const { apmac: apmacParam, ap } = req.query as { apmac?: string; ap?: string };
  const apmac = (apmacParam || ap || '').toLowerCase().trim();

  if (!apmac) return res.json({ success: true, config: SPLASH_DEFAULTS });

  try {
    const apSnap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', apmac)
      .limit(1)
      .get();

    if (apSnap.empty) return res.json({ success: true, registered: false });

    const ap = apSnap.docs[0].data();
    const configId = `venue_${ap.venueId}`;

    const configDoc = await db.collection('CaptivePortal_SplashScreenConfig').doc(configId).get();
    if (!configDoc.exists) return res.json({ success: true, config: SPLASH_DEFAULTS });

    const docData = configDoc.data() || {};
    const config: Record<string, unknown> = { ...SPLASH_DEFAULTS, ...docData };
    // The top-level spread is shallow — a partial connectedPage doc would clobber
    // the nested defaults, so merge that object explicitly.
    const docConnected = (docData.connectedPage && typeof docData.connectedPage === 'object' && !Array.isArray(docData.connectedPage))
      ? docData.connectedPage
      : {};
    const connectedPage = { ...CONNECTED_PAGE_DEFAULTS, ...docConnected };
    if (!Array.isArray(connectedPage.customFields)) connectedPage.customFields = [];
    config.connectedPage = connectedPage;
    // strip Firestore-internal fields
    delete config.createdAt;
    delete config.updatedAt;

    res.json({ success: true, config });
  } catch (err) {
    console.error('[SPLASH CONFIG ERROR]', err);
    res.json({ success: true, config: SPLASH_DEFAULTS }); // safe fallback, never 500
  }
});

// ── Connected-page custom form submissions ─────────────────────────────────
// Guests are anonymous here (no auth token), so abuse is bounded by a small
// in-memory sliding window keyed on client MAC + IP.
const connectedFormHits = new Map<string, number[]>();
const CONNECTED_FORM_WINDOW_MS = 60_000;
// Auto-save mode posts on every checkbox toggle / text blur, so the window
// allows a burst of legitimate interactions.
const CONNECTED_FORM_MAX_PER_WINDOW = 10;
const FIELD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function connectedFormRateLimited(key: string): boolean {
  const now = Date.now();
  if (connectedFormHits.size > 1000) {
    for (const [k, times] of connectedFormHits) {
      if (times.every((t) => now - t >= CONNECTED_FORM_WINDOW_MS)) connectedFormHits.delete(k);
    }
  }
  const hits = (connectedFormHits.get(key) || []).filter((t) => now - t < CONNECTED_FORM_WINDOW_MS);
  if (hits.length >= CONNECTED_FORM_MAX_PER_WINDOW) {
    connectedFormHits.set(key, hits);
    return true;
  }
  hits.push(now);
  connectedFormHits.set(key, hits);
  return false;
}

// POST /connected-form — store custom-field answers from the connected page onto
// the guest's CaptivePortal_Users doc (matched by client MAC). Every soft failure
// (unknown AP, guest not found, no valid fields) returns 200 { stored: false } —
// the guest already has internet; their UX must never error here.
router.post('/connected-form', async (req: Request, res: Response) => {
  const { apmac: rawApmac, mac: rawMac, responses } = (req.body || {}) as {
    apmac?: string; mac?: string; responses?: Record<string, unknown>;
  };
  const apmac = String(rawApmac || '').toLowerCase().trim();
  const mac = String(rawMac || '').toLowerCase().trim();

  if (connectedFormRateLimited(`${mac || 'nomac'}|${req.ip || ''}`)) {
    return res.status(429).json({ success: false, message: 'Too many submissions' });
  }

  if (!apmac || !mac || !responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return res.json({ success: true, stored: false });
  }
  const entries = Object.entries(responses);
  if (entries.length === 0 || entries.length > 20) {
    return res.json({ success: true, stored: false });
  }

  try {
    const apSnap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', apmac)
      .limit(1)
      .get();
    if (apSnap.empty) {
      console.warn('[CONNECTED FORM] Unknown AP:', apmac);
      return res.json({ success: true, stored: false });
    }
    const venueId = apSnap.docs[0].data().venueId;
    if (!venueId) return res.json({ success: true, stored: false });

    const configDoc = await db.collection('CaptivePortal_SplashScreenConfig').doc(`venue_${venueId}`).get();
    const configuredFields: ConnectedPageField[] = Array.isArray(configDoc.data()?.connectedPage?.customFields)
      ? configDoc.data()!.connectedPage.customFields
      : [];
    const fieldById = new Map(
      configuredFields
        .filter((f) => f && f.enabled !== false && typeof f.id === 'string' && FIELD_ID_PATTERN.test(f.id))
        .map((f) => [f.id, f]),
    );

    const submittedAt = new Date().toISOString();
    const updates: Record<string, unknown> = {};
    for (const [id, raw] of entries) {
      const field = fieldById.get(id);
      if (!field) continue; // unknown, disabled, or since-deleted field — drop silently
      const value = field.type === 'checkbox' ? Boolean(raw) : String(raw ?? '').slice(0, 500);
      updates[`connectedFormResponses.${id}`] = {
        value,
        label: String(field.label || '').slice(0, 80),
        submittedAt,
      };
    }
    const storedCount = Object.keys(updates).length;
    if (storedCount === 0) {
      return res.json({ success: true, stored: false });
    }

    // Newest guest doc for this client MAC. No composite mac+createdAt index
    // exists — result sets per MAC are tiny, so sort in memory by the ISO timestamp.
    const userSnap = await db.collection('CaptivePortal_Users').where('mac', '==', mac).get();
    if (userSnap.empty) {
      console.warn('[CONNECTED FORM] No guest found for mac:', mac);
      return res.json({ success: true, stored: false });
    }
    const newest = userSnap.docs.reduce((a, b) =>
      String(a.data().timestamp || '') >= String(b.data().timestamp || '') ? a : b);

    updates.connectedFormUpdatedAt = FieldValue.serverTimestamp();
    await newest.ref.update(updates);
    console.log('[CONNECTED FORM] Stored %d responses for guest %s', storedCount, newest.id);
    return res.json({ success: true, stored: true });
  } catch (err) {
    console.error('[CONNECTED FORM ERROR]', err);
    return res.json({ success: true, stored: false });
  }
});

// POST /radius/authorize — called by FreeRADIUS REST module on every WiFi auth
// Parses the AP MAC from Called-Station-Id, looks up sessionTimeout in Firestore.
// Returns Accept + Session-Timeout if AP is registered, Reject (403) if not.
router.post('/radius/authorize', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    // Called-Station-Id can arrive as plain string, { value: "..." }, or { value: ["..."] }
    let rawValue = typeof body['Called-Station-Id'] === 'object'
      ? body['Called-Station-Id']?.value
      : body['Called-Station-Id'];
    if (Array.isArray(rawValue)) rawValue = rawValue[0];
    const rawCalledStation: string = String(rawValue || '');

    // Normalize to AA:BB:CC:DD:EE:FF
    // Handles: "AA-BB-CC-DD-EE-FF:SSID", "AA:BB:CC:DD:EE:FF", "aabbccddeeff"
    let normalizedMac: string;
    const macPart = rawCalledStation.split(':').slice(0, 6).join(':').replace(/-/g, ':').toLowerCase();
    if (/^[0-9a-f]{12}$/.test(macPart)) {
      // no separators — insert colons every 2 chars
      normalizedMac = macPart.match(/.{2}/g)!.join(':');
    } else {
      normalizedMac = macPart;
    }

    console.log('[RADIUS AUTH]', { rawCalledStation, normalizedMac });

    if (!normalizedMac || normalizedMac.split(':').length !== 6) {
      console.warn('[RADIUS AUTH] Invalid Called-Station-Id:', rawCalledStation);
      return res.status(403).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
    }

    const apSnap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', normalizedMac)
      .limit(1)
      .get();

    if (apSnap.empty) {
      console.log('[RADIUS AUTH] Unknown AP, rejecting:', normalizedMac);
      return res.status(403).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
    }

    const ap = apSnap.docs[0].data();
    const sessionTimeout: number = ap.sessionTimeout || 36000;
    apSnap.docs[0].ref.update({ lastSeen: FieldValue.serverTimestamp() })
      .catch((err) => console.error('[AP LASTSEEN ERROR]', err));

    console.log('[RADIUS AUTH] Accept AP:', normalizedMac, 'timeout:', sessionTimeout);

    return res.json({
      'control:Auth-Type': { value: 'Accept', op: ':=' },
      'reply:Session-Timeout': { value: sessionTimeout, op: '=' },
    });
  } catch (err) {
    console.error('[RADIUS AUTH ERROR]', err);
    return res.status(500).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
  }
});

router.post('/unifi/authorize', async (req: Request<{}, {}, UnifiAuthorizeRequestBody>, res: Response) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    phoneCountryCode,
    clientMac,
    apMac,
    url,
    ssid,
    privacyPolicyConsent,
    termsConsent,
    marketingConsent,
  } = req.body;
  const timestamp = req.body.timestamp || new Date().toISOString();

  if (!clientMac || !apMac) {
    return res.status(400).json({ success: false, message: 'clientMac and apMac are required' });
  }

  const normalizedApMac = String(apMac).toLowerCase().trim();
  const normalizedClientMac = String(clientMac).toLowerCase().trim();

  // Look up AP by MAC to get unifiConfig + venueId
  let captivePortalAccessPointId: string | null = null;
  let unifiConfig: UnifiConfig | null = null;
  let sessionTimeoutSeconds = 36000;

  try {
    const apSnap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', normalizedApMac)
      .limit(1)
      .get();

    if (apSnap.empty) {
      console.warn('[UNIFI AUTH] Unknown AP:', normalizedApMac);
      return res.status(403).json({ success: false, message: 'Access point not registered' });
    }

    const apDoc = apSnap.docs[0];
    const apData = apDoc.data();
    captivePortalAccessPointId = apDoc.id;
    sessionTimeoutSeconds = apData.sessionTimeout || 36000;

    if (!apData.unifiConfig?.controllerUrl || !apData.unifiConfig?.username || !apData.unifiConfig?.password) {
      console.error('[UNIFI AUTH] AP missing unifiConfig:', normalizedApMac);
      return res.status(500).json({ success: false, message: 'AP controller not configured' });
    }

    unifiConfig = {
      controllerType: apData.unifiConfig.controllerType || 'classic',
      // captive-server dials the controller's INTERNAL address (UNIFI_CONTROLLER_URL
      // env) — the stored URL is the public one for the admin browser.
      controllerUrl: effectiveControllerUrl(apData.unifiConfig.controllerUrl),
      site: apData.unifiConfig.site || 'default',
      username: apData.unifiConfig.username,
      password: apData.unifiConfig.password,
    };

    apDoc.ref.update({ lastSeen: FieldValue.serverTimestamp() })
      .catch((err) => console.error('[AP LASTSEEN ERROR]', err));
  } catch (err) {
    console.error('[UNIFI AUTH] AP lookup error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }

  // Call UniFi controller to authorize the guest device
  try {
    const minutes = Math.round(sessionTimeoutSeconds / 60);
    await unifiAuthorizeGuest(unifiConfig!, normalizedClientMac, minutes);
  } catch (err) {
    console.error('[UNIFI AUTH] Controller authorize failed:', err);
    return res.status(502).json({ success: false, message: 'Failed to authorize with UniFi controller' });
  }

  // Reconnect detection
  let existingWifiGuestId: string | null = null;
  if (email && captivePortalAccessPointId) {
    try {
      const existingSnap = await db.collection('CaptivePortal_Users')
        .where('email', '==', email)
        .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
        .limit(1)
        .get();
      if (!existingSnap.empty) existingWifiGuestId = existingSnap.docs[0].id;
    } catch (err) {
      console.error('[UNIFI AUTH] Reconnect lookup error:', err);
    }
  }

  const wifiEvent: WifiEvent = existingWifiGuestId ? 'onReconnect' : 'onConnect';
  const marketingOptIn = marketingConsent?.given ?? false;
  let wifiGuestId: string;

  if (!existingWifiGuestId) {
    const doc: CaptivePortalUserDocument = {
      firstName: firstName || '',
      lastName: lastName || '',
      email: email || '',
      phone: phone || '',
      phoneCountryCode: phoneCountryCode || '',
      mac: normalizedClientMac,
      ip: '',
      url: url || '',
      post: '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
      captivePortalAccessPointId,
      connectionCount: 1,
      marketingOptIn,
      privacyPolicyConsent: privacyPolicyConsent || defaultConsent(),
      termsConsent: termsConsent || defaultConsent(),
      marketingConsent: marketingConsent || defaultConsent(),
    };

    try {
      const ref = await db.collection('CaptivePortal_Users').add(doc);
      wifiGuestId = ref.id;
      console.log('[UNIFI] New connection', wifiGuestId, email, normalizedApMac);
    } catch (err) {
      console.error('[UNIFI AUTH] Firestore write error:', err);
      // Auth already granted — return success even if DB write fails
      return res.json({ success: true });
    }
  } else {
    wifiGuestId = existingWifiGuestId;
    console.log('[UNIFI] Reconnect', wifiGuestId, email, normalizedApMac);
    db.collection('CaptivePortal_Users').doc(wifiGuestId)
      .update({ connectionCount: FieldValue.increment(1) })
      .catch((err) => console.error('[UNIFI RECONNECT COUNT ERROR]', err));
  }

  if (captivePortalAccessPointId) {
    const sessionDoc: CaptivePortalSessionDocument = {
      wifiEvent,
      wifiGuestId,
      accessPointId: captivePortalAccessPointId,
      mac: normalizedClientMac,
      ip: '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
    };
    db.collection('CaptivePortal_Sessions').add(sessionDoc)
      .catch((err) => console.error('[UNIFI SESSION LOG ERROR]', err));
  }

  if (marketingOptIn && captivePortalAccessPointId) {
    scheduleSmsForEvent(captivePortalAccessPointId, wifiGuestId, phone || '', phoneCountryCode || '', wifiEvent)
      .catch((err) => console.error('[UNIFI SMS SCHEDULE ERROR]', err));
    scheduleEmailForEvent(captivePortalAccessPointId, wifiGuestId, email || '', wifiEvent)
      .catch((err) => console.error('[UNIFI EMAIL SCHEDULE ERROR]', err));
    scheduleWhatsAppForEvent(captivePortalAccessPointId, wifiGuestId, firstName || '', phone || '', phoneCountryCode || '', wifiEvent)
      .catch((err) => console.error('[UNIFI WHATSAPP SCHEDULE ERROR]', err));
    // Tenant Campaign Manager: fire any active automation campaigns for this event.
    fireAutomationsForGuest(
      captivePortalAccessPointId,
      wifiGuestId,
      { firstName, email, phone, phoneCountryCode },
      wifiEvent,
    ).catch((err) => console.error('[UNIFI CAMPAIGN AUTOMATION ERROR]', err));
  }

  return res.json({ success: true, id: wifiGuestId });
});

router.post('/ap-heartbeat', async (req: Request, res: Response) => {
  const { mac, secret } = req.body || {};

  if (!process.env.AP_HEARTBEAT_SECRET || secret !== process.env.AP_HEARTBEAT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!mac) {
    return res.status(400).json({ error: 'mac is required' });
  }

  const normalizedMac = String(mac).toLowerCase().trim();

  try {
    const snap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', normalizedMac)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: 'Access point not found' });
    }

    await snap.docs[0].ref.update({ lastSeen: FieldValue.serverTimestamp(), status: 'online' });
    console.log('[HEARTBEAT] AP checked in:', normalizedMac);
    return res.json({ success: true });
  } catch (err) {
    console.error('[HEARTBEAT ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
