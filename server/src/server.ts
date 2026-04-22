import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import captiveRoutes from './routes/captive';
import smsRoutes from './routes/sms';
import emailRoutes from './routes/email';
import twilioWebhookRoutes from './routes/twilioWebhook';
import whatsappWebhookRoutes from './routes/whatsappWebhook';
import socialWifiWebhookRoutes from './routes/socialWifiWebhook';

const app = express();
const PORT = 4000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use('/', captiveRoutes);
app.use('/schedule-sms', smsRoutes);
app.use('/schedule-email', emailRoutes);
app.use('/webhook/twilio/sms-status', twilioWebhookRoutes);
app.use('/webhook/whatsapp', whatsappWebhookRoutes);
app.use('/webhook/social-wifi', socialWifiWebhookRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
