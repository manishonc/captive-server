// Optional pre-flight: can this machine reach the controller's inform port?
// Advisory only — the AP, not this laptop, ultimately connects.

import * as net from 'net';
import { normalizeInformUrl } from './adopt-command';
import { log } from './log';

const PREFLIGHT_TIMEOUT_MS = 5000;

export function preflight(informUrl: string): Promise<PreflightResult> {
  let host: string;
  let port: number;
  try {
    const url = new URL(normalizeInformUrl(informUrl));
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch (err) {
    return Promise.resolve({
      reachable: false,
      host: '',
      port: 0,
      error: (err as Error).message,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port, timeout: PREFLIGHT_TIMEOUT_MS });
    const done = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      log(`Controller pre-flight ${host}:${port} → ${reachable ? 'reachable' : `unreachable (${error})`}`);
      resolve({ reachable, host, port, error });
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false, 'connection timed out'));
    socket.on('error', (err) => done(false, err.message));
  });
}
