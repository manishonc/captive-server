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
                const update: Record<string, unknown> = {
                  deliveryStatus: statusValue,
                  statusUpdatedAt: FieldValue.serverTimestamp(),
                };
                if (errorData) update.deliveryError = errorData;

                await snapshot.docs[0].ref.update(update);
                console.log('[WHATSAPP WEBHOOK] Status update wamid=%s status=%s', wamid, statusValue);
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

        // ── Inbound messages (optional — log for now) ────────────────────────
        const messages = value?.messages as Array<Record<string, unknown>>;
        if (messages?.length) {
          for (const msg of messages) {
            console.log('[WHATSAPP WEBHOOK] Inbound message from %s: type=%s', msg?.from, msg?.type);
            // TODO: handle inbound replies (e.g. opt-out keywords like STOP)
          }
        }
      }
    }
  } catch (err) {
    console.error('[WHATSAPP WEBHOOK ERROR]', err);
  }
});

export default router;
