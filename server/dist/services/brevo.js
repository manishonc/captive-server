"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
const brevo_1 = require("@getbrevo/brevo");
const apiKey = process.env.BREVO_API_KEY;
const senderEmail = process.env.BREVO_SENDER_EMAIL;
const senderName = process.env.BREVO_SENDER_NAME || 'WiFi Portal';
/**
 * Sends or schedules a transactional email via Brevo.
 * - If delayMinutes >= 1: schedules using Brevo's scheduledAt parameter
 * - Otherwise: sends immediately
 * @returns Brevo messageId on success, null when skipped (env missing)
 */
async function sendEmail(to, subject, body, delayMinutes) {
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
    if (delayMinutes >= 1) {
        params.scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    }
    const result = await client.transactionalEmails.sendTransacEmail(params);
    return result.messageId ?? null;
}
