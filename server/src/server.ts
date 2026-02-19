import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import captiveRoutes from './routes/captive';
import smsRoutes from './routes/sms';

const app = express();
const PORT = 4000;

app.use(bodyParser.json());
app.use('/', captiveRoutes);
app.use('/schedule-sms', smsRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
