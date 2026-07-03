"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = __importDefault(require("twilio"));
const firebase_1 = require("../firebase");
const firestore_1 = require("firebase-admin/firestore");
const campaignTracking_1 = require("../services/campaignTracking");
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    // Validate Twilio signature if SERVER_PUBLIC_URL is configured
    const publicUrl = process.env.SERVER_PUBLIC_URL;
    if (publicUrl) {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!authToken) {
            console.warn('[TWILIO WEBHOOK] SERVER_PUBLIC_URL set but TWILIO_AUTH_TOKEN missing — skipping signature validation');
        }
        else {
            const signature = req.headers['x-twilio-signature'];
            const url = `${publicUrl}/webhook/twilio/sms-status`;
            const isValid = twilio_1.default.validateRequest(authToken, signature ?? '', url, req.body);
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
        const snapshot = await firebase_1.db
            .collection('CaptivePortal_Marketing')
            .where('messageSid', '==', MessageSid)
            .limit(1)
            .get();
        if (!snapshot.empty) {
            await snapshot.docs[0].ref.update({
                deliveryStatus: MessageStatus,
                statusUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        else {
            console.warn('[TWILIO WEBHOOK] No marketing record found for MessageSid:', MessageSid);
        }
        // Also reflect onto campaign sends (no-op if this SID isn't a campaign send).
        await (0, campaignTracking_1.recordDeliveryStatus)('messageSid', MessageSid, MessageStatus);
    }
    catch (err) {
        console.error('[TWILIO WEBHOOK ERROR]', err);
    }
    // Always return 200 to prevent Twilio retries
    res.sendStatus(200);
});
exports.default = router;
