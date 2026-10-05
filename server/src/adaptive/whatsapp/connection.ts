/**
 * The Meta connection (PR W1) — "Check connection" on the WhatsApp tab. With no new env var:
 *
 *  1. `debug_token` on the server's existing token: is it valid, may it manage templates
 *     (`whatsapp_business_management`), and which WhatsApp Business Accounts it covers.
 *  2. The account is the one whose phone numbers include `WHATSAPP_PHONE_NUMBER_ID` (the number the
 *     server sends from). An admin can type the account id when the token doesn't name it.
 *  3. Saved on `AdaptiveConfig/whatsapp` with the number's quality rating; logged either way.
 *  4. Whether the token's app is subscribed to the account's webhooks (read only): Meta sends
 *     template notices (and, with W3, delivery receipts) only to subscribed apps. "Turn on notices"
 *     (`subscribeNotices`) is the one call that changes it.
 *
 * Nothing else in the template code runs until this has found the account once.
 */

import { MetaError } from './metaError';
import { metaClient } from './source';
import { readOps, updateOps, writeLog, type WaActor, type WaConnection } from './store';

const MANAGE = 'whatsapp_business_management';

export async function checkConnection(by: WaActor, opts: { wabaId?: string | null } = {}): Promise<WaConnection> {
  const client = metaClient();
  const ops = await readOps();
  const problems: string[] = [];
  const conn: WaConnection = {
    ok: false,
    checkedAt: new Date(),
    wabaId: null,
    wabaSource: null,
    canManage: false,
    scopes: [],
    tokenExpiresAt: null,
    phoneNumberId: client.phoneNumberId(),
    phoneFound: false,
    displayPhoneNumber: null,
    verifiedName: null,
    quality: null,
    problems,
    appId: null,
    appName: null,
    notices: 'unknown',
    messagesOverride: false,
    otherApps: [],
    tokenDescribed: false,
  };
  const errors: Array<Record<string, unknown>> = [];

  if (!client.ready()) {
    problems.push(
      process.env.FIRESTORE_EMULATOR_HOST
        ? 'The real Meta account is never used with the local emulator (start the stack with the sandbox)'
        : 'WhatsApp is not configured on this server (WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)',
    );
  } else {
    let tokenWabas: string[] = [];
    try {
      const t = await client.debugToken();
      conn.scopes = t.scopes;
      conn.tokenExpiresAt = t.expiresAt;
      conn.canManage = t.scopes.includes(MANAGE);
      conn.appId = t.appId;
      conn.appName = t.appName;
      conn.tokenDescribed = true;
      tokenWabas = t.wabaIds;
      if (!t.valid) problems.push('The WhatsApp access token is not valid (expired or revoked): create a new System User token and update WHATSAPP_ACCESS_TOKEN');
      else if (!conn.canManage) problems.push('The token can send messages but can’t manage templates: give its System User the whatsapp_business_management permission');
    } catch (err) {
      const e = err instanceof MetaError ? err : null;
      errors.push({ step: 'debug_token', kind: e?.kind ?? 'unknown', message: e?.userMsg ?? 'failed', code: e?.info.code ?? null, fbtraceId: e?.info.fbtraceId ?? null });
      if (e?.kind === 'setup') problems.push('The WhatsApp access token is not valid (expired or revoked)');
      else problems.push('Meta wouldn’t describe the token; checking the account directly');
      // Its expiry is unknown now: the last known one stays (an expiring token keeps its reminder).
      conn.tokenExpiresAt = ops.connection?.tokenExpiresAt ?? null;
      // The token may still manage templates: we learn it from the account reads below.
      conn.canManage = true;
    }

    const candidates = [...new Set([opts.wabaId ?? null, ops.wabaId, ...tokenWabas].filter((x): x is string => Boolean(x)))].slice(0, 5);
    if (!candidates.length) problems.push('Meta doesn’t name the account for this token (normal for an admin system user): type its id. Business Suite → Settings → Accounts → Messaging accounts → the account (before Meta’s account move: WhatsApp accounts), or the app’s WhatsApp → API Setup');
    for (const waba of candidates) {
      try {
        const phones = await client.phoneNumbers(waba);
        const mine = phones.find((p) => p.id === conn.phoneNumberId);
        if (mine) {
          conn.wabaId = waba;
          conn.wabaSource = opts.wabaId === waba || (ops.wabaId === waba && ops.connection?.wabaSource === 'manual') ? 'manual' : 'token';
          conn.phoneFound = true;
          conn.displayPhoneNumber = mine.displayPhoneNumber;
          conn.verifiedName = mine.verifiedName;
          conn.quality = mine.qualityRating;
          break;
        }
      } catch (err) {
        const e = err instanceof MetaError ? err : null;
        errors.push({ step: 'phone_numbers', waba, kind: e?.kind ?? 'unknown', message: e?.userMsg ?? 'failed', code: e?.info.code ?? null, fbtraceId: e?.info.fbtraceId ?? null });
        if (e?.kind === 'permission') conn.canManage = false;
      }
    }
    if (candidates.length && !conn.phoneFound) {
      problems.push('None of these accounts owns the phone number the server sends from (WHATSAPP_PHONE_NUMBER_ID)');
    }
    if (conn.phoneFound && (conn.quality === 'RED' || conn.quality === 'YELLOW')) {
      problems.push(`The phone number’s quality rating is ${conn.quality}: guests are blocking or reporting messages`);
    }
    // Notices: read only. Meta sends the account's webhooks only to the apps subscribed to it.
    if (conn.wabaId && conn.phoneFound) {
      try {
        const apps = await client.subscribedApps(conn.wabaId);
        const ours = conn.appId ? apps.find((a) => a.id === conn.appId) : undefined;
        conn.notices = ours ? 'on' : conn.appId ? 'off' : 'unknown';
        conn.messagesOverride = Boolean(ours?.overrideCallback);
        conn.otherApps = apps.filter((a) => a !== ours).map((a) => a.name ?? a.id).slice(0, 5);
      } catch (err) {
        const e = err instanceof MetaError ? err : null;
        errors.push({ step: 'subscribed_apps', kind: e?.kind ?? 'unknown', message: e?.userMsg ?? 'failed', code: e?.info.code ?? null, fbtraceId: e?.info.fbtraceId ?? null });
      }
    }
    // A token Meta wouldn't describe but whose account reads worked: it can manage the account.
    if (errors.some((e) => e.step === 'debug_token') && conn.phoneFound) {
      const i = problems.indexOf('Meta wouldn’t describe the token; checking the account directly');
      if (i >= 0) problems.splice(i, 1);
    }
  }

  conn.ok = Boolean(conn.wabaId && conn.phoneFound && conn.canManage) && !problems.some((p) => /not valid|can’t manage|owns the phone/.test(p));
  await updateOps({
    connection: conn,
    ...(conn.wabaId ? { wabaId: conn.wabaId } : {}),
    ...(conn.ok ? { everWorked: true } : {}),
  });
  await writeLog({
    kind: 'connection.checked',
    level: conn.ok ? 'info' : 'error',
    actor: by,
    summary: conn.ok
      ? `Meta connection OK: account ${conn.wabaId}, number ${conn.displayPhoneNumber ?? conn.phoneNumberId}${conn.quality ? ` (quality ${conn.quality})` : ''}`
      : `Meta connection not working: ${problems[0] ?? 'unknown problem'}`,
    detail: {
      ok: conn.ok,
      wabaId: conn.wabaId,
      wabaSource: conn.wabaSource,
      canManage: conn.canManage,
      scopes: conn.scopes,
      phoneFound: conn.phoneFound,
      quality: conn.quality,
      problems,
      errors,
      appId: conn.appId,
      appName: conn.appName,
      notices: conn.notices,
      messagesOverride: conn.messagesOverride,
      otherApps: conn.otherApps,
      tokenDescribed: conn.tokenDescribed,
      tokenExpiresAt: conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).toISOString() : null,
      client: client.kind,
    },
  });
  return conn;
}

