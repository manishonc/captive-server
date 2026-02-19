import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { CreateUserRequestBody, CaptivePortalUserDocument, ConsentRecord } from '../types/captive';

const router = Router();

const defaultConsent = (): ConsentRecord => ({
  given: false,
  timestamp: new Date().toISOString(),
  version: '1.0',
});

router.post('/create-user', async (req: Request<{}, {}, CreateUserRequestBody>, res: Response) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    phoneCountryCode,
    mac,
    apmac,
    ip,
    url,
    post,
    privacyPolicyConsent,
    termsConsent,
    marketingConsent,
  } = req.body;
  const timestamp = req.body.timestamp || new Date().toISOString();

  let captivePortalAccessPointId: string | null = null;

  try {
    const snapshot = await db
      .collection('CaptivePortal_AccessPoints')
      .where('mac', '==', apmac || '')
      .limit(1)
      .get();

    if (!snapshot.empty) {
      captivePortalAccessPointId = snapshot.docs[0].id;
    } else {
      console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
    }
  } catch (err) {
    console.error('[APMAC LOOKUP ERROR]', err);
  }

  const doc: CaptivePortalUserDocument = {
    firstName: firstName || '',
    lastName: lastName || '',
    email: email || '',
    phone: phone || '',
    phoneCountryCode: phoneCountryCode || '',
    mac: mac || '',
    ip: ip || '',
    url: url || '',
    post: post || '',
    timestamp,
    createdAt: FieldValue.serverTimestamp(),
    captivePortalAccessPointId,
    marketingOptIn: marketingConsent?.given ?? false,
    privacyPolicyConsent: privacyPolicyConsent || defaultConsent(),
    termsConsent: termsConsent || defaultConsent(),
    marketingConsent: marketingConsent || defaultConsent(),
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

router.get('/privacy-policy', async (_req, res) => {
  try {
    const doc = await db
      .collection('CaptivePortal_Documents')
      .doc('rNhSj8HUmTNpwOaDgpTC')
      .get();
    if (!doc.exists) return res.status(404).json({ success: false });
    const data = doc.data();
    res.json({ success: true, title: data?.title, content: data?.latestContent });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

export default router;
