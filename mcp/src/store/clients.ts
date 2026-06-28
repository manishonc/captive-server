import { db } from '../firebase';
import { randomClientId } from '../crypto';

/**
 * McpOAuth_Clients — OAuth 2.1 clients created via Dynamic Client Registration
 * (RFC 7591). These are public clients (Claude Code, Cursor): PKCE-only, no secret.
 * No tenant binding — a client is registered before any user is involved.
 */

const COLLECTION = 'McpOAuth_Clients';

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
  createdAt: number;
  lastSeenAt: number;
}

export interface CreateClientInput {
  clientName?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
}

export async function createClient(input: CreateClientInput): Promise<OAuthClient> {
  const now = Date.now();
  const client: OAuthClient = {
    clientId: randomClientId(),
    clientName: input.clientName ? String(input.clientName).slice(0, 200) : null,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes,
    responseTypes: input.responseTypes,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    createdAt: now,
    lastSeenAt: now,
  };
  await db.collection(COLLECTION).doc(client.clientId).set(client);
  return client;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const snap = await db.collection(COLLECTION).doc(clientId).get();
  if (!snap.exists) return null;
  return snap.data() as OAuthClient;
}

/** Best-effort lastSeen ping (used when a client is seen in /authorize or /token). */
export async function touchClient(clientId: string): Promise<void> {
  if (!clientId) return;
  await db.collection(COLLECTION).doc(clientId).set({ lastSeenAt: Date.now() }, { merge: true }).catch(() => {});
}
