import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import captiveRoutes from './routes/captive';
import smsRoutes from './routes/sms';
import emailRoutes from './routes/email';
import twilioWebhookRoutes from './routes/twilioWebhook';
import twilioInboundRoutes from './routes/twilioInbound';
import whatsappWebhookRoutes from './routes/whatsappWebhook';
import socialWifiWebhookRoutes from './routes/socialWifiWebhook';
import brevoWebhookRoutes from './routes/brevoWebhook';
import trackingRoutes from './routes/tracking';
import unsubscribeRoutes from './routes/unsubscribe';
import internalRoutes from './routes/internal';
import verifyRoutes from './routes/verify';
import publicPricingRoutes from './routes/publicPricing';
import { startApMonitor } from './jobs/apMonitor';
import { startCampaignScheduler } from './jobs/campaignScheduler';
import { channelConfigured, VERIFICATION_CHANNELS } from './services/verificationConfig';
import { verificationSubsystemReady } from './services/verificationToken';
import { portalSecretConfigured } from './services/clientIp';

const app = express();
const PORT = 4000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use('/', captiveRoutes);
app.use('/schedule-sms', smsRoutes);
app.use('/schedule-email', emailRoutes);
app.use('/webhook/twilio/sms-status', twilioWebhookRoutes);
app.use('/webhook/twilio/inbound', twilioInboundRoutes);
app.use('/webhook/whatsapp', whatsappWebhookRoutes);
app.use('/webhook/social-wifi', socialWifiWebhookRoutes);
app.use('/webhook/brevo', brevoWebhookRoutes);
app.use('/t', trackingRoutes);
app.use('/u', unsubscribeRoutes);
app.use('/internal', internalRoutes);
app.use('/verify', verifyRoutes);
// Public, unauthenticated pricing feed for the marketing site (api.heidifi.ai).
app.use('/public', publicPricingRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/**
 * Guest verification depends on env that has historically gone unprovisioned
 * (UNSUBSCRIBE_SIGNING_SECRET and INTERNAL_API_SECRET are both documented and
 * both absent in production). A venue with verification switched on and a
 * missing secret silently connects guests unverified, so say so at boot rather
 * than let it be discovered from a support ticket.
 */
function logVerificationReadiness(): void {
  if (!verificationSubsystemReady()) {
    console.warn(
      '[VERIFICATION] Disabled: set GUEST_VERIFICATION_SIGNING_SECRET and GUEST_OTP_PEPPER. '
      + 'Venues requiring verification will connect guests UNVERIFIED until then.',
    );
    return;
  }
  const missing = VERIFICATION_CHANNELS.filter((c) => !channelConfigured(c));
  if (missing.length) {
    console.warn(`[VERIFICATION] Channels unavailable (provider env unset): ${missing.join(', ')}`);
  }
  if (!portalSecretConfigured()) {
    console.warn(
      '[VERIFICATION] PORTAL_SHARED_SECRET unset — per-IP OTP rate limits are disabled '
      + '(every guest arrives with the portal container IP). Per-destination and per-AP limits still apply.',
    );
  }
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  logVerificationReadiness();
  startApMonitor();
  startCampaignScheduler();
});
