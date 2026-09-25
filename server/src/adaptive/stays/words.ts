/**
 * The owner's words for a calendar feed's error codes and warnings. The feed stores
 * only the code (`lastError`), never a raw error message — a Node message can carry the
 * link — so the sentence is derived here when it is shown. Pure.
 */

const WORDS: Record<string, string> = {
  BAD_URL: "That calendar link isn't valid.",
  BAD_REDIRECT: "That calendar link isn't valid.",
  NOT_HTTPS: 'The link must start with https:// (or webcal://).',
  CREDENTIALS_IN_URL: 'The link must not contain a user name or password.',
  BAD_PORT: "The link doesn't point to a public calendar.",
  IP_LITERAL: "The link doesn't point to a public calendar.",
  BLOCKED_HOST: "The link doesn't point to a public calendar.",
  BLOCKED_ADDRESS: "The link doesn't point to a public calendar.",
  DNS_FAILED: "The calendar's address could not be found.",
  TIMEOUT: 'The calendar took too long to answer.',
  TOO_LARGE: 'The calendar file is too big (over 1 MB).',
  BAD_ENCODING: "The link didn't return a calendar file.",
  NOT_ICAL: "The link didn't return a calendar file.",
  TRUNCATED: 'The calendar file arrived incomplete.',
  PARSE_FAILED: "The calendar file couldn't be read.",
  REDIRECT_WITHOUT_LOCATION: 'The link redirects somewhere we could not follow.',
  TOO_MANY_REDIRECTS: 'The link redirects too many times.',
  TLS: "The calendar's secure connection failed.",
  NETWORK: 'The calendar could not be reached.',
  LINK_INVALID: 'The link no longer works — it may have been reset. Copy it again from your booking site.',
  HTTP_401: 'The calendar refused access.',
  HTTP_403: 'The calendar refused access.',
  HTTP_429: 'The calendar site asked us to slow down — we will try again.',
  unsupported_source: "This calendar type can't be used yet.",
  mass_missing: 'Several bookings disappeared from the calendar at once — we wait 24 hours before treating them as cancelled.',
};

export function feedWords(code: string | null | undefined): string | null {
  if (!code) return null;
  if (WORDS[code]) return WORDS[code];
  if (/^HTTP_5\d\d$/.test(code)) return 'The calendar site had a problem — we will try again.';
  if (/^HTTP_\d{3}$/.test(code)) return "The calendar link didn't answer as expected.";
  return 'The calendar could not be read.';
}

/** An HTTP status that isn't 200 / 304 → a stored code. */
export function statusCode(status: number): string {
  if (status === 400 || status === 404 || status === 410) return 'LINK_INVALID';
  return `HTTP_${status}`;
}

/**
 * The saved link as the owner sees it: `https://www.airbnb.com/….ics` — the host and
 * whether it is an `.ics` file, nothing of the path or query (some sites put the secret in
 * the path). A sandbox link (`sandbox:calendar/<name>`) holds no secret and is shown as is.
 */
export function maskFeedUrl(url: string): string {
  if (url.toLowerCase().startsWith('sandbox:')) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…${u.pathname.toLowerCase().endsWith('.ics') ? '.ics' : ''}`;
  } catch {
    return '(hidden)';
  }
}
