import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { CreateUserRequestBody, CaptivePortalUserDocument, CaptivePortalMarketingDocument, CaptivePortalSessionDocument, ConsentRecord, WifiEvent } from '../types/captive';
import { scheduleSms, toE164 } from '../services/twilio';

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
    } else {
      console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
    }
  } catch (err) {
    console.error('[APMAC LOOKUP ERROR]', err);
  }

  // Reconnect detection
  let existingUserId: string | null = null;
  if (email && captivePortalAccessPointId) {
    try {
      const existingSnap = await db
        .collection('CaptivePortal_Users')
        .where('email', '==', email)
        .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
        .limit(1)
        .get();
      if (!existingSnap.empty) existingUserId = existingSnap.docs[0].id;
    } catch (err) {
      console.error('[RECONNECT LOOKUP ERROR]', err); // non-fatal, falls through as onConnect
    }
  }

  const wifiEvent: WifiEvent = existingUserId ? 'onReconnect' : 'onConnect';
  const marketingOptIn = marketingConsent?.given ?? false;

  let userId: string;

  if (!existingUserId) {
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
      userId = ref.id;
      console.log('[NEW CONNECTION]', userId, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
    } catch (err) {
      console.error('[FIRESTORE ERROR]', err);
      return res.status(500).json({ success: false, message: 'Failed to save user' });
    }
  } else {
    userId = existingUserId;
    console.log('[RECONNECT]', userId, email, captivePortalAccessPointId);
    db.collection('CaptivePortal_Users').doc(userId)
      .update({ connectionCount: FieldValue.increment(1) })
      .catch((err) => console.error('[RECONNECT COUNT ERROR]', err));
  }

  // Session history log (fire-and-forget)
  if (captivePortalAccessPointId) {
    const sessionDoc: CaptivePortalSessionDocument = {
      wifiEvent,
      userId,
      accessPointId: captivePortalAccessPointId,
      mac: mac || '',
      ip: ip || '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
    };
    db.collection('CaptivePortal_Sessions').add(sessionDoc)
      .catch((err) => console.error('[SESSION LOG ERROR]', err));
  }

  // SMS scheduling (event-aware)
  if (marketingOptIn && captivePortalAccessPointId) {
    scheduleSmsForEvent(captivePortalAccessPointId, userId, phone || '', phoneCountryCode || '', wifiEvent)
      .catch((err) => console.error('[SMS SCHEDULE ERROR]', err));
  }

  res.json({ success: true, id: userId });
});

async function scheduleSmsForEvent(
  accessPointId: string,
  userId: string,
  phone: string,
  phoneCountryCode: string,
  wifiEvent: WifiEvent
): Promise<void> {
  const to = toE164(phoneCountryCode, phone);
  if (!to) {
    console.warn('[SMS] Skipping: no valid phone for E.164');
    return;
  }

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) return;
  const data = apDoc.data();
  const smsConfig = data?.events?.[wifiEvent]?.sms;
  if (!smsConfig?.enabled || !smsConfig?.messages?.length) return;

  for (let i = 0; i < smsConfig.messages.length; i++) {
    const msg = smsConfig.messages[i];
    if (!msg.content) continue;

    const delayMinutes = msg.delayMinutes ?? 0;
    const messageSid = await scheduleSms(to, msg.content, delayMinutes);

    if (messageSid) {
      const record: CaptivePortalMarketingDocument = {
        wifiEvent,
        channel: 'sms',
        accessPointId,
        userId,
        messageSid,
        to,
        content: msg.content,
        messageIndex: i,
        delayMinutes,
        sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        scheduledAt: FieldValue.serverTimestamp(),
        deliveryStatus: 'scheduled',
      };
      try {
        await db.collection('CaptivePortal_Marketing').add(record);
      } catch (err) {
        console.error('[MARKETING ANALYTICS ERROR]', err);
      }
    }
  }
}

// TODO: onDisconnect – call scheduleSmsForEvent(accessPointId, userId, phone, phoneCountryCode, 'onDisconnect')
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

const SPLASH_DEFAULTS = {
  title: 'Connect to WiFi',
  subtitle: 'Enter your details to get online',
  logoUrl: '',
  primaryColor: '#1c2b4a',
  backgroundColor: '#ffffff',
  collectEmail: true,
  collectName: true,
  showMarketingOptIn: true,
  showPrivacyPolicy: true,
  showTermsOfService: true,
  redirectUrl: '',
};

router.get('/splash-config', async (req: Request, res: Response) => {
  const { apmac } = req.query as { apmac?: string };

  if (!apmac) return res.json({ success: true, config: SPLASH_DEFAULTS });

  try {
    const apSnap = await db.collection('CaptivePortal_AccessPoints')
      .where('mac', '==', apmac)
      .limit(1)
      .get();

    if (apSnap.empty) return res.json({ success: true, registered: false });

    const ap = apSnap.docs[0].data();
    const configId = `${ap.entityType}_${ap.entityId}`;

    const configDoc = await db.collection('CaptivePortal_SplashScreenConfig').doc(configId).get();
    if (!configDoc.exists) return res.json({ success: true, config: SPLASH_DEFAULTS });

    const config: Record<string, unknown> = { ...SPLASH_DEFAULTS, ...configDoc.data() };
    // strip Firestore-internal fields
    delete config.createdAt;
    delete config.updatedAt;

    res.json({ success: true, config });
  } catch (err) {
    console.error('[SPLASH CONFIG ERROR]', err);
    res.json({ success: true, config: SPLASH_DEFAULTS }); // safe fallback, never 500
  }
});

// POST /radius/authorize — called by FreeRADIUS REST module on every WiFi auth
// Parses the AP MAC from Called-Station-Id, looks up sessionTimeout in Firestore.
// Returns Accept + Session-Timeout if AP is registered, Reject (403) if not.
router.post('/radius/authorize', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    // Called-Station-Id arrives as { value: "AA-BB-CC-DD-EE-FF:SSID" } or plain string
    const rawCalledStation: string =
      (typeof body['Called-Station-Id'] === 'object'
        ? body['Called-Station-Id']?.value
        : body['Called-Station-Id']) || '';

    // Strip SSID suffix (everything after last colon that follows a 2-char hex pair)
    // e.g. "AA-BB-CC-DD-EE-FF:MySSID" → "AA:BB:CC:DD:EE:FF"
    const macPart = rawCalledStation.split(':').slice(0, 6).join(':');
    const normalizedMac = macPart.replace(/-/g, ':').toLowerCase();

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

export default router;
