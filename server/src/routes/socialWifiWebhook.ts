import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { WifiEvent } from '../types/captive';
import { scheduleSms } from '../services/twilio';
import { sendEmail } from '../services/brevo';
import { sendWhatsAppTemplate, WhatsAppTemplateComponent } from '../services/whatsapp';
import {
  swapVenueRatingUrl,
  swapTrackedLinks,
  createShortLink,
  ShortLinkContext,
  VISITOR_BASE_URL,
} from '../services/shortlinks';
import { getVenueName } from '../services/venue';
import { injectOpenPixel } from '../services/openPixel';
import { interpolate } from '../services/mergeTags';
import { buildUnsubscribeUrl } from '../services/unsubscribe';
import { SOCIAL_WIFI_WEBHOOK_SECRET, SOCIAL_WIFI_AP_MAP } from '../config/socialWifi';
import { normalizeLanguage, resolveVariant } from '../services/guestLanguage';

const router = Router();

interface SocialWifiUser {
  id?: string;
  email?: string;
  'first-name'?: string;
  'last-name'?: string;
  phone?: string;
  'is-subscribed'?: boolean;
  'email-confirmed'?: boolean;
  'phone-confirmed'?: boolean;
  'birth-date'?: string | null;
  language?: string;
}

interface SocialWifiVenue {
  id: string;
  name?: string;
}

interface SocialWifiUpsertPayload {
  data: {
    user: SocialWifiUser;
    venue: SocialWifiVenue;
  };
}

