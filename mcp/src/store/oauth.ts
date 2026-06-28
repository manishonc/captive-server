import { db } from '../firebase';
import { randomToken, sha256Hex } from '../crypto';

/**
 * OAuth 2.1 Authorization Server state — auth requests, one-time codes, and opaque
 * access/refresh tokens. All secrets are stored ONLY as SHA-256 hashes (the doc id);
 * the raw value is returned to the caller exactly once and never persisted.
 *
 * Modeled on the CMS's VenueLinkGrant pattern (cms/lib/venue-link.js): epoch-ms
 * timestamps, lazy delete-on-read, single-use via transactions. Collections:
 *   McpOAuth_AuthRequests, McpOAuth_Codes, McpOAuth_AccessTokens, McpOAuth_RefreshTokens
 */

const COL = {
  authRequests: 'McpOAuth_AuthRequests',
  codes: 'McpOAuth_Codes',
  accessTokens: 'McpOAuth_AccessTokens',
  refreshTokens: 'McpOAuth_RefreshTokens',
} as const;

const now = () => Date.now();

// ── Authorization requests: pending → (approved by the CMS consent screen) → consumed ──

export interface AuthRequest {
  requestId: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied';
  tenantUserId?: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

export interface CreateAuthRequestInput {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
  ttlSeconds: number;
}

export async function createAuthRequest(input: CreateAuthRequestInput): Promise<AuthRequest> {
  const requestId = randomToken(16);
  const t = now();
  const doc: AuthRequest = {
    requestId,
    clientId: input.clientId,
    clientName: input.clientName,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    state: input.state,
    scope: input.scope,
    resource: input.resource,
    status: 'pending',
    createdAt: t,
    expiresAt: t + input.ttlSeconds * 1000,
  };
  await db.collection(COL.authRequests).doc(requestId).set(doc);
  return doc;
}

export async function getAuthRequest(requestId: string): Promise<AuthRequest | null> {
  if (!requestId) return null;
  const snap = await db.collection(COL.authRequests).doc(requestId).get();
  return snap.exists ? (snap.data() as AuthRequest) : null;
}

/**
 * Atomically transition an approved auth-request to consumed, returning its data.
 * Guarantees a one-time code mint even under a double-click / replay of /resume.
 * Returns null if the request is missing, not approved, or expired.
 */
export async function consumeApprovedAuthRequest(requestId: string): Promise<AuthRequest | null> {
  const ref = db.collection(COL.authRequests).doc(requestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as AuthRequest;
    if (data.status !== 'approved') return null;
    if (now() > data.expiresAt) return null;
    if (!data.tenantUserId) return null;
    tx.update(ref, { status: 'consumed', consumedAt: now() });
    return data;
  });
}

// ── Authorization codes: one-time, consumed at /token ──

export interface AuthCode {
  codeHash: string;
  clientId: string;
  tenantUserId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export async function createAuthCode(input: {
  clientId: string;
  tenantUserId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  ttlSeconds: number;
}): Promise<string> {
  const rawCode = randomToken(24);
  const codeHash = sha256Hex(rawCode);
  const t = now();
  const doc: AuthCode = {
    codeHash,
    clientId: input.clientId,
    tenantUserId: input.tenantUserId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    createdAt: t,
    expiresAt: t + input.ttlSeconds * 1000,
    consumed: false,
  };
  await db.collection(COL.codes).doc(codeHash).set(doc);
  return rawCode;
}

/** Atomically consume a one-time code. Returns its data, or null if used/expired/unknown. */
export async function consumeAuthCode(rawCode: string): Promise<AuthCode | null> {
  if (!rawCode) return null;
  const ref = db.collection(COL.codes).doc(sha256Hex(rawCode));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as AuthCode;
    if (data.consumed || now() > data.expiresAt) return null;
    tx.update(ref, { consumed: true });
    return data;
  });
}

// ── Access tokens (opaque; SHA-256 hash is the doc id) ──

export interface AccessToken {
  tokenHash: string;
  tenantUserId: string;
  clientId: string;
  scope: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  refreshTokenHash: string;
  revoked: boolean;
  lastUsedAt?: number;
}

