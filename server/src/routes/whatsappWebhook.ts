/**
 * Meta WhatsApp Webhook
 *
 * Two endpoints:
 *   GET  /webhook/whatsapp  — Meta verification handshake (one-time setup)
 *   POST /webhook/whatsapp  — Incoming delivery status updates
 *
 * Env var required:
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN — any string you choose; must match what
 *                                   you enter in Meta App → WhatsApp → Configuration → Webhook
 */

import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { recordDeliveryStatus } from '../services/campaignTracking';
import { shouldAdvanceStatus } from '../services/deliveryStatus';
import { classifyInbound, setChannelOptOut } from '../services/optOut';
import { sendWhatsAppText } from '../services/whatsapp';

const router = Router();

// ── GET: Meta webhook verification handshake ──────────────────────────────────
router.get('/', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WHATSAPP WEBHOOK] Verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[WHATSAPP WEBHOOK] Verification failed — token mismatch');
  return res.sendStatus(403);
});

// ── POST: Delivery status & inbound message events ───────────────────────────
router.post('/', async (req: Request, res: Response) => {
  // Always acknowledge immediately — Meta will retry if we don't respond fast
  res.sendStatus(200);

  try {
    const body = req.body as Record<string, unknown>;

    // Meta sends: { object: "whatsapp_business_account", entry: [...] }
    if (body?.object !== 'whatsapp_business_account') return;

    const entries = body?.entry as Array<Record<string, unknown>>;
    if (!entries?.length) return;

    for (const entry of entries) {
      const changes = entry?.changes as Array<Record<string, unknown>>;
      if (!changes?.length) continue;

      for (const change of changes) {
        const value = change?.value as Record<string, unknown>;
        if (!value) continue;

        // ── Delivery / read status updates ───────────────────────────────────
        const statuses = value?.statuses as Array<Record<string, unknown>>;
        if (statuses?.length) {
          for (const status of statuses) {
            const wamid         = status?.id as string;
            const statusValue   = status?.status as string; // sent | delivered | read | failed
            const errorData     = status?.errors as unknown;

            if (!wamid || !statusValue) continue;

            try {
              const snapshot = await db
                .collection('CaptivePortal_Marketing')
                .where('wamid', '==', wamid)
                .limit(1)
                .get();

              if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                const update: Record<string, unknown> = {};

                // Meta doesn't order these — a `delivered` can land after a
                // `read`. Only move forward, or the read is lost.
                if (shouldAdvanceStatus(doc.data()?.deliveryStatus, statusValue)) {
                  update.deliveryStatus = statusValue;
                  update.statusUpdatedAt = FieldValue.serverTimestamp();
                }
                if (errorData) update.deliveryError = errorData;

                if (Object.keys(update).length > 0) {
                  await doc.ref.update(update);
                  console.log('[WHATSAPP WEBHOOK] Status update wamid=%s status=%s', wamid, statusValue);
                } else {
                  console.log(
                    '[WHATSAPP WEBHOOK] Ignored out-of-order/duplicate status wamid=%s status=%s (current=%s)',
                    wamid, statusValue, doc.data()?.deliveryStatus,
                  );
                }
              } else {
                console.warn('[WHATSAPP WEBHOOK] No marketing record for wamid:', wamid);
              }

              // Also reflect onto campaign sends (no-op if not a campaign send).
              await recordDeliveryStatus('wamid', wamid, statusValue, errorData);
            } catch (err) {
              console.error('[WHATSAPP WEBHOOK] Firestore update error:', err);
            }
          }
        }

        // ── Inbound messages: honor opt-out keywords + quick-reply buttons ──
        const messages = value?.messages as Array<Record<string, unknown>>;
        if (messages?.length) {
          for (const msg of messages) {
            console.log('[WHATSAPP WEBHOOK] Inbound message from %s: type=%s', msg?.from, msg?.type);
            const from = String(msg?.from ?? '').trim(); // digits, no leading +
            if (!from) continue;

            // Meta policy: honor opt-out requests. Cover both plain-text
            // keywords and template quick-reply buttons ("Unsubscribe").
            let text = '';
            if (msg?.type === 'text') {
              text = String((msg.text as Record<string, unknown>)?.body ?? '');
            } else if (msg?.type === 'button') {
              text = String((msg.button as Record<string, unknown>)?.text ?? '');
            } else if (msg?.type === 'interactive') {
              const interactive = msg.interactive as Record<string, Record<string, unknown>>;
              text = String(interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? '');
            }

            const kind = classifyInbound(text);
            if (!kind) continue;

            try {
              if (kind === 'stop') {
                await setChannelOptOut(`+${from}`, 'whatsapp', true);
                // Confirmation is allowed: an inbound message opens the 24h
                // customer-service window for free-form replies.
                await sendWhatsAppText(
                  `+${from}`,
                  'You have been unsubscribed from WhatsApp updates. Reply START to resubscribe.',
                ).catch(() => {});
              } else if (kind === 'start') {
                await setChannelOptOut(`+${from}`, 'whatsapp', false);
                await sendWhatsAppText(
                  `+${from}`,
                  'You are resubscribed to WhatsApp updates. Reply STOP to unsubscribe.',
                ).catch(() => {});
              }
            } catch (err) {
              console.error('[WHATSAPP WEBHOOK] opt-out handling failed:', err);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[WHATSAPP WEBHOOK ERROR]', err);
  }
});

export default router;
