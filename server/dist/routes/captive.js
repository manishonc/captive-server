"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const firebase_1 = require("../firebase");
const firestore_1 = require("firebase-admin/firestore");
const twilio_1 = require("../services/twilio");
const brevo_1 = require("../services/brevo");
const whatsapp_1 = require("../services/whatsapp");
const shortlinks_1 = require("../services/shortlinks");
const unifi_1 = require("../services/unifi");
const venue_1 = require("../services/venue");
const campaigns_1 = require("../services/campaigns");
const router = (0, express_1.Router)();
const defaultConsent = () => ({
    given: false,
    timestamp: new Date().toISOString(),
    version: '1.0',
});
const FIELD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Validate raw splash custom-field answers ({fieldId: value}) against the venue's
// configured loginPage.customFields — same rules as /connected-form. Unknown,
// disabled, or malformed ids are dropped silently; returns {} when nothing valid
// remains so callers can skip the write entirely.
async function buildSplashFormResponses(venueId, raw) {
    if (!venueId || !raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > 20)
        return {};
    try {
        const configDoc = await firebase_1.db.collection('CaptivePortal_SplashScreenConfig').doc(`venue_${venueId}`).get();
        const configuredFields = Array.isArray(configDoc.data()?.loginPage?.customFields)
            ? configDoc.data().loginPage.customFields
            : [];
        const fieldById = new Map(configuredFields
            .filter((f) => f && f.enabled !== false && typeof f.id === 'string' && FIELD_ID_PATTERN.test(f.id))
            .map((f) => [f.id, f]));
        const submittedAt = new Date().toISOString();
        const responses = {};
        for (const [id, value] of entries) {
            const field = fieldById.get(id);
            if (!field)
                continue;
            responses[id] = {
                value: field.type === 'checkbox' ? Boolean(value) : String(value ?? '').slice(0, 500),
                label: String(field.label || '').slice(0, 80),
                submittedAt,
            };
        }
        return responses;
    }
    catch (err) {
        console.error('[SPLASH RESPONSES ERROR]', err);
        return {};
    }
}
router.post('/create-user', async (req, res) => {
    const { firstName, lastName, email, phone, phoneCountryCode, mac, apmac, ip, url, post, privacyPolicyConsent, termsConsent, marketingConsent, } = req.body;
    const timestamp = req.body.timestamp || new Date().toISOString();
    let captivePortalAccessPointId = null;
    let venueId = null;
    try {
        const snapshot = await firebase_1.db
            .collection('CaptivePortal_AccessPoints')
            .where('mac', '==', apmac || '')
            .limit(1)
            .get();
        if (!snapshot.empty) {
            captivePortalAccessPointId = snapshot.docs[0].id;
            venueId = snapshot.docs[0].data().venueId || null;
            snapshot.docs[0].ref.update({ lastSeen: firestore_1.FieldValue.serverTimestamp() })
                .catch((err) => console.error('[AP LASTSEEN ERROR]', err));
        }
        else {
            console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
        }
    }
    catch (err) {
        console.error('[APMAC LOOKUP ERROR]', err);
    }
    // Reconnect detection
    let existingWifiGuestId = null;
    if (email && captivePortalAccessPointId) {
        try {
            const existingSnap = await firebase_1.db
                .collection('CaptivePortal_Users')
                .where('email', '==', email)
                .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
                .limit(1)
                .get();
            if (!existingSnap.empty)
                existingWifiGuestId = existingSnap.docs[0].id;
        }
        catch (err) {
            console.error('[RECONNECT LOOKUP ERROR]', err); // non-fatal, falls through as onConnect
        }
    }
    const wifiEvent = existingWifiGuestId ? 'onReconnect' : 'onConnect';
    const marketingOptIn = marketingConsent?.given ?? false;
    const splashFormResponses = await buildSplashFormResponses(venueId, req.body.splashResponses);
    let wifiGuestId;
    if (!existingWifiGuestId) {
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
            ...(Object.keys(splashFormResponses).length ? { splashFormResponses } : {}),
        };
        try {
            const ref = await firebase_1.db.collection('CaptivePortal_Users').add(doc);
            wifiGuestId = ref.id;
            console.log('[NEW CONNECTION]', wifiGuestId, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
        }
        catch (err) {
            console.error('[FIRESTORE ERROR]', err);
            return res.status(500).json({ success: false, message: 'Failed to save wifi guest' });
        }
    }
    else {
        wifiGuestId = existingWifiGuestId;
        console.log('[RECONNECT]', wifiGuestId, email, captivePortalAccessPointId);
        // Merge any fresh splash answers via field paths so repeat visitors don't
        // wipe earlier responses to fields they skipped this time.
        const reconnectUpdates = { connectionCount: firestore_1.FieldValue.increment(1) };
        for (const [id, response] of Object.entries(splashFormResponses)) {
            reconnectUpdates[`splashFormResponses.${id}`] = response;
        }
        firebase_1.db.collection('CaptivePortal_Users').doc(wifiGuestId)
            .update(reconnectUpdates)
            .catch((err) => console.error('[RECONNECT COUNT ERROR]', err));
    }
    // Session history log (fire-and-forget)
    if (captivePortalAccessPointId) {
        const sessionDoc = {
            wifiEvent,
            wifiGuestId,
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
        scheduleSmsForEvent(captivePortalAccessPointId, wifiGuestId, phone || '', phoneCountryCode || '', wifiEvent)
            .catch((err) => console.error('[SMS SCHEDULE ERROR]', err));
        scheduleEmailForEvent(captivePortalAccessPointId, wifiGuestId, email || '', wifiEvent)
            .catch((err) => console.error('[EMAIL SCHEDULE ERROR]', err));
        scheduleWhatsAppForEvent(captivePortalAccessPointId, wifiGuestId, firstName || '', phone || '', phoneCountryCode || '', wifiEvent)
            .catch((err) => console.error('[WHATSAPP SCHEDULE ERROR]', err));
        // Tenant Campaign Manager: fire any active automation campaigns for this event.
        (0, campaigns_1.fireAutomationsForGuest)(captivePortalAccessPointId, wifiGuestId, { firstName, lastName, email, phone, phoneCountryCode }, wifiEvent).catch((err) => console.error('[CAMPAIGN AUTOMATION ERROR]', err));
    }
    res.json({ success: true, id: wifiGuestId });
});
async function scheduleSmsForEvent(accessPointId, wifiGuestId, phone, phoneCountryCode, wifiEvent) {
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
        const mRef = firebase_1.db.collection('CaptivePortal_Marketing').doc();
        const ctx = {
            venueId,
            marketingDocId: mRef.id,
            wifiGuestId,
            channel: 'sms',
        };
        const shortCodes = [];
        let finalContent = msg.content;
        try {
            const rateSwap = await (0, shortlinks_1.swapVenueRatingUrl)(finalContent, ctx);
            finalContent = rateSwap.content;
            if (rateSwap.code)
                shortCodes.push(rateSwap.code);
            const trackedSwap = await (0, shortlinks_1.swapTrackedLinks)(finalContent, ctx);
            finalContent = trackedSwap.content;
            shortCodes.push(...trackedSwap.codes);
        }
        catch (err) {
            console.error('[SHORTLINK SWAP ERROR - sms]', err);
        }
        const messageSid = await (0, twilio_1.scheduleSms)(to, finalContent, delayMinutes);
        if (messageSid) {
            console.log('[SMS] Scheduled msg %d for wifi guest %s, sid=%s, delay=%d min', i, wifiGuestId, messageSid, delayMinutes);
            const record = {
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
                scheduledAt: firestore_1.FieldValue.serverTimestamp(),
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
async function scheduleWhatsAppForEvent(accessPointId, wifiGuestId, firstName, phone, phoneCountryCode, wifiEvent) {
    const to = (0, whatsapp_1.toE164)(phoneCountryCode, phone);
    if (!to) {
        console.warn('[WHATSAPP] Skipping: no valid phone for E.164', { phone, phoneCountryCode });
        return;
    }
    const apDoc = await firebase_1.db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
    if (!apDoc.exists) {
        console.warn('[WHATSAPP] Skipping: AP doc not found:', accessPointId);
        return;
    }
    const venueId = apDoc.data()?.venueId;
    if (!venueId) {
        console.warn('[WHATSAPP] Skipping: AP has no venueId:', accessPointId);
        return;
    }
    const marketingDoc = await firebase_1.db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
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
    const venueName = await (0, venue_1.getVenueName)(venueId, marketingDoc.data()?.venueName);
    for (let i = 0; i < whatsappConfig.messages.length; i++) {
        const msg = whatsappConfig.messages[i];
        if (!msg.templateName || !msg.languageCode)
            continue;
        const delayMinutes = msg.delayMinutes ?? 0;
        // Pre-allocate the analytics doc so the rating short-link can reference it.
        const mRef = firebase_1.db.collection('CaptivePortal_Marketing').doc();
        const ctx = {
            venueId,
            marketingDocId: mRef.id,
            wifiGuestId,
            channel: 'whatsapp',
        };
        const shortCodes = [];
        // Build components. An admin-supplied components array wins; otherwise inject
        // firstName/venueName into the body ({{1}}/{{2}}) and a freshly-minted tracked
        // short link into the dynamic "Rate Us" URL button. The button base lives in the
        // approved template (https://visit.askheidi.app/), so we pass only the suffix
        // `s/<code>` — identical short-link click tracking as SMS/email.
        let components = msg.components;
        if (!components) {
            const built = [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: firstName || 'Guest' },
                        { type: 'text', text: venueName || 'our venue' },
                    ],
                },
            ];
            try {
                const rateUrl = `${shortlinks_1.VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`;
                const code = await (0, shortlinks_1.createShortLink)({ targetType: 'venue-rate', targetUrl: rateUrl, ...ctx });
                shortCodes.push(code);
                built.push({
                    type: 'button',
                    sub_type: 'url',
                    index: 0,
                    parameters: [{ type: 'text', text: `s/${code}` }],
                });
            }
            catch (err) {
                console.error('[SHORTLINK SWAP ERROR - whatsapp]', err);
            }
            components = built;
        }
        // Meta Cloud API has no native scheduling — use setTimeout for short delays
        // For production with long delays, replace with a job queue (e.g. Bull, GCP Tasks)
        const sendFn = async () => {
            const wamid = await (0, whatsapp_1.sendWhatsAppTemplate)(to, {
                templateName: msg.templateName,
                languageCode: msg.languageCode,
                components,
                delayMinutes,
            });
            if (wamid) {
                console.log('[WHATSAPP] Sent msg %d for wifi guest %s, wamid=%s, delay=%d min', i, wifiGuestId, wamid, delayMinutes);
                const record = {
                    wifiEvent,
                    channel: 'whatsapp',
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
                    scheduledAt: firestore_1.FieldValue.serverTimestamp(),
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
        }
        else {
            await sendFn();
        }
    }
}
async function scheduleEmailForEvent(accessPointId, wifiGuestId, userEmail, wifiEvent) {
    if (!userEmail) {
        console.warn('[EMAIL] Skipping: no email address for wifi guest', wifiGuestId);
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
        const mRef = firebase_1.db.collection('CaptivePortal_Marketing').doc();
        const ctx = {
            venueId,
            marketingDocId: mRef.id,
            wifiGuestId,
            channel: 'email',
        };
        const shortCodes = [];
        let finalBody = msg.body;
        try {
            const rateSwap = await (0, shortlinks_1.swapVenueRatingUrl)(finalBody, ctx);
            finalBody = rateSwap.content;
            if (rateSwap.code)
                shortCodes.push(rateSwap.code);
            const trackedSwap = await (0, shortlinks_1.swapTrackedLinks)(finalBody, ctx);
            finalBody = trackedSwap.content;
            shortCodes.push(...trackedSwap.codes);
        }
        catch (err) {
            console.error('[SHORTLINK SWAP ERROR - email]', err);
        }
        const messageId = await (0, brevo_1.sendEmail)(userEmail, msg.subject, finalBody, delayMinutes);
        if (messageId) {
            console.log('[EMAIL] Scheduled msg %d for wifi guest %s, id=%s, delay=%d min', i, wifiGuestId, messageId, delayMinutes);
            const record = {
                wifiEvent,
                channel: 'email',
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
                scheduledAt: firestore_1.FieldValue.serverTimestamp(),
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
// ── Guest-facing Terms/Privacy documents (CaptivePortal_Documents) ─────────
// Resolution order: venue override (scope='entity', entityId=venueId) → global
// platform default (scope='global') → legacy docs written before the scope field
// existed (identified by a published:true boolean; the CMS writes status instead).
// Terms lists the canonical CMS type first and the pre-rename alias second.
const DOC_TYPES_PRIVACY = ['privacy_policy'];
const DOC_TYPES_TERMS = ['terms_conditions', 'terms_of_service'];
async function resolveVenueIdFromApmac(apmac) {
    const mac = String(apmac || '').toLowerCase().trim();
    if (!mac)
        return null;
    try {
        const snap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
            .where('mac', '==', mac)
            .limit(1)
            .get();
        if (snap.empty)
            return null;
        return snap.docs[0].data().venueId || null;
    }
    catch (err) {
        console.error('[DOCUMENTS] AP lookup error:', err);
        return null;
    }
}
function docFromSnap(snapshot) {
    if (snapshot.empty)
        return null;
    const data = snapshot.docs[0].data();
    return { title: data?.title, content: data?.latestContent };
}
async function fetchDocumentForVenue(types, venueId) {
    const collection = firebase_1.db.collection('CaptivePortal_Documents');
    if (venueId) {
        const overrideSnap = await collection
            .where('type', 'in', types)
            .where('scope', '==', 'entity')
            .where('entityId', '==', venueId)
            .where('status', '==', 'published')
            .limit(1)
            .get();
        const override = docFromSnap(overrideSnap);
        if (override) {
            console.log(`[DOCUMENTS] Venue override for type in [${types}] venue=${venueId}`);
            return override;
        }
    }
    const globalSnap = await collection
        .where('type', 'in', types)
        .where('scope', '==', 'global')
        .where('status', '==', 'published')
        .limit(1)
        .get();
    const globalDoc = docFromSnap(globalSnap);
    if (globalDoc)
        return globalDoc;
    const legacySnap = await collection
        .where('type', 'in', types)
        .where('published', '==', true)
        .limit(1)
        .get();
    const legacyDoc = docFromSnap(legacySnap);
    if (!legacyDoc)
        console.warn(`[DOCUMENTS] No published document found for types=[${types}]`);
    return legacyDoc;
}
router.get('/privacy-policy', async (req, res) => {
    try {
        const venueId = await resolveVenueIdFromApmac(String(req.query.apmac || ''));
        const doc = await fetchDocumentForVenue(DOC_TYPES_PRIVACY, venueId);
        if (!doc)
            return res.status(404).json({ success: false });
        res.json({ success: true, ...doc });
    }
    catch (err) {
        console.error('[PRIVACY POLICY ERROR]', err);
        res.status(500).json({ success: false });
    }
});
router.get('/terms', async (req, res) => {
    try {
        const venueId = await resolveVenueIdFromApmac(String(req.query.apmac || ''));
        const doc = await fetchDocumentForVenue(DOC_TYPES_TERMS, venueId);
        if (!doc)
            return res.status(404).json({ success: false });
        res.json({ success: true, ...doc });
    }
    catch (err) {
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
    customFields: [],
};
const LOGIN_PAGE_DEFAULTS = {
    fields: {
        firstName: { enabled: true, label: '', required: true },
        lastName: { enabled: true, label: '', required: true },
        email: { enabled: true, label: '', required: true },
        // Matches pre-config behavior: phone is always shown but never validated.
        phone: { enabled: true, label: '', required: false },
    },
    buttonText: 'Continue',
    customFields: [],
};
// bodyParagraphs must stay byte-identical to the copy baked into the templates'
// .consent-box (and the legacy CONSENT_TEXT in form-logic.js) so default-config
// venues don't flash mismatched text when JS re-applies the config.
const CONSENT_PAGE_DEFAULTS = {
    heading: 'We care about your privacy',
    subheading: 'Stay in touch with us and find out more about the best offers',
    bodyParagraphs: [
        'I consent to the collection and use of my personal data, provided via WiFi portal registration, by this venue for marketing purposes. I understand that I may withdraw my consent at any time, and that this will not affect the legality of any processing carried out prior to my withdrawal.',
        'I also consent to receiving marketing communications from this venue via email or other electronic means. I understand that I can unsubscribe at any time using the method provided in each communication.',
    ],
    acceptButtonText: 'Accept',
    declineButtonText: "I don't want to stay in touch.",
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
    loginPage: LOGIN_PAGE_DEFAULTS,
    consentPage: CONSENT_PAGE_DEFAULTS,
    connectedPage: CONNECTED_PAGE_DEFAULTS,
};
// Deep-merge a stored loginPage with defaults. Old docs have no loginPage at all —
// derive field visibility from the legacy collectName/collectEmail flags instead.
function mergeLoginPage(docData) {
    const stored = (docData.loginPage && typeof docData.loginPage === 'object' && !Array.isArray(docData.loginPage))
        ? docData.loginPage
        : null;
    if (!stored) {
        const collectName = docData.collectName !== false;
        const collectEmail = docData.collectEmail !== false;
        return {
            ...LOGIN_PAGE_DEFAULTS,
            fields: {
                firstName: { ...LOGIN_PAGE_DEFAULTS.fields.firstName, enabled: collectName, required: collectName },
                lastName: { ...LOGIN_PAGE_DEFAULTS.fields.lastName, enabled: collectName, required: collectName },
                email: { ...LOGIN_PAGE_DEFAULTS.fields.email, enabled: collectEmail, required: collectEmail },
                phone: { ...LOGIN_PAGE_DEFAULTS.fields.phone },
            },
        };
    }
    const storedFields = (stored.fields && typeof stored.fields === 'object') ? stored.fields : {};
    const fields = {};
    Object.keys(LOGIN_PAGE_DEFAULTS.fields).forEach((key) => {
        // Per-field merge: a doc carrying only fields.phone must not clobber the rest.
        fields[key] = { ...LOGIN_PAGE_DEFAULTS.fields[key], ...(storedFields[key] || {}) };
    });
    return {
        fields,
        buttonText: typeof stored.buttonText === 'string' && stored.buttonText.trim() ? stored.buttonText : LOGIN_PAGE_DEFAULTS.buttonText,
        customFields: Array.isArray(stored.customFields) ? stored.customFields : [],
    };
}
function mergeConsentPage(docData) {
    const stored = (docData.consentPage && typeof docData.consentPage === 'object' && !Array.isArray(docData.consentPage))
        ? docData.consentPage
        : {};
    const merged = { ...CONSENT_PAGE_DEFAULTS, ...stored };
    // Never serve an empty consent text — it becomes the guest's ConsentRecord.
    if (!Array.isArray(merged.bodyParagraphs)
        || merged.bodyParagraphs.length === 0
        || !merged.bodyParagraphs.every((p) => typeof p === 'string' && p.trim())) {
        merged.bodyParagraphs = CONSENT_PAGE_DEFAULTS.bodyParagraphs;
    }
    return merged;
}
router.get('/splash-config', async (req, res) => {
    const { apmac: apmacParam, ap } = req.query;
    const apmac = (apmacParam || ap || '').toLowerCase().trim();
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
        const docData = configDoc.data() || {};
        const config = { ...SPLASH_DEFAULTS, ...docData };
        // The top-level spread is shallow — a partial connectedPage doc would clobber
        // the nested defaults, so merge that object explicitly.
        const docConnected = (docData.connectedPage && typeof docData.connectedPage === 'object' && !Array.isArray(docData.connectedPage))
            ? docData.connectedPage
            : {};
        const connectedPage = { ...CONNECTED_PAGE_DEFAULTS, ...docConnected };
        if (!Array.isArray(connectedPage.customFields))
            connectedPage.customFields = [];
        config.connectedPage = connectedPage;
        config.loginPage = mergeLoginPage(docData);
        config.consentPage = mergeConsentPage(docData);
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
// ── Connected-page custom form submissions ─────────────────────────────────
// Guests are anonymous here (no auth token), so abuse is bounded by a small
// in-memory sliding window keyed on client MAC + IP.
const connectedFormHits = new Map();
const CONNECTED_FORM_WINDOW_MS = 60000;
// Auto-save mode posts on every checkbox toggle / text blur, so the window
// allows a burst of legitimate interactions.
const CONNECTED_FORM_MAX_PER_WINDOW = 10;
function connectedFormRateLimited(key) {
    const now = Date.now();
    if (connectedFormHits.size > 1000) {
        for (const [k, times] of connectedFormHits) {
            if (times.every((t) => now - t >= CONNECTED_FORM_WINDOW_MS))
                connectedFormHits.delete(k);
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
router.post('/connected-form', async (req, res) => {
    const { apmac: rawApmac, mac: rawMac, responses } = (req.body || {});
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
        const apSnap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
            .where('mac', '==', apmac)
            .limit(1)
            .get();
        if (apSnap.empty) {
            console.warn('[CONNECTED FORM] Unknown AP:', apmac);
            return res.json({ success: true, stored: false });
        }
        const venueId = apSnap.docs[0].data().venueId;
        if (!venueId)
            return res.json({ success: true, stored: false });
        const configDoc = await firebase_1.db.collection('CaptivePortal_SplashScreenConfig').doc(`venue_${venueId}`).get();
        const configuredFields = Array.isArray(configDoc.data()?.connectedPage?.customFields)
            ? configDoc.data().connectedPage.customFields
            : [];
        const fieldById = new Map(configuredFields
            .filter((f) => f && f.enabled !== false && typeof f.id === 'string' && FIELD_ID_PATTERN.test(f.id))
            .map((f) => [f.id, f]));
        const submittedAt = new Date().toISOString();
        const updates = {};
        for (const [id, raw] of entries) {
            const field = fieldById.get(id);
            if (!field)
                continue; // unknown, disabled, or since-deleted field — drop silently
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
        const userSnap = await firebase_1.db.collection('CaptivePortal_Users').where('mac', '==', mac).get();
        if (userSnap.empty) {
            console.warn('[CONNECTED FORM] No guest found for mac:', mac);
            return res.json({ success: true, stored: false });
        }
        const newest = userSnap.docs.reduce((a, b) => String(a.data().timestamp || '') >= String(b.data().timestamp || '') ? a : b);
        updates.connectedFormUpdatedAt = firestore_1.FieldValue.serverTimestamp();
        await newest.ref.update(updates);
        console.log('[CONNECTED FORM] Stored %d responses for guest %s', storedCount, newest.id);
        return res.json({ success: true, stored: true });
    }
    catch (err) {
        console.error('[CONNECTED FORM ERROR]', err);
        return res.json({ success: true, stored: false });
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
        apSnap.docs[0].ref.update({ lastSeen: firestore_1.FieldValue.serverTimestamp() })
            .catch((err) => console.error('[AP LASTSEEN ERROR]', err));
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
router.post('/unifi/authorize', async (req, res) => {
    const { firstName, lastName, email, phone, phoneCountryCode, clientMac, apMac, url, ssid, privacyPolicyConsent, termsConsent, marketingConsent, } = req.body;
    const timestamp = req.body.timestamp || new Date().toISOString();
    if (!clientMac || !apMac) {
        return res.status(400).json({ success: false, message: 'clientMac and apMac are required' });
    }
    const normalizedApMac = String(apMac).toLowerCase().trim();
    const normalizedClientMac = String(clientMac).toLowerCase().trim();
    // Look up AP by MAC to get unifiConfig + venueId
    let captivePortalAccessPointId = null;
    let venueId = null;
    let unifiConfig = null;
    let sessionTimeoutSeconds = 36000;
    try {
        const apSnap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
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
        venueId = apData.venueId || null;
        sessionTimeoutSeconds = apData.sessionTimeout || 36000;
        if (!apData.unifiConfig?.controllerUrl || !apData.unifiConfig?.username || !apData.unifiConfig?.password) {
            console.error('[UNIFI AUTH] AP missing unifiConfig:', normalizedApMac);
            return res.status(500).json({ success: false, message: 'AP controller not configured' });
        }
        unifiConfig = {
            controllerType: apData.unifiConfig.controllerType || 'classic',
            // captive-server dials the controller's INTERNAL address (UNIFI_CONTROLLER_URL
            // env) — the stored URL is the public one for the admin browser.
            controllerUrl: (0, unifi_1.effectiveControllerUrl)(apData.unifiConfig.controllerUrl),
            site: apData.unifiConfig.site || 'default',
            username: apData.unifiConfig.username,
            password: apData.unifiConfig.password,
        };
        apDoc.ref.update({ lastSeen: firestore_1.FieldValue.serverTimestamp() })
            .catch((err) => console.error('[AP LASTSEEN ERROR]', err));
    }
    catch (err) {
        console.error('[UNIFI AUTH] AP lookup error:', err);
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
    // Call UniFi controller to authorize the guest device
    try {
        const minutes = Math.round(sessionTimeoutSeconds / 60);
        await (0, unifi_1.authorizeGuest)(unifiConfig, normalizedClientMac, minutes);
    }
    catch (err) {
        console.error('[UNIFI AUTH] Controller authorize failed:', err);
        return res.status(502).json({ success: false, message: 'Failed to authorize with UniFi controller' });
    }
    // Reconnect detection
    let existingWifiGuestId = null;
    if (email && captivePortalAccessPointId) {
        try {
            const existingSnap = await firebase_1.db.collection('CaptivePortal_Users')
                .where('email', '==', email)
                .where('captivePortalAccessPointId', '==', captivePortalAccessPointId)
                .limit(1)
                .get();
            if (!existingSnap.empty)
                existingWifiGuestId = existingSnap.docs[0].id;
        }
        catch (err) {
            console.error('[UNIFI AUTH] Reconnect lookup error:', err);
        }
    }
    const wifiEvent = existingWifiGuestId ? 'onReconnect' : 'onConnect';
    const marketingOptIn = marketingConsent?.given ?? false;
    const splashFormResponses = await buildSplashFormResponses(venueId, req.body.splashResponses);
    let wifiGuestId;
    if (!existingWifiGuestId) {
        const doc = {
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
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            captivePortalAccessPointId,
            connectionCount: 1,
            marketingOptIn,
            privacyPolicyConsent: privacyPolicyConsent || defaultConsent(),
            termsConsent: termsConsent || defaultConsent(),
            marketingConsent: marketingConsent || defaultConsent(),
            ...(Object.keys(splashFormResponses).length ? { splashFormResponses } : {}),
        };
        try {
            const ref = await firebase_1.db.collection('CaptivePortal_Users').add(doc);
            wifiGuestId = ref.id;
            console.log('[UNIFI] New connection', wifiGuestId, email, normalizedApMac);
        }
        catch (err) {
            console.error('[UNIFI AUTH] Firestore write error:', err);
            // Auth already granted — return success even if DB write fails
            return res.json({ success: true });
        }
    }
    else {
        wifiGuestId = existingWifiGuestId;
        console.log('[UNIFI] Reconnect', wifiGuestId, email, normalizedApMac);
        const reconnectUpdates = { connectionCount: firestore_1.FieldValue.increment(1) };
        for (const [id, response] of Object.entries(splashFormResponses)) {
            reconnectUpdates[`splashFormResponses.${id}`] = response;
        }
        firebase_1.db.collection('CaptivePortal_Users').doc(wifiGuestId)
            .update(reconnectUpdates)
            .catch((err) => console.error('[UNIFI RECONNECT COUNT ERROR]', err));
    }
    if (captivePortalAccessPointId) {
        const sessionDoc = {
            wifiEvent,
            wifiGuestId,
            accessPointId: captivePortalAccessPointId,
            mac: normalizedClientMac,
            ip: '',
            timestamp,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        };
        firebase_1.db.collection('CaptivePortal_Sessions').add(sessionDoc)
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
        (0, campaigns_1.fireAutomationsForGuest)(captivePortalAccessPointId, wifiGuestId, { firstName, email, phone, phoneCountryCode }, wifiEvent).catch((err) => console.error('[UNIFI CAMPAIGN AUTOMATION ERROR]', err));
    }
    return res.json({ success: true, id: wifiGuestId });
});
router.post('/ap-heartbeat', async (req, res) => {
    const { mac, secret } = req.body || {};
    if (!process.env.AP_HEARTBEAT_SECRET || secret !== process.env.AP_HEARTBEAT_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!mac) {
        return res.status(400).json({ error: 'mac is required' });
    }
    const normalizedMac = String(mac).toLowerCase().trim();
    try {
        const snap = await firebase_1.db.collection('CaptivePortal_AccessPoints')
            .where('mac', '==', normalizedMac)
            .limit(1)
            .get();
        if (snap.empty) {
            return res.status(404).json({ error: 'Access point not found' });
        }
        await snap.docs[0].ref.update({ lastSeen: firestore_1.FieldValue.serverTimestamp(), status: 'online' });
        console.log('[HEARTBEAT] AP checked in:', normalizedMac);
        return res.json({ success: true });
    }
    catch (err) {
        console.error('[HEARTBEAT ERROR]', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});
exports.default = router;
