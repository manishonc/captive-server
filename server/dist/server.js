"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const firebase_1 = require("./firebase");
const firestore_1 = require("firebase-admin/firestore");
const app = (0, express_1.default)();
const PORT = 4000;
app.use(body_parser_1.default.json());
app.post('/create-user', async (req, res) => {
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
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    };
    try {
        const ref = await firebase_1.db.collection('Router_Users').add(doc);
        console.log('[NEW CONNECTION]', ref.id, JSON.stringify(doc));
        res.json({ success: true, id: ref.id });
    }
    catch (err) {
        console.error('[FIRESTORE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to save user' });
    }
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
