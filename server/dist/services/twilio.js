"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toE164 = toE164;
exports.scheduleSms = scheduleSms;
const twilio_1 = __importDefault(require("twilio"));
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
const phoneNumber = process.env.TWILIO_PHONE_NUMBER;
/** Minimum delay (minutes) required for Twilio scheduled messages */
const TWILIO_MIN_SCHEDULE_MINUTES = 15;
/** Maximum delay (minutes) Twilio accepts: 35 days */
const TWILIO_MAX_SCHEDULE_MINUTES = 35 * 24 * 60;
/**
 * Combines phoneCountryCode and phone into E.164 format.
 * Returns null if the result is invalid.
 */
function toE164(phoneCountryCode, phone) {
    const code = (phoneCountryCode || '').trim().replace(/^\+/, '') || '';
    const num = (phone || '').replace(/\D/g, '');
    if (!num || num.length < 6)
        return null;
    return `+${code}${num}`;
}
/**
 * Schedules or sends an SMS via Twilio.
 * - If delayMinutes < 15 or env not configured: sends immediately
 * - If delayMinutes >= 15: uses Twilio schedule API
 * - MessagingServiceSid is required for scheduling; From number is used for immediate sends when MessagingServiceSid is absent
 * @returns Twilio message.sid on success, null when skipped (env missing)
 */
async function scheduleSms(to, content, delayMinutes) {
    if (!accountSid || !authToken) {
        console.warn('[TWILIO] Skipping SMS: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
        return null;
    }
    const client = (0, twilio_1.default)(accountSid, authToken);
    const shouldSchedule = delayMinutes >= TWILIO_MIN_SCHEDULE_MINUTES &&
        delayMinutes <= TWILIO_MAX_SCHEDULE_MINUTES &&
        messagingServiceSid;
    const createParams = {
        to,
        body: content,
    };
    if (shouldSchedule) {
        const sendAt = new Date(Date.now() + delayMinutes * 60 * 1000);
        createParams.scheduleType = 'fixed';
        createParams.sendAt = sendAt;
        createParams.messagingServiceSid = messagingServiceSid;
    }
    else {
        if (messagingServiceSid) {
            createParams.messagingServiceSid = messagingServiceSid;
        }
        else if (phoneNumber) {
            createParams.from = phoneNumber;
        }
        else {
            console.warn('[TWILIO] Skipping SMS: TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER required for sending');
            return null;
        }
    }
    const message = await client.messages.create(createParams);
    return message.sid ?? null;
}
