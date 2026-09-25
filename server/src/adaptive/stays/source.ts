/**
 * Where a feed's calendar text comes from.
 *
 * Production: the safe fetcher (stays/fetch.ts) — public https only.
 *
 * The local sandbox (D-C23, a departure from the plan's "local calendar file"): a feed
 * link `sandbox:calendar/<name>` reads `CaptivePortal_AdaptiveSandboxCalendars/<name>`
 * from the emulator, only when `sandboxEnabled()` (ADAPTIVE_SANDBOX=1 + the emulator).
 * The API, the worker and the tests all share the emulator, so the API's dev route, a
 * worker in another container and the skill's set-stay.sh see the same calendar — no
 * file, no loopback HTTP, no secret header. Anywhere else a `sandbox:` link is refused
 * like any other non-https link.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { sandboxEnabled } from '../engine/clock';
import { sha256Hex } from '../core/checksum';
import { FeedFetchError, fetchFeed, type FetchFeedResult } from './fetch';

const SANDBOX_PREFIX = 'sandbox:calendar/';
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The calendar name of a `sandbox:calendar/<name>` link (null for any other link). */
export function sandboxCalendarName(url: string): string | null {
  if (!url.toLowerCase().startsWith(SANDBOX_PREFIX)) return null;
  const name = url.slice(SANDBOX_PREFIX.length).trim().toLowerCase();
  return NAME.test(name) ? name : null;
}

export function isSandboxLink(url: string): boolean {
  return url.toLowerCase().startsWith(SANDBOX_PREFIX);
}

export function sandboxCalendarRef(name: string) {
  return db.collection(COL.sandboxCalendars).doc(name);
}

/** Stores a sandbox calendar's text (dev routes and tests only). */
export async function putSandboxCalendar(name: string, ics: string): Promise<{ etag: string }> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  const etag = `"${sha256Hex(ics).slice(0, 16)}"`;
  await sandboxCalendarRef(name).set({ name, ics, etag, updatedAt: new Date() });
  return { etag };
}

/** A sandbox calendar read like an HTTP feed: 200 with the text and an ETag, a 304 for the same ETag, a 404 when missing. */
async function readSandboxCalendar(name: string, etag: string | null): Promise<FetchFeedResult> {
  const snap = await sandboxCalendarRef(name).get();
  if (!snap.exists) return { status: 404, etag: null };
  const current = String(snap.get('etag') ?? '');
  if (etag && current && etag === current) return { status: 304, etag: current };
  return { status: 200, etag: current || null, body: Buffer.from(String(snap.get('ics') ?? ''), 'utf8') };
}

/** Reads a feed's calendar: the sandbox calendar (sandbox only) or the safe network fetch. Throws only `FeedFetchError`. */
export async function fetchStayCalendar(url: string, etag: string | null): Promise<FetchFeedResult> {
  if (isSandboxLink(url)) {
    const name = sandboxCalendarName(url);
    if (!sandboxEnabled()) throw new FeedFetchError('NOT_HTTPS');
    if (!name) throw new FeedFetchError('BAD_URL');
    try {
      return await readSandboxCalendar(name, etag);
    } catch {
      throw new FeedFetchError('NETWORK');
    }
  }
  return fetchFeed(url, { etag });
}

export interface SandboxStay {
  uid: string;
  checkIn: string;
  checkOut: string;
}

/** An Airbnb-shaped calendar for the sandbox (made-up codes, no names, no phone digits). */
export function buildSandboxCalendar(stays: SandboxStay[], stampMs: number): string {
  const stamp = new Date(stampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN', 'CALSCALE:GREGORIAN', 'VERSION:2.0'];
  stays.forEach((s, i) => {
    lines.push(
      'BEGIN:VEVENT',
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${s.checkIn.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${s.checkOut.replace(/-/g, '')}`,
      'SUMMARY:Reserved',
      `UID:${s.uid}`,
      `DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMSANDBOX${i + 1}`,
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