const NOTICE_ERR: Record<string, string> = {
  setup: 'The WhatsApp access token doesn’t work (expired or revoked)',
  permission: 'The token may not change this account’s subscriptions (it needs whatsapp_business_management and access to the account)',
  rate_limited: 'Meta asks us to slow down; try again in a few minutes',
  unavailable: 'Meta could not be reached; try again',
  unknown: 'No answer from Meta; press Check connection to see whether it arrived',
};

export interface NoticesResult {
  /** Meta sends the account's notices to this app now. */
  on: boolean;
  /** This call subscribed it (false: it already was, or it failed). */
  changed: boolean;
  error: { kind: string; message: string } | null;
}

/**
 * "Turn on notices": subscribes the token's app to the account's webhooks (`POST subscribed_apps`,
 * no body), so Meta's template notices — for the fields ticked in the app's WhatsApp → Configuration
 * — and, with W3, delivery receipts reach the server. It asks Meta first which app the token belongs
 * to and whether it is subscribed: already subscribed → nothing is sent (so an override someone set,
 * which a POST without a body would remove, is never touched). One log row either way.
 */
export async function subscribeNotices(by: WaActor, wabaId: string): Promise<NoticesResult> {
  const client = metaClient();
  const fail = async (kind: string, message: string, e: MetaError | null): Promise<NoticesResult> => {
    await writeLog({
      kind: 'connection.notices',
      level: 'error',
      actor: by,
      summary: `Notices from Meta not turned on: ${message}`,
      detail: { wabaId, kind, message: e?.userMsg ?? null, code: e?.info.code ?? null, subcode: e?.info.subcode ?? null, fbtraceId: e?.info.fbtraceId ?? null },
    });
    return { on: false, changed: false, error: { kind, message } };
  };
  if (!client.ready()) return fail('setup', 'WhatsApp is not configured on this server', null);
  try {
    // The app the POST would subscribe is the current token's: asked now, never taken from an old check.
    const appId = (await client.debugToken()).appId;
    if (!appId) return fail('unknown_app', 'Meta didn’t say which app the token belongs to', null);
    const before = await client.subscribedApps(wabaId);
    if (before.some((a) => a.id === appId)) return { on: true, changed: false, error: null };
    const res = await client.subscribeApp(wabaId);
    if (!res.ok) return fail('not_confirmed', 'Meta didn’t confirm the subscription; press Check connection to see the state', null);
    // Meta said yes; the read that follows only confirms it (a failed read doesn't undo a yes).
    let confirmed: boolean | null = null;
    try {
      confirmed = (await client.subscribedApps(wabaId)).some((a) => a.id === appId);
    } catch {
      confirmed = null;
    }
    if (confirmed === false) return fail('not_confirmed', 'Meta answered yes, but the app isn’t listed on the account; press Check connection to see the state', null);
    await writeLog({
      kind: 'connection.notices',
      level: 'info',
      actor: by,
      summary: `Notices from Meta turned on: the app is subscribed to account ${wabaId}${confirmed === null ? ' (Meta said yes; the read that confirms it failed)' : ''}`,
      from: 'off',
      to: 'on',
      detail: { wabaId, appId, confirmed },
    });
    return { on: true, changed: true, error: null };
  } catch (err) {
    const e = err instanceof MetaError ? err : null;
    const kind = e?.kind ?? 'unknown';
    return fail(kind, NOTICE_ERR[kind] ?? 'Meta refused it', e);
  }
}
