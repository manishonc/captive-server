import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';

export const VISITOR_BASE_URL =
  process.env.VISITOR_BASE_URL || 'https://visit.askheidi.app';

const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SHORT_CODE_LENGTH = 8;
const MAX_COLLISION_RETRIES = 6;

const SHORT_LINKS = 'CaptivePortal_ShortLinks';
const TRACKED_LINK_TEMPLATES = 'CaptivePortal_TrackedLinkTemplates';

function randomCode(): string {
  let out = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    out += SHORT_CODE_ALPHABET[Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)];
  }
  return out;
}

export interface ShortLinkContext {
  venueId: string;
  marketingDocId: string;
  wifiGuestId: string;
  channel: 'sms' | 'email' | 'whatsapp';
}

export interface ShortLinkData extends ShortLinkContext {
  targetType: 'venue-rate' | 'custom';
  targetUrl: string;
  trackedLinkTemplateId?: string;
}

/**
 * Create a short-link doc with a freshly generated code. Retries on
 * ALREADY_EXISTS (hash collision) up to MAX_COLLISION_RETRIES times.
 * Returns the code on success.
 */
export async function createShortLink(data: ShortLinkData): Promise<string> {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const code = randomCode();
    const ref = db.collection(SHORT_LINKS).doc(code);
    try {
      await ref.create({
        code,
        ...data,
        createdAt: FieldValue.serverTimestamp(),
        clicks: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        lastClickIpHash: null,
        lastClickUserAgent: null,
      });
      return code;
    } catch (err: any) {
      if (err?.code === 6 /* ALREADY_EXISTS */ || /ALREADY_EXISTS/i.test(String(err?.message))) {
        continue;
      }
      throw err;
    }
  }
  throw new Error('short-link code collision after max retries');
}

/**
 * If `content` contains the canonical venue rating URL, swap it for a
 * freshly-minted per-send short URL. Returns the possibly-modified content
 * and the code (or null if no swap happened).
 */
export async function swapVenueRatingUrl(
  content: string,
  ctx: ShortLinkContext,
): Promise<{ content: string; code: string | null }> {
  if (!content) return { content, code: null };
  const rateUrl = `${VISITOR_BASE_URL}/${encodeURIComponent(ctx.venueId)}/rate`;
  if (!content.includes(rateUrl)) return { content, code: null };

  const code = await createShortLink({
    targetType: 'venue-rate',
    targetUrl: rateUrl,
    ...ctx,
  });
  const shortUrl = `${VISITOR_BASE_URL}/s/${code}`;
  return { content: content.split(rateUrl).join(shortUrl), code };
}

/**
 * Scan `content` for tracked-link template placeholders of the form
 * `${VISITOR_BASE_URL}/s/t_<tplId>` and swap each for a per-send short URL.
 * Skips templates that are missing, archived, or belong to a different venue.
 */
export async function swapTrackedLinks(
  content: string,
  ctx: ShortLinkContext,
): Promise<{ content: string; codes: string[] }> {
  if (!content) return { content, codes: [] };

  const escapedBase = VISITOR_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedBase}/s/(tpl_[A-Za-z0-9]+)`, 'g');
  const matches = Array.from(new Set(Array.from(content.matchAll(pattern), (m) => m[1])));
  if (matches.length === 0) return { content, codes: [] };

  let out = content;
  const codes: string[] = [];

  for (const tplId of matches) {
    const tplDoc = await db.collection(TRACKED_LINK_TEMPLATES).doc(tplId).get();
    if (!tplDoc.exists) {
      console.warn('[TRACKED LINK] template missing, leaving placeholder:', tplId);
      continue;
    }
    const tpl = tplDoc.data() || {};
    if (tpl.archived) {
      console.warn('[TRACKED LINK] template archived, leaving placeholder:', tplId);
      continue;
    }
    if (tpl.venueId && tpl.venueId !== ctx.venueId) {
      console.warn(
        '[TRACKED LINK] template belongs to different venue, skipping:',
        { tplId, tplVenue: tpl.venueId, sendVenue: ctx.venueId },
      );
      continue;
    }

    const code = await createShortLink({
      targetType: 'custom',
      targetUrl: String(tpl.targetUrl || ''),
      trackedLinkTemplateId: tplId,
      ...ctx,
    });
    codes.push(code);
    const placeholder = `${VISITOR_BASE_URL}/s/${tplId}`;
    const shortUrl = `${VISITOR_BASE_URL}/s/${code}`;
    out = out.split(placeholder).join(shortUrl);
  }

  return { content: out, codes };
}
