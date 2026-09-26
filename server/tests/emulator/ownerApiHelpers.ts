/**
 * Shared helpers for the PR D emulator tests (owner, public and admin routes). Only ever run
 * through tests/emulator/run.sh (helpers.ts refuses anything else).
 *
 *  - `mountApi()`: the REAL `api/router.ts` (with every PR D sub-router) on an ephemeral port,
 *    behind the same `x-internal-secret` guard as server.ts — importing it also proves the
 *    server boots with the new routers (no circular import).
 *  - `seedWorkerHeartbeat()`: an alive worker on this code (ENGINE_RUNTIME_VERSION) with this
 *    API's identity key, so going live through the admin card is allowed.
 *  - `captureLogs()`: every console line while a block runs (LEAKCHECK).
 */

import express from 'express';
import type { AddressInfo } from 'net';
import { COL, db } from './helpers';
import adaptiveRouter from '../../src/adaptive/api/router';
import { ENGINE_STATUS_DOC_ID } from '../../src/adaptive/store/collections';
import { ENGINE_RUNTIME_VERSION } from '../../src/adaptive/core/runtime/version';
import { keyFingerprint } from '../../src/adaptive/identity/key';

// run.sh sets it; a direct `npx tsx` run through the scratch script does too. Never empty.
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'emulator-test-secret';

export const OWNER_ACTOR = { uid: 'owner_uid', kind: 'tenant_user', role: 'ADMIN' } as const;
export const ADMIN_ACTOR = { uid: 'heidifi_admin', kind: 'super_admin' } as const;
export const MCP_ACTOR = { uid: 'mcp_server', kind: 'mcp' } as const;

export interface ApiResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

export interface Api {
  base: string;
  call(method: string, path: string, body?: unknown, opts?: { secret?: string | null }): Promise<ApiResponse>;
  get(path: string, opts?: { secret?: string | null }): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** The real Adaptive router, mounted like server.ts does (`/internal/adaptive`, JSON bodies). */
export async function mountApi(): Promise<Api> {
  const app = express();
  app.use(express.json());
  app.use('/internal/adaptive', adaptiveRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/adaptive`;
  const call = async (method: string, path: string, body?: unknown, opts: { secret?: string | null } = {}): Promise<ApiResponse> => {
    const headers: Record<string, string> = {};
    const secret = opts.secret === undefined ? String(process.env.INTERNAL_API_SECRET) : opts.secret;
    if (secret !== null) headers['x-internal-secret'] = secret;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return {
    base,
    call,
    get: (path, opts) => call('GET', path, undefined, opts),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** An alive worker entry on `AdaptiveConfig/engine_status` (this code's version, this API's key unless told otherwise). */
export async function seedWorkerHeartbeat(opts: { id?: string; version?: string; keyFingerprint?: string | null; ageMs?: number } = {}): Promise<void> {
  const id = opts.id ?? 'test_worker';
  await db
    .collection(COL.config)
    .doc(ENGINE_STATUS_DOC_ID)
    .set(
      {
        workers: {
          [id]: {
            lastBeatAt: new Date(Date.now() - (opts.ageMs ?? 0)),
            startedAt: new Date(Date.now() - 60_000),
            version: opts.version ?? ENGINE_RUNTIME_VERSION,
            keyFingerprint: opts.keyFingerprint === undefined ? keyFingerprint() : opts.keyFingerprint,
            state: 'running',
          },
        },
      },
      { merge: true },
    );
}

/** Removes every worker entry (and, with `identity`, the pinned key). */
export async function clearEngineStatus(opts: { identity?: boolean } = {}): Promise<void> {
  const ref = db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID);
  const snap = await ref.get();
  if (!snap.exists) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  await ref.update({ workers: FieldValue.delete(), ...(opts.identity ? { identity: FieldValue.delete() } : {}) });
}

/** Every console line written while `fn` runs (restored afterwards, also on a throw). */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  const capture = (...a: unknown[]) =>
    logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = capture;
  console.warn = capture;
  console.log = capture;
  console.info = capture;
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    Object.assign(console, orig);
  }
}

/** How many docs a collection holds (small test collections only). */
export async function countDocs(collection: string): Promise<number> {
  return (await db.collection(collection).get()).size;
}

/** The saved test recipients of an account, in the cms's shape (`CaptivePortal_TestRecipients/{tenant}`). */
export async function seedTestRecipients(tenant: string, recipients: Array<{ id: string; kind: 'email' | 'phone'; value: string }>): Promise<void> {
  await db
    .collection('CaptivePortal_TestRecipients')
    .doc(tenant)
    .set({ recipients: recipients.map((r, i) => ({ ...r, label: `R${i + 1}`, isDefault: i === 0 })), updatedAt: new Date() });
}
