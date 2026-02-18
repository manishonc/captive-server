"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const firebase_1 = require("../firebase");
const firestore_1 = require("firebase-admin/firestore");
const router = (0, express_1.Router)();
router.post('/create-user', async (req, res) => {
    const { name, email, mac, apmac, ip, url, post } = req.body;
    const timestamp = req.body.timestamp || new Date().toISOString();
    let captivePortalAccessPointId = null;
    try {
        const snapshot = await firebase_1.db
            .collection('CaptivePortal_AccessPoints')
            .where('mac', '==', apmac || '')
            .limit(1)
            .get();
        if (!snapshot.empty) {
            captivePortalAccessPointId = snapshot.docs[0].id;
        }
        else {
            console.warn('[APMAC LOOKUP] No access point found for apmac:', apmac);
        }
    }
    catch (err) {
        console.error('[APMAC LOOKUP ERROR]', err);
    }
    const doc = {
        name: name || '',
        email: email || '',
        mac: mac || '',
        ip: ip || '',
        url: url || '',
        post: post || '',
        timestamp,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
        captivePortalAccessPointId,
    };
    try {
        const ref = await firebase_1.db.collection('CaptivePortal_Users').add(doc);
        console.log('[NEW CONNECTION]', ref.id, JSON.stringify({ ...doc, createdAt: 'serverTimestamp' }));
        res.json({ success: true, id: ref.id });
    }
    catch (err) {
        console.error('[FIRESTORE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to save user' });
    }
});
exports.default = router;