export async function createAccessToken(input: {
  tenantUserId: string;
  clientId: string;
  scope: string;
  resource: string;
  ttlSeconds: number;
}): Promise<{ raw: string; doc: AccessToken }> {
  const raw = randomToken(32);
  const tokenHash = sha256Hex(raw);
  const t = now();
  const doc: AccessToken = {
    tokenHash,
    tenantUserId: input.tenantUserId,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    createdAt: t,
    expiresAt: t + input.ttlSeconds * 1000,
    refreshTokenHash: '',
    revoked: false,
  };
  await db.collection(COL.accessTokens).doc(tokenHash).set(doc);
  return { raw, doc };
}

export async function getAccessTokenByHash(tokenHash: string): Promise<AccessToken | null> {
  if (!tokenHash) return null;
  const snap = await db.collection(COL.accessTokens).doc(tokenHash).get();
  return snap.exists ? (snap.data() as AccessToken) : null;
}

export async function patchAccessToken(tokenHash: string, patch: Partial<AccessToken>): Promise<void> {
  await db.collection(COL.accessTokens).doc(tokenHash).set(patch, { merge: true }).catch(() => {});
}

export async function touchAccessToken(tokenHash: string): Promise<void> {
  await db.collection(COL.accessTokens).doc(tokenHash).set({ lastUsedAt: now() }, { merge: true }).catch(() => {});
}

export async function revokeAccessToken(tokenHash: string): Promise<void> {
  await db.collection(COL.accessTokens).doc(tokenHash).set({ revoked: true }, { merge: true }).catch(() => {});
}

// ── Refresh tokens (rotated; reuse detected and the forward chain revoked) ──

export interface RefreshToken {
  tokenHash: string;
  tenantUserId: string;
  clientId: string;
  scope: string;
  resource: string;
  accessTokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  replacedBy?: string;
  revoked: boolean;
  revokedFromReuse?: boolean;
}

export async function createRefreshToken(input: {
  tenantUserId: string;
  clientId: string;
  scope: string;
  resource: string;
  ttlDays: number;
}): Promise<{ raw: string; doc: RefreshToken }> {
  const raw = randomToken(32);
  const tokenHash = sha256Hex(raw);
  const t = now();
  const doc: RefreshToken = {
    tokenHash,
    tenantUserId: input.tenantUserId,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    accessTokenHash: '',
    createdAt: t,
    expiresAt: t + input.ttlDays * 86_400_000,
    consumed: false,
    revoked: false,
  };
  await db.collection(COL.refreshTokens).doc(tokenHash).set(doc);
  return { raw, doc };
}

export async function getRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
  if (!tokenHash) return null;
  const snap = await db.collection(COL.refreshTokens).doc(tokenHash).get();
  return snap.exists ? (snap.data() as RefreshToken) : null;
}

export async function patchRefreshToken(tokenHash: string, patch: Partial<RefreshToken>): Promise<void> {
  await db.collection(COL.refreshTokens).doc(tokenHash).set(patch, { merge: true }).catch(() => {});
}

/** Mark a refresh token as rotated and link its successor (for forward-chain revocation). */
export function markRefreshConsumed(tokenHash: string, replacedBy: string): Promise<void> {
  return patchRefreshToken(tokenHash, { consumed: true, replacedBy });
}

/**
 * Revoke an entire refresh-token chain forward from a replayed (already-consumed)
 * token by walking `replacedBy`, also revoking each link's paired access token.
 * Avoids any composite-index requirement. Best-effort; never throws.
 */
export async function revokeChainFrom(startHash: string): Promise<void> {
  let current = startHash;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const snap = await db.collection(COL.refreshTokens).doc(current).get();
    if (!snap.exists) break;
    const data = snap.data() as RefreshToken;
    await db.collection(COL.refreshTokens).doc(current).set({ revoked: true, revokedFromReuse: true }, { merge: true }).catch(() => {});
    if (data.accessTokenHash) await revokeAccessToken(data.accessTokenHash);
    current = data.replacedBy || '';
  }
}