router.post('/', async (req: Request, res: Response) => {
  // Ack immediately — Social WiFi closes the connection after 2 seconds
  res.sendStatus(200);

  try {
    console.log('[SOCIAL_WIFI] Incoming headers:', JSON.stringify(req.headers, null, 2));
    console.log('[SOCIAL_WIFI] Incoming body:', JSON.stringify(req.body, null, 2));

    const authHeader = String(req.headers['authorization'] || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (token !== SOCIAL_WIFI_WEBHOOK_SECRET) {
      console.warn('[SOCIAL_WIFI] Invalid webhook secret — ignoring request');
      return;
    }

    const payload = req.body as SocialWifiUpsertPayload;
    if (!payload?.data?.user || !payload?.data?.venue?.id) {
      console.warn('[SOCIAL_WIFI] Missing data.user or data.venue.id in payload');
      return;
    }

    const { user, venue: swVenue } = payload.data;
    const phone = user.phone?.trim() || '';
    const email = user.email?.trim() || '';
    const firstName = user['first-name']?.trim() || '';
    const lastName = user['last-name']?.trim() || '';
    const marketingOptIn = user['is-subscribed'] ?? false;
    // Social WiFi has always sent this; it was declared on the payload type and
    // then dropped on the floor. Persisting it means these guests get the same
    // language-aware sends as portal guests.
    const guestLanguage = normalizeLanguage(user.language);

    const swVenueId = swVenue.id;
    const accessPointId = swVenueId ? SOCIAL_WIFI_AP_MAP[swVenueId] : undefined;
    if (!accessPointId) {
      console.warn('[SOCIAL_WIFI] Unknown venue ID — add it to SOCIAL_WIFI_AP_MAP:', swVenueId);
      return;
    }

    // Reconnect detection: match by phone if present, otherwise email
    const lookupField = phone ? 'phone' : 'email';
    const lookupValue = phone || email;
    let existingGuestId: string | null = null;
    if (lookupValue) {
      try {
        const snap = await db
          .collection('CaptivePortal_Users')
          .where(lookupField, '==', lookupValue)
          .where('captivePortalAccessPointId', '==', accessPointId)
          .limit(1)
          .get();
        if (!snap.empty) existingGuestId = snap.docs[0].id;
      } catch (err) {
        console.error('[SOCIAL_WIFI] Reconnect lookup error:', err);
      }
    }

    const wifiEvent: WifiEvent = existingGuestId ? 'onReconnect' : 'onConnect';
    const timestamp = new Date().toISOString();
    let wifiGuestId: string;

    if (!existingGuestId) {
      const ref = await db.collection('CaptivePortal_Users').add({
        firstName,
        lastName,
        email,
        phone,
        phoneCountryCode: '',
        mac: '',
        ip: '',
        url: '',
        post: '',
        timestamp,
        createdAt: FieldValue.serverTimestamp(),
        captivePortalAccessPointId: accessPointId,
        connectionCount: 1,
        marketingOptIn,
        externalSource: 'social_wifi',
        privacyPolicyConsent: { given: false, timestamp, version: '1.0' },
        termsConsent: { given: false, timestamp, version: '1.0' },
        marketingConsent: { given: marketingOptIn, timestamp, version: '1.0' },
        ...(guestLanguage ? { language: guestLanguage } : {}),
      });
      wifiGuestId = ref.id;
      console.log('[SOCIAL_WIFI] New guest created:', wifiGuestId, phone || email);
    } else {
      wifiGuestId = existingGuestId;
      console.log('[SOCIAL_WIFI] Reconnect:', wifiGuestId, phone || email);
      db.collection('CaptivePortal_Users').doc(wifiGuestId)
        .update({
          connectionCount: FieldValue.increment(1),
          ...(guestLanguage ? { language: guestLanguage } : {}),
        })
        .catch((err) => console.error('[SOCIAL_WIFI] Reconnect count error:', err));
    }

    if (!marketingOptIn) {
      console.log('[SOCIAL_WIFI] Guest opted out of marketing — no messages scheduled', wifiGuestId);
      return;
    }

    scheduleSmsForVenue(accessPointId, wifiGuestId, phone, wifiEvent, guestLanguage)
      .catch((err) => console.error('[SOCIAL_WIFI] SMS schedule error:', err));
    scheduleWhatsAppForVenue(accessPointId, wifiGuestId, firstName, phone, wifiEvent, guestLanguage)
      .catch((err) => console.error('[SOCIAL_WIFI] WhatsApp schedule error:', err));
    scheduleEmailForVenue(accessPointId, wifiGuestId, firstName, email, wifiEvent, guestLanguage)
      .catch((err) => console.error('[SOCIAL_WIFI] Email schedule error:', err));

  } catch (err) {
    console.error('[SOCIAL_WIFI] Unhandled webhook error:', err);
  }
});

// Phone from Social WiFi is already E.164 (e.g. "+41791234567") — passed directly to services.

async function scheduleSmsForVenue(
  accessPointId: string,
  wifiGuestId: string,
  phone: string,
  wifiEvent: WifiEvent,
  guestLanguage: string | null = null,
): Promise<void> {
  if (!phone) return;

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) { console.warn('[SOCIAL_WIFI/SMS] AP not found:', accessPointId); return; }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) { console.warn('[SOCIAL_WIFI/SMS] AP has no venueId:', accessPointId); return; }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) { console.warn('[SOCIAL_WIFI/SMS] No EntityMarketing for venue:', venueId); return; }

  const smsConfig = marketingDoc.data()?.events?.[wifiEvent]?.sms;
  if (!smsConfig?.enabled || !smsConfig?.messages?.length) return;

  for (let i = 0; i < smsConfig.messages.length; i++) {
    const msg = resolveVariant(smsConfig.messages[i], guestLanguage);
    if (!msg.content) continue;

    const delayMinutes = msg.delayMinutes ?? 0;
    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = { venueId, marketingDocId: mRef.id, wifiGuestId, channel: 'sms' };
    const shortCodes: string[] = [];
    let finalContent = msg.content;
    try {
      const rateSwap = await swapVenueRatingUrl(finalContent, ctx);
      finalContent = rateSwap.content;
      if (rateSwap.code) shortCodes.push(rateSwap.code);
      const trackedSwap = await swapTrackedLinks(finalContent, ctx);
      finalContent = trackedSwap.content;
      shortCodes.push(...trackedSwap.codes);
    } catch (err) { console.error('[SOCIAL_WIFI/SMS] Shortlink swap error:', err); }

    const messageSid = await scheduleSms(phone, finalContent, delayMinutes);
    if (messageSid) {
      console.log('[SOCIAL_WIFI/SMS] Scheduled msg %d for guest %s, sid=%s', i, wifiGuestId, messageSid);
      await mRef.set({
        wifiEvent, channel: 'sms', accessPointId, wifiGuestId, messageSid,
        to: phone, content: finalContent, messageIndex: i, delayMinutes,
        sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        scheduledAt: FieldValue.serverTimestamp(), deliveryStatus: 'scheduled',
        shortCodes, clickCount: 0, firstClickedAt: null, lastClickedAt: null,
        firstVisitId: null, visitedAt: null, visitCount: 0, ratingId: null, ratedAt: null, rating: null,
      }).catch((err) => console.error('[SOCIAL_WIFI/SMS] Marketing record error:', err));
    }
  }
}

