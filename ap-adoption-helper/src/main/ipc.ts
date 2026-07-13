import { BrowserWindow, ipcMain, shell } from 'electron';
import { scan } from './lib/discovery';
import { adopt } from './lib/adopt';
import { preflight } from './lib/preflight';
import { effectiveConfig, writeSettings } from './config-store';
import { getLogLines, log, onLog } from './lib/log';

const SCAN_WINDOW_MS = 4000;

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
    writeSettings({
      controllerUrl: typeof patch?.controllerUrl === 'string' ? patch.controllerUrl : undefined,
      sshPassword: typeof patch?.sshPassword === 'string' ? patch.sshPassword : undefined,
    });
    log('Settings updated');
    return effectiveConfig();
  });

  ipcMain.handle('log:getAll', () => getLogLines());

  ipcMain.handle('openExternal', (_event, url: string) => {
    const home = effectiveConfig().homeUrl;
    if (typeof url === 'string' && url === home) return shell.openExternal(url);
    log(`Blocked openExternal for non-allowlisted URL: ${String(url)}`);
  });
}
