/**
 * POST /webhook/twilio/inbound — inbound SMS handler (STOP/START/HELP).
 *
 * CTIA compliance: honor STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT by
 * setting smsOptOut on every guest record matching the sender's number;
 * START/UNSTOP/YES re-opts in; HELP gets an informational reply.
 *
 * Reply behavior is env-gated: when the Twilio Messaging Service has
 * Advanced Opt-Out enabled (TWILIO_ADVANCED_OPT_OUT=true), Twilio already
 * auto-replies AND blocks further sends at the carrier level — we return
 * empty TwiML and only sync our own opt-out state. Otherwise we send the
 * confirmation ourselves.
 *
 * Ops: point the Messaging Service's inbound request URL at
 * `${SERVER_PUBLIC_URL}/webhook/twilio/inbound`.
 */

import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { classifyInbound, setChannelOptOut } from '../services/optOut';

const router = Router();

const CONTACT_NOTE = 'HeidiFi venue Wi-Fi marketing';

function twiml(message?: string): string {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

router.post('/', async (req: Request, res: Response) => {
  // Validate Twilio signature if SERVER_PUBLIC_URL is configured (same
  // pattern as the status-callback webhook).
  const publicUrl = process.env.SERVER_PUBLIC_URL;
  if (publicUrl) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.warn('[TWILIO INBOUND] SERVER_PUBLIC_URL set but TWILIO_AUTH_TOKEN missing — skipping signature validation');
    } else {
      const signature = req.headers['x-twilio-signature'] as string | undefined;
      const url = `${publicUrl}/webhook/twilio/inbound`;
      const isValid = twilio.validateRequest(authToken, signature ?? '', url, req.body);
      if (!isValid) {
        console.warn('[TWILIO INBOUND] Invalid signature — rejecting request');
        return res.status(403).send('Forbidden');
      }
    }
  }

  const from = String(req.body?.From ?? '').trim();
  const body = String(req.body?.Body ?? '');
  const kind = classifyInbound(body);

  res.type('text/xml');

  if (!from || !kind) {
    // Not an opt-out keyword — nothing to do (no auto-reply to arbitrary texts).
    return res.send(twiml());
  }

  // Twilio's Advanced Opt-Out already replies; we only sync state then.
  const twilioHandlesReplies = process.env.TWILIO_ADVANCED_OPT_OUT === 'true';

  try {
    if (kind === 'stop') {
      await setChannelOptOut(from, 'sms', true);
      return res.send(
        twilioHandlesReplies
          ? twiml()
          : twiml('You have been unsubscribed and will receive no more messages. Reply START to resubscribe. Reply HELP for help.'),
      );
    }
    if (kind === 'start') {
      await setChannelOptOut(from, 'sms', false);
      return res.send(
        twilioHandlesReplies ? twiml() : twiml('You are resubscribed to messages. Reply STOP to unsubscribe.'),
      );
    }
    // help
    return res.send(
      twilioHandlesReplies
        ? twiml()
        : twiml(`${CONTACT_NOTE}: reply STOP to unsubscribe, START to resubscribe.`),
    );
  } catch (err) {
    console.error('[TWILIO INBOUND ERROR]', err);
    // Still 200 with empty TwiML — Twilio retries would just repeat the failure.
    return res.send(twiml());
  }
});

export default router;