async function scheduleWhatsAppForVenue(
  accessPointId: string,
  wifiGuestId: string,
  firstName: string,
  phone: string,
  wifiEvent: WifiEvent,
  guestLanguage: string | null = null,
): Promise<void> {
  if (!phone) return;

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) { console.warn('[SOCIAL_WIFI/WA] AP not found:', accessPointId); return; }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) { console.warn('[SOCIAL_WIFI/WA] AP has no venueId:', accessPointId); return; }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) { console.warn('[SOCIAL_WIFI/WA] No EntityMarketing for venue:', venueId); return; }

  const whatsappConfig = marketingDoc.data()?.events?.[wifiEvent]?.whatsapp;
  if (!whatsappConfig?.enabled || !whatsappConfig?.messages?.length) return;

  const venueName: string = await getVenueName(venueId, marketingDoc.data()?.venueName);

  for (let i = 0; i < whatsappConfig.messages.length; i++) {
    const msg = resolveVariant(whatsappConfig.messages[i], guestLanguage);
    if (!msg.templateName || !msg.languageCode) continue;

    const delayMinutes: number = msg.delayMinutes ?? 0;

    // Pre-allocate the Marketing doc (like the SMS branch above) so the short
    // link minted below has a marketingDocId to attribute clicks back to.
    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = { venueId, marketingDocId: mRef.id, wifiGuestId, channel: 'whatsapp' };
    const shortCodes: string[] = [];

    // The template body is fixed Meta-side, so unlike SMS/email there is no URL
    // to swap — inject firstName/venueName as {{1}}/{{2}} and pass the tracked
    // short link as the dynamic "Rate Us" URL button parameter. Omitting the
    // button component makes Meta reject the whole send (error 132000).
    let components: WhatsAppTemplateComponent[] | undefined = msg.components;
    if (!components) {
      const built: WhatsAppTemplateComponent[] = [
        { type: 'body', parameters: [
          { type: 'text', text: firstName || 'Guest' },
          { type: 'text', text: venueName || 'our venue' },
        ]},
      ];
      try {
        const code = await createShortLink({
          targetType: 'venue-rate',
          targetUrl: `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`,
          ...ctx,
        });
        shortCodes.push(code);
        built.push({
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [{ type: 'text', text: `s/${code}` }],
        });
      } catch (err) {
        console.error('[SOCIAL_WIFI/WA] Shortlink mint error:', err);
      }
      components = built;
    }

    const sendFn = async () => {
      const wamid = await sendWhatsAppTemplate(phone, { templateName: msg.templateName, languageCode: msg.languageCode, components, delayMinutes });
      if (wamid) {
        console.log('[SOCIAL_WIFI/WA] Sent msg %d for guest %s, wamid=%s', i, wifiGuestId, wamid);
        await mRef.set({
          wifiEvent, channel: 'whatsapp', accessPointId, wifiGuestId, wamid,
          to: phone, templateName: msg.templateName, languageCode: msg.languageCode,
          messageIndex: i, delayMinutes,
          sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
          scheduledAt: FieldValue.serverTimestamp(), deliveryStatus: 'sent',
          shortCodes, clickCount: 0, firstClickedAt: null, lastClickedAt: null,
          firstVisitId: null, visitedAt: null, visitCount: 0, ratingId: null, ratedAt: null, rating: null,
        }).catch((err) => console.error('[SOCIAL_WIFI/WA] Marketing record error:', err));
      }
    };

    if (delayMinutes > 0) {
      setTimeout(() => sendFn().catch((err) => console.error('[SOCIAL_WIFI/WA] Delayed send error:', err)), delayMinutes * 60 * 1000);
      console.log('[SOCIAL_WIFI/WA] Queued msg %d for guest %s in %d min', i, wifiGuestId, delayMinutes);
    } else {
      await sendFn();
    }
  }
}

