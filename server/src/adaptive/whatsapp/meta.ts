/**
 * Meta's WhatsApp Business Management API for templates (PR W1): the only file that talks to
 * graph.facebook.com about templates. Sending messages stays in services/whatsapp.ts (untouched;
 * W3 brings Adaptive's own sender).
 *
 *  - One pinned Graph version (v19.0/v20.0 have expired; v25.0 is available until July 2028).
 *  - 15 s timeout, `redirect: 'error'`, the token only in the Authorization header (debug_token is
 *    the one call that also names it in `input_token`). Paging follows `paging.cursors.after` —
 *    never `paging.next`, whose URL carries the token. No URL is ever logged or put in an error.
 *  - Every error becomes a `MetaError` of one kind; a POST that got no answer (timeout, network,
 *    5xx) is `unknown` — it may have been created — and is never retried here.
 *  - Env is read at call time. Under the Firestore emulator this client refuses every call: the
 *    local `.env` holds the real keys, and a test must never create templates on the real account.
 *  - One console line per call: `[WA META] GET message_templates 200 312ms` (no token, no query).
 */

import type { MetaComponent } from '../core/whatsapp/template';

export const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 60;
const TEMPLATE_FIELDS = 'id,name,language,status,category,previous_category,rejected_reason,quality_score,components,parameter_format';
/** If Meta ever refuses one of the optional fields above, the list still works with these. */
const TEMPLATE_FIELDS_MIN = 'id,name,language,status,category,components';

export { MetaError, type MetaErrorInfo, type MetaErrorKind } from './metaError';
import { MetaError, type MetaErrorInfo } from './metaError';

