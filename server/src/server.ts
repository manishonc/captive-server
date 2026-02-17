import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';

const app = express();
const PORT = 4000;

app.use(bodyParser.json());

app.post('/create-user', (req: Request, res: Response) => {
  const data = { ...req.body };
  if (!data.timestamp) {
    data.timestamp = new Date().toISOString();
  }
  console.log('[NEW CONNECTION]', JSON.stringify(data));
  res.json({ success: true, message: 'Connection logged' });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
