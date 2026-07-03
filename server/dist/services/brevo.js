"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
exports.blocklistContact = blocklistContact;
exports.sendApOfflineAlert = sendApOfflineAlert;
exports.sendApRecoveryAlert = sendApRecoveryAlert;
const brevo_1 = require("@getbrevo/brevo");
const apiKey = process.env.BREVO_API_KEY;
const senderEmail = process.env.BREVO_SENDER_EMAIL;
const senderName = process.env.BREVO_SENDER_NAME || 'WiFi Portal';
/**
 * Sends or schedules a transactional email via Brevo.
 * - If delayMinutes >= 1: schedules using Brevo's scheduledAt parameter
 * - Otherwise: sends immediately
 * - If unsubscribeUrl is provided (marketing sends): adds RFC 8058 one-click
 *   List-Unsubscribe headers so Gmail/Apple show a native unsubscribe button.
 * @returns Brevo messageId on success, null when skipped (env missing)
 */
async function sendEmail(to, subject, body, delayMinutes, unsubscribeUrl) {
    if (!apiKey || !senderEmail) {
        console.warn('[BREVO] Skipping email: BREVO_API_KEY or BREVO_SENDER_EMAIL not set');
        return null;
    }
    const client = new brevo_1.BrevoClient({ apiKey });
    const params = {
        to: [{ email: to }],
        sender: { email: senderEmail, name: senderName },
        subject,
        htmlContent: body,
    };
    if (unsubscribeUrl) {
        params.headers = {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
    }
    if (delayMinutes >= 1) {
        params.scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    }
    const result = await client.transactionalEmails.sendTransacEmail(params);
    return result.messageId ?? null;
}
/**
 * Best-effort mirror of an unsubscribe to Brevo's contact blocklist (so Brevo
 * also suppresses the address). Firestore's `unsubscribed` flag remains the
 * source of truth for our own audience filter, so failures here are non-fatal.
 * A 404 (the recipient was never imported as a Brevo contact) is expected and
 * ignored — we only create contacts implicitly via marketing.
 */
async function blocklistContact(email) {
    if (!apiKey || !email)
        return;
    const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: { 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ emailBlacklisted: true }),
    });
    if (!res.ok && res.status !== 404) {
        console.warn(`[BREVO] blocklistContact ${email} -> HTTP ${res.status}`);
    }
}
const CMS_DASHBOARD_URL = process.env.CMS_DASHBOARD_URL ?? 'https://cms.heidifi.ai';
async function sendApOfflineAlert(to, apName, venueName, offlineSince) {
    const lastSeenStr = offlineSince.toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
    const subject = `[HeidiFi] No activity detected on "${apName}" at ${venueName}`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#D97706;padding:28px 36px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">&#9888; No Activity Detected</h1>
    </div>
    <div style="padding:32px 36px">
      <p style="margin:0 0 16px;color:#222;font-size:15px;line-height:1.6">Your router <strong>"${apName}"</strong> at <strong>${venueName}</strong> has not reported any activity since ${lastSeenStr}. It may be offline, or no guests have connected recently.</p>
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:18px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="color:#717171;padding:3px 0">Router</td><td style="color:#222;font-weight:600;text-align:right">${apName}</td></tr>
          <tr><td style="color:#717171;padding:3px 0">Venue</td><td style="color:#222;font-weight:600;text-align:right">${venueName}</td></tr>
          <tr><td style="color:#717171;padding:3px 0">Last activity</td><td style="color:#222;font-weight:600;text-align:right">${lastSeenStr}</td></tr>
        </table>
      </div>
      <p style="margin:0 0 10px;color:#222;font-size:14px;font-weight:600">If you think the router may be down, here&apos;s what to check:</p>
      <ol style="margin:0 0 24px;padding-left:20px;color:#444;font-size:14px;line-height:2">
        <li>Power cycle the router — unplug for 10 seconds then plug back in</li>
        <li>Check that the ethernet cable is firmly connected</li>
        <li>Verify your internet/ISP connection is working</li>
        <li>Check the Aruba Instant On app for device status</li>
      </ol>
      <a href="${CMS_DASHBOARD_URL}" style="display:inline-block;background:#222;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none">View Dashboard &rarr;</a>
    </div>
    <div style="padding:20px 36px;border-top:1px solid #EBEBEB;background:#FAFAFA">
      <p style="margin:0 0 8px;color:#555;font-size:12px;font-weight:600">Don&apos;t want these alerts?</p>
      <p style="margin:0 0 4px;color:#717171;font-size:12px;line-height:1.6">To turn off inactivity alerts for this router:</p>
      <ol style="margin:4px 0 0;padding-left:18px;color:#717171;font-size:12px;line-height:1.8">
        <li>Go to your <a href="${CMS_DASHBOARD_URL}" style="color:#FF5A5F;text-decoration:none;font-weight:600">HeidiFi Dashboard</a></li>
        <li>Open <strong style="color:#555">Access Points</strong></li>
        <li>Click <strong style="color:#555">Edit</strong> on this router</li>
        <li>Toggle <strong style="color:#555">Inactivity Alerts</strong> off and save</li>
      </ol>
    </div>
  </div>
</body></html>`;
    await sendEmail(to, subject, html, 0);
}
async function sendApRecoveryAlert(to, apName, venueName) {
    const subject = `[HeidiFi] Activity resumed on "${apName}" at ${venueName}`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#22C55E;padding:28px 36px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">&#10003; Activity Resumed</h1>
    </div>
    <div style="padding:32px 36px">
      <p style="margin:0 0 16px;color:#222;font-size:15px;line-height:1.6">Good news! Your router <strong>"${apName}"</strong> at <strong>${venueName}</strong> is showing activity again.</p>
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:18px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="color:#717171;padding:3px 0">Router</td><td style="color:#222;font-weight:600;text-align:right">${apName}</td></tr>
          <tr><td style="color:#717171;padding:3px 0">Venue</td><td style="color:#222;font-weight:600;text-align:right">${venueName}</td></tr>
          <tr><td style="color:#717171;padding:3px 0">Activity</td><td style="color:#16A34A;font-weight:600;text-align:right">Active &#10003;</td></tr>
        </table>
      </div>
      <a href="${CMS_DASHBOARD_URL}" style="display:inline-block;background:#222;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none">View Dashboard &rarr;</a>
    </div>
  </div>
</body></html>`;
    await sendEmail(to, subject, html, 0);
}
