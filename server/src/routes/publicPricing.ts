/**
 * Public, unauthenticated pricing feed for the marketing site. Mounted at
 * `/public`, served from api.heidifi.ai.
 *
 *   GET /public/pricing
 *     -> { plans: [...], trialDays: 14 | null, trialRequiresCard: boolean }
 *
 * The field allowlist — the thing keeping internal plan data off the public
 * internet — lives in services/publicPricing.ts so it is pure and testable.
 * This file is only the transport: Firestore query, CORS, cache.
 *
 * A plan appears only when it is active, not a trial plan, and an admin has
 * ticked `marketing.publicVisible`. Publication is opt-in so a half-configured
 * plan cannot reach the pricing page by accident.
 */

import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import {
  comparePublicPlans,
  isPublishable,
  serializePublicPlan,
  serializePublicPrice,
  trialDaysFrom,
  trialRequiresCardFrom,
  type PublicPricing,
} from '../services/publicPricing';

const router = Router();
const PLANS = 'CaptivePortal_Plans';
const SETTINGS = 'CaptivePortal_Settings';

/** Cache the assembled payload — this is a marketing page, it spikes. */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { value: PublicPricing; expiresAt: number } | null = null;

/** Origins allowed to read this cross-origin. */
const ALLOWED_ORIGINS = (
  process.env.PUBLIC_PRICING_ORIGINS || 'https://heidifi.ai,https://www.heidifi.ai'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

type Raw = Record<string, unknown>;

/** Read the published plans straight from Firestore. */
export async function buildPublicPricing(): Promise<PublicPricing> {
  // One extra read, behind the 5-minute cache below, so it costs effectively
  // nothing per request.
  const [snapshot, settingsDoc] = await Promise.all([
    db.collection(PLANS).where('status', '==', 'active').get(),
    db.collection(SETTINGS).doc('global').get(),
  ]);

  const candidates = snapshot.docs.filter((doc) => isPublishable(doc.data() as Raw));

  const plans = await Promise.all(
    candidates.map(async (doc) => {
      const pricesSnap = await doc.ref.collection('prices').where('status', '==', 'active').get();
      const prices = pricesSnap.docs.map((p) => serializePublicPrice(p.data() as Raw));
      return serializePublicPlan(doc.data() as Raw, prices);
    }),
  );
  plans.sort(comparePublicPlans);

  const trialDoc = snapshot.docs.find((doc) => (doc.data() as Raw).isFreeTrial === true);
  return {
    plans,
    trialDays: trialDaysFrom(trialDoc?.data() as Raw | undefined),
    trialRequiresCard: trialRequiresCardFrom(settingsDoc.data() as Raw | undefined),
  };
}

function applyCors(req: Request, res: Response): void {
  const origin = req.header('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // The allow-header varies by request origin, so a shared cache must key on it.
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

router.options('/pricing', (req: Request, res: Response) => {
  applyCors(req, res);
  res.status(204).end();
});

router.get('/pricing', async (req: Request, res: Response) => {
  applyCors(req, res);
  try {
    if (!cache || cache.expiresAt <= Date.now()) {
      cache = { value: await buildPublicPricing(), expiresAt: Date.now() + CACHE_TTL_MS };
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(cache.value);
  } catch (err) {
    console.error('[public-pricing] failed:', err);
    // Serve a stale cache rather than nothing — the marketing page dropping to
    // its bundled copy is worse than pricing that is a few minutes old.
    if (cache) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(cache.value);
      return;
    }
    res.status(500).json({ error: 'Failed to load pricing' });
  }
});

export default router;
