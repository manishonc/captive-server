/**
 * Public guest-facing unsubscribe endpoint (no secret — hit by recipients and
 * mail clients). Mounted at `/u`.
 *
 *   GET  /u/:token  — verify the signed link, show a one-click confirm page.
 *   POST /u/:token  — record the opt-out. Also handles the RFC 8058 one-click
 *                     POST (List-Unsubscribe-Post) that mail clients send with no
 *                     interaction; the signed token is the authorization.
 *
 * The opt-out is recorded on the CaptivePortal_Users doc (`unsubscribed: true`),
 * which materializeAudience() re-checks on every send (see services/campaigns.ts
 * isOptedIn), and is best-effort mirrored to Brevo's contact blocklist.
 */

import { Router, Request, Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { verifyUnsubscribeToken, UnsubscribePayload } from '../services/unsubscribe';
import { blocklistContact } from '../services/brevo';

const router = Router();
const USERS = 'CaptivePortal_Users';

function htmlPage(title: string, message: string, accent = '#FF385C'): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;background:#F7F7F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:64px auto;background:#fff;border:1px solid #EBEBEB;border-radius:16px;padding:40px 36px;text-align:center;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#222;">${title}</h1>
    <div style="font-size:15px;line-height:23px;color:#717171;">${message}</div>
    <p style="margin:28px 0 0;font-size:12px;color:#B0B0B0;">Powered by HeidiFi</p>
  </div>
</body></html>`;
}

function confirmPage(token: string): string {
  // A real <form> POST so link-prefetchers / scanners (which only issue GETs)
  // can never unsubscribe a guest by accident.
  return htmlPage(
    'Unsubscribe',
    `<p style="margin:0 0 24px;">Stop receiving marketing emails from this venue?</p>
     <form method="POST" action="/u/${encodeURIComponent(token)}" style="margin:0;">
       <button type="submit" style="display:inline-block;background:#FF385C;color:#fff;font-size:15px;font-weight:700;border:0;padding:12px 28px;border-radius:10px;cursor:pointer;">Unsubscribe</button>
     </form>`,
  );
}

async function applyUnsubscribe(payload: UnsubscribePayload): Promise<void> {
  const ref = db.collection(USERS).doc(payload.g);
  const snap = await ref.get();
  if (!snap.exists) return; // already gone — nothing to opt out, treat as success

  await ref.update({
    unsubscribed: true,
    unsubscribedAt: FieldValue.serverTimestamp(),
    // Belt-and-suspenders: also clear the positive opt-in signals so any code
    // path that reads them (not just `unsubscribed`) excludes this guest.
    marketingOptIn: false,
    'marketingConsent.given': false,
  });

  const email = snap.data()?.email;
  if (typeof email === 'string' && email.includes('@')) {
    // Non-fatal: Firestore is the source of truth for our own audience filter.
    blocklistContact(email).catch((err) => console.error('[UNSUB] brevo blocklist failed', err));
  }
}

router.get('/:token', (req: Request, res: Response) => {
  const payload = verifyUnsubscribeToken(String(req.params.token || ''));
  res.set('Content-Type', 'text/html');
  if (!payload) {
    return res.status(400).send(htmlPage('Invalid link', 'This unsubscribe link is invalid or has expired.'));
  }
  return res.status(200).send(confirmPage(String(req.params.token)));
});

router.post('/:token', async (req: Request, res: Response) => {
  const payload = verifyUnsubscribeToken(String(req.params.token || ''));
  res.set('Content-Type', 'text/html');
  if (!payload) {
    return res.status(400).send(htmlPage('Invalid link', 'This unsubscribe link is invalid or has expired.'));
  }
  try {
    await applyUnsubscribe(payload);
  } catch (err) {
    console.error('[UNSUB] failed to apply unsubscribe', err);
    return res.status(500).send(htmlPage('Something went wrong', 'Please try again later.'));
  }
  return res
    .status(200)
    .send(htmlPage('You’re unsubscribed', 'You will no longer receive marketing emails from this venue.'));
});

export default router;