export interface MetaTemplateCreate {
  name: string;
  language: string;
  category: string;
  components: MetaComponent[];
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

export interface MetaClient {
  readonly kind: 'meta' | 'sandbox';
  /** Configured (token + phone number id) and allowed here (never under the emulator). */
  ready(): boolean;
  phoneNumberId(): string | null;
  debugToken(): Promise<{ valid: boolean; scopes: string[]; wabaIds: string[]; expiresAt: number | null }>;
  phoneNumbers(wabaId: string): Promise<PhoneNumberInfo[]>;
  /**
   * Every template of the WABA; `complete` false when a page limit or the time budget stopped it;
   * `minimal` when Meta refused an optional field and only the basic ones were read (quality,
   * rejection reason, previous category unknown — the caller keeps what it had).
   */
  listTemplates(wabaId: string, opts?: { budgetMs?: number }): Promise<{ templates: unknown[]; complete: boolean; pages: number; minimal?: boolean }>;
  /** One template by Meta id; null when Meta says it doesn't exist. */
  getTemplate(id: string): Promise<unknown | null>;
  /** Templates with this name (every language); the caller matches name and language exactly. */
  findByName(wabaId: string, name: string): Promise<unknown[]>;
  createTemplate(wabaId: string, body: MetaTemplateCreate): Promise<{ id: string; status: string | null; category: string | null }>;
  editTemplate(id: string, body: { components: MetaComponent[]; category?: string }): Promise<{ ok: boolean }>;
}

// ── Errors ───────────────────────────────────────────────────────────────────

const RATE_CODES = new Set([4, 17, 32, 613, 80004, 80008, 130429]);
const SETUP_CODES = new Set([190, 102, 463, 467]);

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const strOrNull = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** No token, no link, capped: safe for the log, the API answer and an alert email. */
export function scrubMetaText(s: string): string {
  return s
    .replace(/(access|input)_token=[^&\s"']+/gi, '$1_token=…')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bEAA[A-Za-z0-9]{20,}\b/g, '[token]')
    .slice(0, 300);
}

function retryAfterMs(headers: Headers | null): number | null {
  if (!headers) return null;
  let best: number | null = null;
  const ra = Number(headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) best = ra * 1000;
  const usage = headers.get('x-business-use-case-usage');
  if (usage) {
    try {
      const parsed = JSON.parse(usage) as Record<string, Array<Record<string, unknown>>>;
      for (const list of Object.values(parsed)) {
        for (const u of list ?? []) {
          const minutes = Number(u.estimated_time_to_regain_access);
          if (Number.isFinite(minutes) && minutes > 0) best = Math.max(best ?? 0, minutes * 60_000);
        }
      }
    } catch {
      // not JSON: ignore
    }
  }
  return best === null ? null : Math.min(best, 60 * 60_000);
}

/** Meta's error answer → one kind. `method` matters for 5xx: a POST may have worked. */
export function classifyMetaError(method: 'GET' | 'POST', status: number, json: unknown, headers: Headers | null): MetaError {
  const e = (json && typeof json === 'object' ? ((json as Record<string, unknown>).error as Record<string, unknown> | undefined) : undefined) ?? {};
  const code = numOrNull(e.code);
  const subcode = numOrNull(e.error_subcode);
  const raw = strOrNull(e.error_user_msg) || strOrNull(e.error_user_title) || strOrNull(e.message) || `HTTP ${status}`;
  const msg = scrubMetaText(raw);
  const info: MetaErrorInfo = { status, code, subcode, type: strOrNull(e.type, 60), fbtraceId: strOrNull(e.fbtrace_id, 60), retryAfterMs: retryAfterMs(headers) };
  if (status === 401 || (code !== null && SETUP_CODES.has(code))) return new MetaError('setup', msg, info);
  if (status === 429 || (code !== null && RATE_CODES.has(code))) return new MetaError('rate_limited', msg, info);
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299) || status === 403) return new MetaError('permission', msg, info);
  if (/being deleted|is deleted|pending deletion/i.test(raw)) return new MetaError('locked', msg, info);
  if (subcode === 2388024 || /already exists/i.test(raw)) return new MetaError('already_exists', msg, info);
  if (status === 404 || code === 803 || (code === 100 && subcode === 33)) return new MetaError('not_found', msg, info);
  if (status >= 500 || code === 1 || code === 2) return new MetaError(method === 'POST' ? 'unknown' : 'unavailable', msg, info);
  if (code === 100 || status === 400) return new MetaError('invalid', msg, info);
  return new MetaError(method === 'POST' ? 'unknown' : 'unavailable', msg, info);
}

// ── The client ───────────────────────────────────────────────────────────────

export interface MetaClientDeps {
  fetchImpl?: typeof fetch;
  env?: () => { token: string | undefined; phoneNumberId: string | undefined; emulator: boolean };
  log?: (line: string) => void;
  timeoutMs?: number;
}

const defaultEnv = () => ({
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
});

export function createMetaClient(deps: MetaClientDeps = {}): MetaClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? defaultEnv;
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  async function call(method: 'GET' | 'POST', path: string, label: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const { token, emulator } = env();
    if (emulator) throw new MetaError('setup', 'The real Meta account is never used with the Firestore emulator (the sandbox Meta is)');
    if (!token) throw new MetaError('setup', 'WhatsApp is not configured on this server (no access token)');
    const url = new URL(GRAPH_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    let status = 0;
    try {
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: ctrl.signal,
          redirect: 'error',
        });
      } catch {
        throw new MetaError(
          method === 'POST' ? 'unknown' : 'unavailable',
          method === 'POST' ? 'No answer from Meta (timeout or network): it may or may not have arrived' : 'Meta could not be reached (timeout or network)',
          { status: null },
        );
      }
      status = res.status;
      let text = '';
      try {
        text = await res.text();
      } catch {
        throw new MetaError(method === 'POST' ? 'unknown' : 'unavailable', 'Meta’s answer could not be read', { status });
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const hasError = Boolean(json && typeof json === 'object' && (json as Record<string, unknown>).error);
      if (res.ok && !hasError) return (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
      throw classifyMetaError(method, res.status, json, res.headers);
    } finally {
      clearTimeout(timer);
      log(`[WA META] ${method} ${label} ${status || 'no-answer'} ${Date.now() - started}ms`);
    }
  }

  async function listPage(wabaId: string, fields: string, after: string | null) {
    return call('GET', `/${encodeURIComponent(wabaId)}/message_templates`, 'message_templates', {
      query: { fields, limit: '100', ...(after ? { after } : {}) },
    });
  }

