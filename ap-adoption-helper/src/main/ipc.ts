import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { scan } from './lib/discovery';
import { adopt } from './lib/adopt';
import { preflight } from './lib/preflight';
import { effectiveConfig, writeSettings } from './config-store';
import { getLogLines, log, onLog } from './lib/log';
import { apiPost } from './lib/api';
import { checkAccountCode, maskAccountCode } from './lib/account-code';
import { isAllowedExternal } from './lib/external-url';

const SCAN_WINDOW_MS = 4000;

/** The claim does controller work end to end, so it gets a longer leash than a read. */
const CLAIM_TIMEOUT_MS = 45_000;
/** Polled every 2-3s — a short timeout keeps slow polls from stacking up. */
const STATUS_TIMEOUT_MS = 8_000;

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  onLog((line) => send('log:line', line));

  ipcMain.handle('scan', () => scan(SCAN_WINDOW_MS, (device) => send('scan:device', device)));

  ipcMain.handle('adopt', (_event, req: AdoptRequest) => {
    const config = effectiveConfig();
    return adopt(req.ip, config.effectiveInformUrl, config.settings.sshPassword);
  });

  ipcMain.handle('preflight', () => preflight(effectiveConfig().effectiveInformUrl));

  ipcMain.handle('config:get', () => effectiveConfig());

  ipcMain.handle('config:set', (_event, patch: UserSettings) => {
    // Hand-listed on purpose: anything not named here is dropped. The setup code is
    // deliberately absent — settings.json is plaintext in the user data folder.
    writeSettings({
      controllerUrl: typeof patch?.controllerUrl === 'string' ? patch.controllerUrl : undefined,
      sshPassword: typeof patch?.sshPassword === 'string' ? patch.sshPassword : undefined,
      apiBaseUrl: typeof patch?.apiBaseUrl === 'string' ? patch.apiBaseUrl : undefined,
    });
    log('Settings updated');
    return effectiveConfig();
  });

  ipcMain.handle('log:getAll', () => getLogLines());

  ipcMain.handle('openExternal', (_event, url: string) => {
    const config = effectiveConfig();
    if (isAllowedExternal(url, [config.homeUrl, config.dashboardUrl])) {
      return shell.openExternal(url);
    }
    log(`Blocked openExternal for non-allowlisted URL: ${String(url)}`);
  });

  // ── Self-serve setup ────────────────────────────────────────────────────────

  const call = <T>(path: string, body: Record<string, unknown>, timeoutMs?: number) =>
    apiPost<T>(effectiveConfig().effectiveApiBaseUrl, path, body, {
      timeoutMs,
      helperVersion: app.getVersion(),
    });

  /**
   * Validate the code here as well as in the renderer. The renderer's copy exists to give
   * instant feedback; this one is what guarantees a malformed code never reaches the network,
   * where it would burn a rate-limit budget for nothing.
   */
  const codeOf = (raw: unknown): string | null => {
    const check = checkAccountCode(raw);
    return check.ok ? check.value : null;
  };

  ipcMain.handle('adoption:session', (_event, req: { code: string }) => {
    const code = codeOf(req?.code);
    if (!code) return { ok: false, code: 'BAD_CODE' } as AdoptionErr;
    log(`Looking up setup code ${maskAccountCode(code)}`);
    return call<AdoptionSession>('adoption/session', { code });
  });

  ipcMain.handle('adoption:venue', (_event, req: { code: string; venueId: string }) => {
    const code = codeOf(req?.code);
    if (!code) return { ok: false, code: 'BAD_CODE' } as AdoptionErr;
    return call<AdoptionVenueDetail>('adoption/venue', { code, venueId: req.venueId });
  });

  ipcMain.handle('adoption:precheck', (_event, req: { code: string; macs: string[] }) => {
    const code = codeOf(req?.code);
    if (!code) return { ok: false, code: 'BAD_CODE' } as AdoptionErr;
    return call<AdoptionPrecheck>('adoption/precheck', { code, macs: req.macs });
  });

  ipcMain.handle('adoption:claim', (_event, req: AdoptionClaimRequest) => {
    const code = codeOf(req?.code);
    if (!code) return { ok: false, code: 'BAD_CODE' } as AdoptionErr;
    log(`Claiming ${req.mac} for venue ${req.venueId}`);
    return call<AdoptionClaim>('adoption/claim', { ...req, code }, CLAIM_TIMEOUT_MS);
  });

  ipcMain.handle('adoption:status', (_event, req: { code: string; mac: string }) => {
    const code = codeOf(req?.code);
    if (!code) return { ok: false, code: 'BAD_CODE' } as AdoptionErr;
    return call<AdoptionStatus>('adoption/status', { code, mac: req.mac }, STATUS_TIMEOUT_MS);
  });
}
