"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const firebase_1 = require("../firebase");
const firestore_1 = require("firebase-admin/firestore");
const twilio_1 = require("../services/twilio");
const brevo_1 = require("../services/brevo");
const router = (0, express_1.Router)();
const defaultConsent = () => ({
    given: false,
    timestamp: new Date().toISOString(),
    version: '1.0',
});
router.post('/create-user', async (req, res) => {
    const { firstName, lastName, email, phone, phoneCountryCode, mac, apmac, ip, url, post, privacyPolicyConsent, termsConsent, marketingConsent, } = req.body;
    const timestamp = req.body.timestamp || new Date().toISOString();
    let captivePortalAccessPointId = null;
    try {
        const snapshot = await firebase_1.db
            .collection('CaptivePortal_AccessPoints')
            .where('mac', '==', apmac || '')
            .limit(1)
            .get();
        if (!snapshot.empty) {
            captivePortalAccessPointId = snapshot.docs[0].id;
        }
        else {
            console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
        }
    }
    catch (err) {
        console.error('[APMAC LOOKUP ERROR]', err);
    }
    // Reconnect detection
    let existingUserId = null;
    if (email && captivePortalAccessPointId) {
        try {
            const existingSnap = await firebase_1.db
                .collection('CaptivePortal_Users')
                .where('email', '==', email)
                .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
                .limit(1)
                .get();
            if (!existingSnap.empty)
                existingUserId = existingSnap.docs[0].id;
        }
        catch (err) {
            console.error('[RECONNECT LOOKUP ERROR]', err); // non-fatal, falls through as onConnect
        }
    }
    const wifiEvent = existingUserId ? 'onReconnect' : 'onConnect';
    const marketingOptIn = marketingConsent?.given ?? false;
    let userId;
    if (!existingUserId) {
        const doc = {
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
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            captivePortalAccessPointId,
            connectionCount: 1,
            marketingOptIn,
            privacyPolicyConsent: privacyPolicyConsent || defaultConsent(),
            termsConsent: termsConsent || defaultConsent(),
            marketingConsent: marketingConsent || defaultConsent(),
        };
        try {
            const ref = await firebase_1.db.collection('CaptivePortal_Users').add(doc);
            userId = ref.id;
            console.log('[NEW CONNECTION]', userId, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
        }
        catch (err) {
            console.error('[FIRESTORE ERROR]', err);
            return res.status(500).json({ success: false, message: 'Failed to save user' });
        }
    }
    else {
        userId = existingUserId;
        console.log('[RECONNECT]', userId, email, captivePortalAccessPointId);
        firebase_1.db.collection('CaptivePortal_Users').doc(userId)
            .update({ connectionCount: firestore_1.FieldValue.increment(1) })
            .catch((err) => console.error('[RECONNECT COUNT ERROR]', err));
    }
    // Session history log (fire-and-forget)
    if (captivePortalAccessPointId) {
        const sessionDoc = {
            wifiEvent,
            userId,
            accessPointId: captivePortalAccessPointId,
            mac: mac || '',
            ip: ip || '',
            timestamp,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        };
        firebase_1.db.collection('CaptivePortal_Sessions').add(sessionDoc)
            .catch((err) => console.error('[SESSION LOG ERROR]', err));
    }
    // Marketing scheduling (event-aware)
    if (marketingOptIn && captivePortalAccessPointId) {
        scheduleSmsForEvent(captivePortalAccessPointId, userId, phone || '', phoneCountryCode || '', wifiEvent)
            .catch((err) => console.error('[SMS SCHEDULE ERROR]', err));
        scheduleEmailForEvent(captivePortalAccessPointId, userId, email || '', wifiEvent)
            .catch((err) => console.error('[EMAIL SCHEDULE ERROR]', err));
    }
    res.json({ success: true, id: userId });
});
async function scheduleSmsForEvent(accessPointId, userId, phone, phoneCountryCode, wifiEvent) {
    const to = (0, twilio_1.toE164)(phoneCountryCode, phone);
    if (!to) {
        console.warn('[SMS] Skipping: no valid phone for E.164', { phone, phoneCountryCode });
        return;
    }
    const apDoc = await firebase_1.db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
    if (!apDoc.exists) {
        console.warn('[SMS] Skipping: AP doc not found:', accessPointId);
        return;
    }
    const venueId = apDoc.data()?.venueId;
    if (!venueId) {
        console.warn('[SMS] Skipping: AP has no venueId:', accessPointId);
        return;
    }
    const marketingDoc = await firebase_1.db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
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
        if (!msg.content)
            continue;
        const delayMinutes = msg.delayMinutes ?? 0;
        const messageSid = await (0, twilio_1.scheduleSms)(to, msg.content, delayMinutes);
        if (messageSid) {
            console.log('[SMS] Scheduled msg %d for user %s, sid=%s, delay=%d min', i, userId, messageSid, delayMinutes);
            const record = {
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
                scheduledAt: firestore_1.FieldValue.serverTimestamp(),
                deliveryStatus: 'scheduled',
            };
            await firebase_1.db.collection('CaptivePortal_Marketing').add(record)
                .catch((err) => console.error('[MARKETING ANALYTICS ERROR]', err));
        }
    }
}
async function scheduleEmailForEvent(accessPointId, userId, userEmail, wifiEvent) {
    if (!userEmail) {
        console.warn('[EMAIL] Skipping: no email address for user', userId);
        return;
    }
    const apDoc = await firebase_1.db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
    if (!apDoc.exists) {
        console.warn('[EMAIL] Skipping: AP doc not found:', accessPointId);
        return;
    }
    const venueId = apDoc.data()?.venueId;
    if (!venueId) {
        console.warn('[EMAIL] Skipping: AP has no venueId:', accessPointId);
        return;
    }
    const marketingDoc = await firebase_1.db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
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
        if (!msg.subject || !msg.body)
            continue;
        const delayMinutes = msg.delayMinutes ?? 0;
        const messageId = await (0, brevo_1.sendEmail)(userEmail, msg.subject, msg.body, delayMinutes);
        if (messageId) {
            console.log('[EMAIL] Scheduled msg %d for user %s, id=%s, delay=%d min', i, userId, messageId, delayMinutes);
            const record = {
                wifiEvent,
                channel: 'email',
                accessPointId,
                userId,
                messageId,
                to: userEmail,
                subject: msg.subject,
                body: msg.body,
                messageIndex: i,
                delayMinutes,
                sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
                scheduledAt: firestore_1.FieldValue.serverTimestamp(),
                deliveryStatus: 'scheduled',
            };
            await firebase_1.db.collection('CaptivePortal_Marketing').add(record)
                .catch((err) => console.error('[EMAIL ANALYTICS ERROR]', err));
        }
    }
}
// TODO: onDisconnect – call scheduleSmsForEvent / scheduleEmailForEvent
//       when a user disconnects from the WiFi network.
// ── Field names in CaptivePortal_Documents — update if your schema differs ──
const DOC_TYPE_FIELD = 'type'; // field that identifies the document kind
const DOC_PUBLISHED_FIELD = 'published'; // boolean field — true means live
const DOC_TYPE_PRIVACY = 'privacy_policy';
const DOC_TYPE_TERMS = 'terms_of_service';
async function fetchDocument(type) {
    const snapshot = await firebase_1.db
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
        if (!doc)
            return res.status(404).json({ success: false });
        res.json({ success: true, ...doc });
    }
    catch (err) {
        console.error('[PRIVACY POLICY ERROR]', err);
        res.status(500).json({ success: false });
    }
});
router.get('/terms', async (_req, res) => {
    try {
        const doc = await fetchDocument(DOC_TYPE_TERMS);
        if (!doc)
            return res.status(404).json({ success: false });
        res.json({ success: true, ...doc });
    }
    catch (err) {
        console.error('[TERMS ERROR]', err);
        res.status(500).json({ success: false });
    }
});
const SPLASH_DEFAULTS = {
    templateId: 'classic',
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
router.get('/splash-config', async (req, res) => {
    const { apmac } = req.query;
    if (!apmac)
        return res.json({ success: true, config: SPLASH_DEFAULTS });
    try {
        const apSnap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
            .where('mac', '==', apmac)
            .limit(1)
            .get();
        if (apSnap.empty)
            return res.json({ success: true, registered: false });
        const ap = apSnap.docs[0].data();
        const configId = `venue_${ap.venueId}`;
        const configDoc = await firebase_1.db.collection('CaptivePortal_SplashScreenConfig').doc(configId).get();
        if (!configDoc.exists)
            return res.json({ success: true, config: SPLASH_DEFAULTS });
        const config = { ...SPLASH_DEFAULTS, ...configDoc.data() };
        // strip Firestore-internal fields
        delete config.createdAt;
        delete config.updatedAt;
        res.json({ success: true, config });
    }
    catch (err) {
        console.error('[SPLASH CONFIG ERROR]', err);
        res.json({ success: true, config: SPLASH_DEFAULTS }); // safe fallback, never 500
    }
});
// POST /radius/authorize — called by FreeRADIUS REST module on every WiFi auth
// Parses the AP MAC from Called-Station-Id, looks up sessionTimeout in Firestore.
// Returns Accept + Session-Timeout if AP is registered, Reject (403) if not.
router.post('/radius/authorize', async (req, res) => {
    try {
        const body = req.body || {};
        // Called-Station-Id can arrive as plain string, { value: "..." }, or { value: ["..."] }
        let rawValue = typeof body['Called-Station-Id'] === 'object'
            ? body['Called-Station-Id']?.value
            : body['Called-Station-Id'];
        if (Array.isArray(rawValue))
            rawValue = rawValue[0];
        const rawCalledStation = String(rawValue || '');
        // Normalize to AA:BB:CC:DD:EE:FF
        // Handles: "AA-BB-CC-DD-EE-FF:SSID", "AA:BB:CC:DD:EE:FF", "aabbccddeeff"
        let normalizedMac;
        const macPart = rawCalledStation.split(':').slice(0, 6).join(':').replace(/-/g, ':').toLowerCase();
        if (/^[0-9a-f]{12}$/.test(macPart)) {
            // no separators — insert colons every 2 chars
            normalizedMac = macPart.match(/.{2}/g).join(':');
        }
        else {
            normalizedMac = macPart;
        }
        console.log('[RADIUS AUTH]', { rawCalledStation, normalizedMac });
        if (!normalizedMac || normalizedMac.split(':').length !== 6) {
            console.warn('[RADIUS AUTH] Invalid Called-Station-Id:', rawCalledStation);
            return res.status(403).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
        }
        const apSnap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
            .where('mac', '==', normalizedMac)
            .limit(1)
            .get();
        if (apSnap.empty) {
            console.log('[RADIUS AUTH] Unknown AP, rejecting:', normalizedMac);
            return res.status(403).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
        }
        const ap = apSnap.docs[0].data();
        const sessionTimeout = ap.sessionTimeout || 36000;
        console.log('[RADIUS AUTH] Accept AP:', normalizedMac, 'timeout:', sessionTimeout);
        return res.json({
            'control:Auth-Type': { value: 'Accept', op: ':=' },
            'reply:Session-Timeout': { value: sessionTimeout, op: '=' },
        });
    }
    catch (err) {
        console.error('[RADIUS AUTH ERROR]', err);
        return res.status(500).json({ 'control:Auth-Type': { value: 'Reject', op: ':=' } });
    }
});
exports.default = router;
