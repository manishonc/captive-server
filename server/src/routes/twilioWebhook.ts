import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  // Validate Twilio signature if SERVER_PUBLIC_URL is configured
  const publicUrl = process.env.SERVER_PUBLIC_URL;
  if (publicUrl) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.warn('[TWILIO WEBHOOK] SERVER_PUBLIC_URL set but TWILIO_AUTH_TOKEN missing — skipping signature validation');
    } else {
      const signature = req.headers['x-twilio-signature'] as string | undefined;
      const url = `${publicUrl}/webhook/twilio/sms-status`;
      const isValid = twilio.validateRequest(authToken, signature ?? '', url, req.body);
      if (!isValid) {
        console.warn('[TWILIO WEBHOOK] Invalid signature — rejecting request');
        return res.status(403).send('Forbidden');
      }
    }
  }

  const { MessageSid, MessageStatus } = req.body;

  if (!MessageSid || !MessageStatus) {
    return res.sendStatus(200);
  }

  try {
    const snapshot = await db
      .collection('CaptivePortal_Marketing')
      .where('messageSid', '==', MessageSid)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      await snapshot.docs[0].ref.update({
        deliveryStatus: MessageStatus,
        statusUpdatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      console.warn('[TWILIO WEBHOOK] No marketing record found for MessageSid:', MessageSid);
    }
  } catch (err) {
    console.error('[TWILIO WEBHOOK ERROR]', err);
  }

  // Always return 200 to prevent Twilio retries
  res.sendStatus(200);
});

export default router;
