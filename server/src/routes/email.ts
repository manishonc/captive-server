import { Router, Request, Response, NextFunction } from 'express';
import { sendEmail } from '../services/brevo';

const router = Router();

/**
 * Internal only: this sends a message to any recipient with any text through
 * HeidiFi's Brevo account, so callers must send `x-internal-secret`
 * (INTERNAL_API_SECRET), like every other /internal route. No secret configured
 * → closed.
 */
router.use((req: Request, res: Response, next: NextFunction) => {
  const secret = req.header('x-internal-secret');
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
});

interface ScheduleEmailBody {
  to?: string;
  subject?: string;
  body?: string;
  delayMinutes?: number;
}

function isBrevoConfigured(): boolean {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

router.post('/', async (req: Request<{}, {}, ScheduleEmailBody>, res: Response) => {
  const { to, subject, body, delayMinutes = 0 } = req.body;

  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return res.status(400).json({ success: false, message: 'Missing or invalid field: to (must be an email address)' });
  }

  if (!subject || typeof subject !== 'string' || subject.trim() === '') {
    return res.status(400).json({ success: false, message: 'Missing required field: subject' });
  }

  if (!body || typeof body !== 'string' || body.trim() === '') {
    return res.status(400).json({ success: false, message: 'Missing required field: body' });
  }

  if (!isBrevoConfigured()) {
    return res.status(503).json({ success: false, message: 'Email service is not configured' });
  }

  const delay = typeof delayMinutes === 'number' ? delayMinutes : 0;

  try {
    const messageId = await sendEmail(to.trim(), subject.trim(), body.trim(), delay);
    if (!messageId) {
      return res.status(503).json({ success: false, message: 'Email service is not configured' });
    }
    return res.status(200).json({ success: true, messageId });
  } catch (err) {
    console.error('[SCHEDULE-EMAIL ERROR]', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Failed to schedule email',
    });
  }
});

export default router;