async function scheduleEmailForVenue(
  accessPointId: string,
  wifiGuestId: string,
  firstName: string,
  email: string,
  wifiEvent: WifiEvent,
  guestLanguage: string | null = null,
): Promise<void> {
  if (!email) return;

  const apDoc = await db.collection('CaptivePortal_AccessPoints').doc(accessPointId).get();
  if (!apDoc.exists) { console.warn('[SOCIAL_WIFI/EMAIL] AP not found:', accessPointId); return; }
  const venueId = apDoc.data()?.venueId;
  if (!venueId) { console.warn('[SOCIAL_WIFI/EMAIL] AP has no venueId:', accessPointId); return; }

  const marketingDoc = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${venueId}`).get();
  if (!marketingDoc.exists) { console.warn('[SOCIAL_WIFI/EMAIL] No EntityMarketing for venue:', venueId); return; }

  const emailConfig = marketingDoc.data()?.events?.[wifiEvent]?.email;
  if (!emailConfig?.enabled || !emailConfig?.messages?.length) return;

  const venueName: string = await getVenueName(venueId, marketingDoc.data()?.venueName);

  for (let i = 0; i < emailConfig.messages.length; i++) {
    const msg = resolveVariant(emailConfig.messages[i], guestLanguage);
    if (!msg.subject || !msg.body) continue;

    const delayMinutes = msg.delayMinutes ?? 0;
    const mRef = db.collection('CaptivePortal_Marketing').doc();
    const ctx: ShortLinkContext = { venueId, marketingDocId: mRef.id, wifiGuestId, channel: 'email' };

    // Merge tags + signed unsubscribe — see routes/captive.ts for the rationale.
    const mergeCtx: Record<string, string> = {
      firstName: firstName || '',
      venueName: venueName || '',
      ratingUrl: `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`,
      unsubscribeUrl: buildUnsubscribeUrl({ g: wifiGuestId, v: venueId }),
    };

    const finalSubject = interpolate(String(msg.subject), mergeCtx);
    const shortCodes: string[] = [];
    // Interpolate before the swaps so {{ratingUrl}} becomes a tracked link.
    let finalBody = interpolate(String(msg.body), mergeCtx);
    try {
      const rateSwap = await swapVenueRatingUrl(finalBody, ctx);
      finalBody = rateSwap.content;
      if (rateSwap.code) shortCodes.push(rateSwap.code);
      const trackedSwap = await swapTrackedLinks(finalBody, ctx);
      finalBody = trackedSwap.content;
      shortCodes.push(...trackedSwap.codes);
    } catch (err) { console.error('[SOCIAL_WIFI/EMAIL] Shortlink swap error:', err); }

    // Open tracking — see the identical call in routes/captive.ts. After the
    // link swaps so the pixel URL isn't itself rewritten.
    finalBody = injectOpenPixel(finalBody, mRef.id);

    const messageId = await sendEmail(
      email,
      finalSubject,
      finalBody,
      delayMinutes,
      mergeCtx.unsubscribeUrl || undefined,
    );
    if (messageId) {
      console.log('[SOCIAL_WIFI/EMAIL] Scheduled msg %d for guest %s, id=%s', i, wifiGuestId, messageId);
      await mRef.set({
        wifiEvent, channel: 'email', accessPointId, wifiGuestId, messageId,
        to: email, subject: finalSubject, body: finalBody, messageIndex: i, delayMinutes,
        sendAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        scheduledAt: FieldValue.serverTimestamp(), deliveryStatus: 'scheduled',
        shortCodes, clickCount: 0, firstClickedAt: null, lastClickedAt: null,
        openCounted: false, openedAt: null, openCount: 0, lastOpenedAt: null,
        firstVisitId: null, visitedAt: null, visitCount: 0, ratingId: null, ratedAt: null, rating: null,
      }).catch((err) => console.error('[SOCIAL_WIFI/EMAIL] Marketing record error:', err));
    }
  }
}

export default router;
