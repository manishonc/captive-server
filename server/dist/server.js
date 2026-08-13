"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const captive_1 = __importDefault(require("./routes/captive"));
const sms_1 = __importDefault(require("./routes/sms"));
const email_1 = __importDefault(require("./routes/email"));
const twilioWebhook_1 = __importDefault(require("./routes/twilioWebhook"));
const twilioInbound_1 = __importDefault(require("./routes/twilioInbound"));
const whatsappWebhook_1 = __importDefault(require("./routes/whatsappWebhook"));
const socialWifiWebhook_1 = __importDefault(require("./routes/socialWifiWebhook"));
const brevoWebhook_1 = __importDefault(require("./routes/brevoWebhook"));
const tracking_1 = __importDefault(require("./routes/tracking"));
const unsubscribe_1 = __importDefault(require("./routes/unsubscribe"));
const internal_1 = __importDefault(require("./routes/internal"));
const verify_1 = __importDefault(require("./routes/verify"));
const publicPricing_1 = __importDefault(require("./routes/publicPricing"));
const apMonitor_1 = require("./jobs/apMonitor");
const campaignScheduler_1 = require("./jobs/campaignScheduler");
const verificationConfig_1 = require("./services/verificationConfig");
const verificationToken_1 = require("./services/verificationToken");
const clientIp_1 = require("./services/clientIp");
const app = (0, express_1.default)();
const PORT = 4000;
app.use(body_parser_1.default.json());
app.use(body_parser_1.default.urlencoded({ extended: false }));
app.use('/', captive_1.default);
app.use('/schedule-sms', sms_1.default);
app.use('/schedule-email', email_1.default);
app.use('/webhook/twilio/sms-status', twilioWebhook_1.default);
app.use('/webhook/twilio/inbound', twilioInbound_1.default);
app.use('/webhook/whatsapp', whatsappWebhook_1.default);
app.use('/webhook/social-wifi', socialWifiWebhook_1.default);
app.use('/webhook/brevo', brevoWebhook_1.default);
app.use('/t', tracking_1.default);
app.use('/u', unsubscribe_1.default);
app.use('/internal', internal_1.default);
app.use('/verify', verify_1.default);
// Public, unauthenticated pricing feed for the marketing site (api.heidifi.ai).
app.use('/public', publicPricing_1.default);
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
/**
 * Guest verification depends on env that has historically gone unprovisioned
 * (UNSUBSCRIBE_SIGNING_SECRET and INTERNAL_API_SECRET are both documented and
 * both absent in production). A venue with verification switched on and a
 * missing secret silently connects guests unverified, so say so at boot rather
 * than let it be discovered from a support ticket.
 */
function logVerificationReadiness() {
    if (!(0, verificationToken_1.verificationSubsystemReady)()) {
        console.warn('[VERIFICATION] Disabled: set GUEST_VERIFICATION_SIGNING_SECRET and GUEST_OTP_PEPPER. '
            + 'Venues requiring verification will connect guests UNVERIFIED until then.');
        return;
    }
    const missing = verificationConfig_1.VERIFICATION_CHANNELS.filter((c) => !(0, verificationConfig_1.channelConfigured)(c));
    if (missing.length) {
        console.warn(`[VERIFICATION] Channels unavailable (provider env unset): ${missing.join(', ')}`);
    }
    if (!(0, clientIp_1.portalSecretConfigured)()) {
        console.warn('[VERIFICATION] PORTAL_SHARED_SECRET unset — per-IP OTP rate limits are disabled '
            + '(every guest arrives with the portal container IP). Per-destination and per-AP limits still apply.');
    }
}
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    logVerificationReadiness();
    (0, apMonitor_1.startApMonitor)();
    (0, campaignScheduler_1.startCampaignScheduler)();
});
