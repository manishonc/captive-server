/**
 * The Meta connection (PR W1) — "Check connection" on the WhatsApp tab. With no new env var:
 *
 *  1. `debug_token` on the server's existing token: is it valid, may it manage templates
 *     (`whatsapp_business_management`), and which WhatsApp Business Accounts it covers.
 *  2. The account is the one whose phone numbers include `WHATSAPP_PHONE_NUMBER_ID` (the number the
 *     server sends from). An admin can type the account id when the token doesn't name it.
 *  3. Saved on `AdaptiveConfig/whatsapp` with the number's quality rating; logged either way.
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
      tokenWabas = t.wabaIds;
      if (!t.valid) problems.push('The WhatsApp access token is not valid (expired or revoked): create a new System User token and update WHATSAPP_ACCESS_TOKEN');
      else if (!conn.canManage) problems.push('The token can send messages but can’t manage templates: give its System User the whatsapp_business_management permission');
    } catch (err) {
      const e = err instanceof MetaError ? err : null;
      errors.push({ step: 'debug_token', kind: e?.kind ?? 'unknown', message: e?.userMsg ?? 'failed', code: e?.info.code ?? null, fbtraceId: e?.info.fbtraceId ?? null });
      if (e?.kind === 'setup') problems.push('The WhatsApp access token is not valid (expired or revoked)');
      else problems.push('Meta wouldn’t describe the token; checking the account directly');
      // The token may still manage templates: we learn it from the account reads below.
      conn.canManage = true;
    }

    const candidates = [...new Set([opts.wabaId ?? null, ops.wabaId, ...tokenWabas].filter((x): x is string => Boolean(x)))].slice(0, 5);
    if (!candidates.length) problems.push('No WhatsApp Business Account found for this token: type its id (WhatsApp Manager → Account tools → Phone numbers, "WhatsApp Business Account ID")');
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
      client: client.kind,
    },
  });
  return conn;
}
