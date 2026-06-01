/**
 * Internal, secret-guarded endpoints called server-to-server by the CMS.
 *
 * Currently exposes POST /internal/test-send — sends a single marketing
 * message IMMEDIATELY (no scheduling, no analytics doc, no short-link) so an
 * admin can preview how a configured message looks in their inbox/phone.
 *
 * Auth: the caller must send `x-internal-secret` matching INTERNAL_API_SECRET
 * (same shared-secret pattern as /ap-heartbeat).
 */

import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { scheduleSms } from '../services/twilio';
import { sendEmail } from '../services/brevo';
import { sendWhatsAppTemplate, WhatsAppTemplateComponent } from '../services/whatsapp';

const router = Router();

interface TestSendBody {
  venueId?: string;
  channel?: 'email' | 'sms' | 'whatsapp';
  recipient?: string;
  message?: {
    subject?: string;
    body?: string;
    content?: string;
    templateName?: string;
    languageCode?: string;
    variableValues?: Record<string, string>;
  };
}

/** Normalize a free-text phone number into E.164 (strip everything but digits, re-add +). */
function normalizePhone(recipient: string): string | null {
  const digits = (recipient || '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `+${digits}`;
}

router.post('/test-send', async (req: Request<{}, {}, TestSendBody>, res: Response) => {
  const secret = req.header('x-internal-secret');
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { venueId, channel, recipient, message } = req.body;

  if (!channel || !['email', 'sms', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing channel' });
  }
  if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing recipient' });
  }
  if (!message || typeof message !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  try {
    if (channel === 'sms') {
      const content = String(message.content ?? '').trim();
      if (!content) return res.status(400).json({ ok: false, error: 'Missing message content' });
      const to = normalizePhone(recipient);
      if (!to) return res.status(400).json({ ok: false, error: 'Invalid phone number' });
      // delay 0 => Twilio sends immediately
      const id = await scheduleSms(to, content, 0);
      if (!id) return res.status(503).json({ ok: false, error: 'SMS service is not configured' });
      return res.status(200).json({ ok: true, id });
    }

    if (channel === 'email') {
      const subject = String(message.subject ?? '').trim();
      const body = String(message.body ?? '');
      if (!body.trim()) return res.status(400).json({ ok: false, error: 'Missing message body' });
      // delay 0 => Brevo sends immediately
      const id = await sendEmail(recipient.trim(), subject || '(test)', body, 0);
      if (!id) return res.status(503).json({ ok: false, error: 'Email service is not configured' });
      return res.status(200).json({ ok: true, id });
    }

    // whatsapp
    const templateName = String(message.templateName ?? '').trim();
    const languageCode = String(message.languageCode ?? '').trim();
    if (!templateName || !languageCode) {
      return res.status(400).json({ ok: false, error: 'WhatsApp test requires templateName and languageCode' });
    }
    const to = normalizePhone(recipient);
    if (!to) return res.status(400).json({ ok: false, error: 'Invalid phone number' });

    // Resolve venueName the same way the live dispatch does.
    let venueName = '';
    if (venueId) {
      const marketingDoc = await db
        .collection('CaptivePortal_EntityMarketing')
        .doc(`venue_${venueId}`)
        .get();
      venueName = marketingDoc.data()?.venueName || '';
    }

    // Build components exactly like the live path, but with a direct rating URL
    // suffix (no short-link / no click tracking — this is just a test).
    const components: WhatsAppTemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Test' },
          { type: 'text', text: venueName || 'our venue' },
        ],
      },
    ];
    if (venueId) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: [{ type: 'text', text: `${encodeURIComponent(venueId)}/rate` }],
      });
    }

    const id = await sendWhatsAppTemplate(to, { templateName, languageCode, components });
    if (!id) return res.status(503).json({ ok: false, error: 'WhatsApp service is not configured' });
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[INTERNAL TEST-SEND ERROR]', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to send test message',
    });
  }
});

export default router;
