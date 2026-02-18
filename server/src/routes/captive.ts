import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { CreateUserRequestBody, CaptivePortalUserDocument } from '../types/captive';

const router = Router();

router.post('/create-user', async (req: Request<{}, {}, CreateUserRequestBody>, res: Response) => {
  const { name, email, mac, ip, url, post } = req.body;
  const timestamp = req.body.timestamp || new Date().toISOString();

  let captivePortalAccessPointId: string | null = null;

  try {
    const snapshot = await db
      .collection('CaptivePortal_AccessPoints')
      .where('mac', '==', mac || '')
      .limit(1)
      .get();

    if (!snapshot.empty) {
      captivePortalAccessPointId = snapshot.docs[0].id;
    } else {
      console.warn('[MAC LOOKUP] No access point found for MAC:', mac);
    }
  } catch (err) {
    console.error('[MAC LOOKUP ERROR]', err);
  }

  const doc: CaptivePortalUserDocument = {
    name: name || '',
    email: email || '',
    mac: mac || '',
    ip: ip || '',
    url: url || '',
    post: post || '',
    timestamp,
    createdAt: FieldValue.serverTimestamp(),
    captivePortalAccessPointId,
  };

  try {
    const ref = await db.collection('CaptivePortal_Users').add(doc);
    console.log('[NEW CONNECTION]', ref.id, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
    res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error('[FIRESTORE ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to save user' });
  }
});

export default router;
