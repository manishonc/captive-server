"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const brevo_1 = require("../services/brevo");
const router = (0, express_1.Router)();
function isBrevoConfigured() {
    return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}
router.post('/', async (req, res) => {
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
        const messageId = await (0, brevo_1.sendEmail)(to.trim(), subject.trim(), body.trim(), delay);
        if (!messageId) {
            return res.status(503).json({ success: false, message: 'Email service is not configured' });
        }
        return res.status(200).json({ success: true, messageId });
    }
    catch (err) {
        console.error('[SCHEDULE-EMAIL ERROR]', err);
        return res.status(500).json({
            success: false,
            message: err instanceof Error ? err.message : 'Failed to schedule email',
        });
    }
});
exports.default = router;
