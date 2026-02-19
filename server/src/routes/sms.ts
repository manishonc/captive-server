import { Router, Request, Response } from 'express';
import { scheduleSms, toE164 } from '../services/twilio';

const router = Router();

interface ScheduleSmsBody {
  to?: string;
  phone?: string;
  phoneCountryCode?: string;
  content?: string;
  delayMinutes?: number;
}

function isTwilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

router.post('/', async (req: Request<{}, {}, ScheduleSmsBody>, res: Response) => {
  const { to, phone, phoneCountryCode, content, delayMinutes = 0 } = req.body;

  if (!content || typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Missing required field: content',
    });
  }

  let e164: string | null = null;
  if (to && typeof to === 'string' && to.trim()) {
    const normalized = to.trim().replace(/\s/g, '');
    if (normalized.startsWith('+') && normalized.length >= 10) {
      e164 = normalized;
    }
  }
  if (!e164 && phone && phoneCountryCode) {
    e164 = toE164(
      String(phoneCountryCode).trim(),
      String(phone).trim()
    );
  }

  if (!e164) {
    return res.status(400).json({
      success: false,
      message: 'Provide either "to" (E.164, e.g. +447911123456) or both "phone" and "phoneCountryCode"',
    });
  }

  if (!isTwilioConfigured()) {
    return res.status(503).json({
      success: false,
      message: 'SMS service is not configured',
    });
  }

  const delay = typeof delayMinutes === 'number' ? delayMinutes : 0;

  try {
    const messageSid = await scheduleSms(e164, content.trim(), delay);
    if (!messageSid) {
      return res.status(503).json({
        success: false,
        message: 'SMS service is not configured',
      });
    }
    return res.status(200).json({
      success: true,
      messageSid,
    });
  } catch (err) {
    console.error('[SCHEDULE-SMS ERROR]', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Failed to schedule SMS',
    });
  }
});

export default router;
