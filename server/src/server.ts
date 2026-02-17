import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { db } from './firebase';
import { FieldValue } from 'firebase-admin/firestore';

const app = express();
const PORT = 4000;

app.use(bodyParser.json());

app.post('/create-user', async (req: Request, res: Response) => {
  const { name, email, mac, ip, url, post } = req.body;
  const timestamp = req.body.timestamp || new Date().toISOString();

  const doc = {
    name: name || '',
    email: email || '',
    mac: mac || '',
    ip: ip || '',
    url: url || '',
    post: post || '',
    timestamp,
    createdAt: FieldValue.serverTimestamp(),
  };

  try {
    const ref = await db.collection('Router_Users').add(doc);
    console.log('[NEW CONNECTION]', ref.id, JSON.stringify(doc));
    res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error('[FIRESTORE ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to save user' });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
