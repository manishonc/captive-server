// Mapping HeidiFi API failures onto the app's error vocabulary.
//
// Split out of api.ts so it can be unit-tested — api.ts imports electron and therefore
// cannot run under `node --test`.

/** Server `code` strings -> our vocabulary. Anything unlisted falls through to status. */
const SERVER_CODE_MAP: Record<string, AdoptionErrorCode> = {
  invalid_code: 'BAD_CODE',
  adoption_unavailable: 'UNAVAILABLE',
  too_many_requests: 'RATE_LIMITED',
  daily_limit_reached: 'DAILY_LIMIT',
  venue_not_found: 'VENUE_GONE',
  venue_forbidden: 'VENUE_GONE',
  device_not_pending: 'DEVICE_NOT_READY',
  mac_registered_elsewhere: 'MAC_CONFLICT',
  invalid_ssid: 'SSID_INVALID',
  ssid_conflict_existing: 'SSID_NEEDS_CONFIRM',
  plan_limit_access_points: 'PLAN_LIMIT',
  subscription_lapsed: 'SUBSCRIPTION_LAPSED',
};

/**
 * Fallback when the body carried no code we recognise.
 *
 * The 404 case is the subtle one and worth getting right: this API answers a bad code with a
 * 400 and a JSON body, so a BARE 404 means the route does not exist — an old captive-server
 * that predates /adoption. Mapping that to BAD_CODE would tell someone their code is wrong
 * when the real problem is a server they cannot see, which is the worst possible message.
 */
export function statusToCode(status: number, hasJsonBody: boolean): AdoptionErrorCode {
  if (status === 402) return 'SUBSCRIPTION_LAPSED';
  if (status === 404 && !hasJsonBody) return 'VERSION_UNSUPPORTED';
  if (status === 410 || status === 426) return 'VERSION_UNSUPPORTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  return 'SERVER_ERROR';
}

/** Resolve a failed response to an error code, preferring the server's own `code`. */
export function mapFailure(status: number, body: unknown): AdoptionErrorCode {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && SERVER_CODE_MAP[code]) return SERVER_CODE_MAP[code];
  return statusToCode(status, body !== null && body !== undefined);
}