  return {
    kind: 'meta',
    ready() {
      const e = env();
      return Boolean(e.token && e.phoneNumberId) && !e.emulator;
    },
    phoneNumberId() {
      return env().phoneNumberId || null;
    },
    async debugToken() {
      const { token } = env();
      const json = await call('GET', '/debug_token', 'debug_token', { query: { input_token: String(token ?? '') } });
      const data = (json.data ?? {}) as Record<string, unknown>;
      const scopes = Array.isArray(data.scopes) ? (data.scopes as unknown[]).map(String) : [];
      const granular = Array.isArray(data.granular_scopes) ? (data.granular_scopes as Array<Record<string, unknown>>) : [];
      const mgmt = granular.find((g) => g.scope === 'whatsapp_business_management');
      const wabaIds = Array.isArray(mgmt?.target_ids) ? (mgmt!.target_ids as unknown[]).map(String) : [];
      const exp = numOrNull(data.expires_at);
      return { valid: data.is_valid === true, scopes, wabaIds, expiresAt: exp && exp > 0 ? exp * 1000 : null };
    },
    async phoneNumbers(wabaId) {
      const json = await call('GET', `/${encodeURIComponent(wabaId)}/phone_numbers`, 'phone_numbers', {
        query: { fields: 'id,display_phone_number,verified_name,quality_rating', limit: '50' },
      });
      const rows = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        displayPhoneNumber: strOrNull(r.display_phone_number, 40),
        verifiedName: strOrNull(r.verified_name, 120),
        qualityRating: strOrNull(r.quality_rating, 20),
      }));
    },
    async listTemplates(wabaId, opts = {}) {
      const budget = opts.budgetMs ?? 60_000;
      const started = Date.now();
      const templates: unknown[] = [];
      let fields = TEMPLATE_FIELDS;
      let after: string | null = null;
      let pages = 0;
      for (;;) {
        let json: Record<string, unknown>;
        try {
          json = await listPage(wabaId, fields, after);
        } catch (err) {
          // A field Meta doesn't know (code 100 on the first page): retry once with the basic fields.
          if (err instanceof MetaError && err.kind === 'invalid' && pages === 0 && fields === TEMPLATE_FIELDS) {
            fields = TEMPLATE_FIELDS_MIN;
            continue;
          }
          throw err;
        }
        pages += 1;
        // A 2xx without a list is not "no templates": it must never read as "everything was deleted".
        if (!Array.isArray(json.data)) throw new MetaError('unavailable', 'Meta’s answer had no template list');
        templates.push(...(json.data as unknown[]));
        const paging = (json.paging ?? {}) as Record<string, unknown>;
        const cursors = (paging.cursors ?? {}) as Record<string, unknown>;
        const nextAfter = paging.next && typeof cursors.after === 'string' ? cursors.after : null;
        const minimal = fields === TEMPLATE_FIELDS_MIN;
        if (!nextAfter) return { templates, complete: true, pages, minimal };
        if (pages >= MAX_PAGES || Date.now() - started > budget) return { templates, complete: false, pages, minimal };
        after = nextAfter;
      }
    },
    async getTemplate(id) {
      // A 2xx that isn't a template is "unavailable", never "gone" (null means Meta said it doesn't exist).
      const sure = (json: Record<string, unknown>) => {
        if (typeof json.id !== 'string' || !json.id) throw new MetaError('unavailable', 'Meta’s answer was not a template');
        return json;
      };
      try {
        return sure(await call('GET', `/${encodeURIComponent(id)}`, 'template', { query: { fields: TEMPLATE_FIELDS } }));
      } catch (err) {
        if (err instanceof MetaError && err.kind === 'not_found') return null;
        if (err instanceof MetaError && err.kind === 'invalid') {
          try {
            return sure(await call('GET', `/${encodeURIComponent(id)}`, 'template', { query: { fields: TEMPLATE_FIELDS_MIN } }));
          } catch (again) {
            if (again instanceof MetaError && again.kind === 'not_found') return null;
            throw again;
          }
        }
        throw err;
      }
    },
    async findByName(wabaId, name) {
      const json = await call('GET', `/${encodeURIComponent(wabaId)}/message_templates`, 'message_templates_by_name', {
        query: { name, fields: TEMPLATE_FIELDS, limit: '100' },
      });
      // A 2xx without a list is "couldn't ask", never "no such template".
      if (!Array.isArray(json.data)) throw new MetaError('unavailable', 'Meta’s answer had no template list');
      return (json.data as Array<Record<string, unknown>>).filter((r) => r.name === name);
    },
    async createTemplate(wabaId, body) {
      const json = await call('POST', `/${encodeURIComponent(wabaId)}/message_templates`, 'create_template', { body });
      const id = strOrNull(json.id, 64);
      if (!id) throw new MetaError('unknown', 'Meta answered without a template id');
      return { id, status: strOrNull(json.status, 40), category: strOrNull(json.category, 40) };
    },
    async editTemplate(id, body) {
      const json = await call('POST', `/${encodeURIComponent(id)}`, 'edit_template', { body });
      if (json.success === false) throw new MetaError('invalid', 'Meta did not accept the edit');
      return { ok: true };
    },
  };
}
