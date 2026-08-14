// Sends the adoption request to an AP over SSH: ubnt/ubnt with legacy
// algorithms, `mca-cli-op set-inform <url>` with a bare `set-inform` fallback.

import * as net from 'net';
import { Client } from 'ssh2';
import {
  buildSetInformCommands,
  interpretExecOutput,
  normalizeInformUrl,
  InvalidUrlError,
} from './adopt-command';
import { log } from './log';

const SSH_USER = 'ubnt';
const DEFAULT_PASSWORD = 'ubnt';
// 20s, not 10: venue APs are routinely reached across a laptop's shared-internet bridge or
// a congested guest LAN, where the SSH banner exchange alone can eat several seconds.
const READY_TIMEOUT_MS = 20000;
const EXEC_TIMEOUT_MS = 15000;

interface ExecResult {
  stdout: string;
  stderr: string;
  raw: string;
}

function execCommand(conn: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    log(`$ ${command}`);
    const timer = setTimeout(() => reject(new Error('exec-timeout')), EXEC_TIMEOUT_MS);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      stream.on('close', () => {
        clearTimeout(timer);
        const raw = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        log(raw || '(no output)');
        resolve({ stdout, stderr, raw });
      });
    });
  });
}

export async function adopt(host: string, informUrl: string, password?: string): Promise<AdoptResult> {
  let commands: [string, string];
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeInformUrl(informUrl);
    commands = buildSetInformCommands(informUrl);
  } catch (err) {
    const message = err instanceof InvalidUrlError ? err.message : String(err);
    return { ok: false, code: 'INVALID_URL', raw: message };
  }
  if (net.isIPv4(host) === false) {
    return { ok: false, code: 'UNREACHABLE', raw: `Not a valid device address: ${host}` };
  }

  const sshPassword = password || DEFAULT_PASSWORD;
  log(`Connecting to ${SSH_USER}@${host} ...`);

  return new Promise<AdoptResult>((resolve) => {
    const conn = new Client();
    let settled = false;
    const finish = (result: AdoptResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        // already closed
      }
      if (result.ok) log(`Adoption request sent to ${result.informUrl}`);
      else log(`Adoption failed (${result.code}): ${result.raw}`);
      resolve(result);
    };

    conn.on('ready', async () => {
      log(`SSH session established with ${host}`);
      try {
        const first = await execCommand(conn, commands[0]);
        let verdict = interpretExecOutput(first.stdout, first.stderr);
        let raw = first.raw;
        if (verdict === 'not-found') {
          log(`'mca-cli-op' not available on this firmware, trying bare set-inform`);
          const second = await execCommand(conn, commands[1]);
          verdict = interpretExecOutput(second.stdout, second.stderr);
          raw = [raw, second.raw].filter(Boolean).join('\n');
          if (verdict === 'not-found') {
            return finish({ ok: false, code: 'COMMAND_NOT_FOUND', raw });
          }
        }
        if (verdict === 'success') return finish({ ok: true, informUrl: normalizedUrl, raw });
        finish({ ok: false, code: 'UNEXPECTED_OUTPUT', raw });
      } catch (err) {
        const message = (err as Error).message;
        finish({
          ok: false,
          code: message === 'exec-timeout' ? 'TIMEOUT' : 'UNEXPECTED_OUTPUT',
          raw: message,
        });
      }
    });

    // Some AP firmware only offers keyboard-interactive auth.
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finishAuth) => {
      finishAuth(prompts.map(() => sshPassword));
    });

    conn.on('error', (err: Error & { level?: string }) => {
      if (err.level === 'client-authentication') {
        return finish({ ok: false, code: 'AUTH_FAILED', raw: err.message });
      }
      if (err.level === 'client-timeout' || /timed? ?out/i.test(err.message)) {
        return finish({ ok: false, code: 'TIMEOUT', raw: err.message });
      }
      finish({ ok: false, code: 'UNREACHABLE', raw: err.message });
    });

    conn.connect({
      host,
      port: 22,
      username: SSH_USER,
      password: sshPassword,
      tryKeyboard: true,
      readyTimeout: READY_TIMEOUT_MS,
      // UniFi APs require legacy ssh-rsa; older firmware also needs legacy
      // KEX/ciphers. `append` keeps modern algorithms preferred.
      algorithms: {
        serverHostKey: { append: ['ssh-rsa', 'ssh-dss'], prepend: [], remove: [] },
        kex: {
          append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
          prepend: [],
          remove: [],
        },
        cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'], prepend: [], remove: [] },
      },
    });
  });
}
