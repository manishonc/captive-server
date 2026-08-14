import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { registerIpc } from './ipc';
import { effectiveConfig } from './config-store';
import { log } from './lib/log';
import { isAllowedExternal } from './lib/external-url';

let win: BrowserWindow | null = null;

function createWindow(): void {
  const config = effectiveConfig();
  win = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: config.appName,
    backgroundColor: config.brand.background,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Same allowlist as the openExternal IPC handler — a dashboard deep link opened via
    // target=_blank would otherwise be silently swallowed here.
    if (isAllowedExternal(url, [config.homeUrl, config.dashboardUrl])) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  log(`${effectiveConfig().appName} v${app.getVersion()} starting`);
  registerIpc(() => win);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
