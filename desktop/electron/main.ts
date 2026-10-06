/**
 * Vesper desktop shell (Electron).
 *
 * Two modes, chosen at launch:
 *  - VESPER_WEB_URL set  → load the deployed web app (recommended for testers;
 *    the API is same-origin there exactly like the browser build).
 *  - unset               → load the packaged client/dist over file:// for
 *    offline-first launches; pair with a build whose VITE_VESPER_API points at
 *    the deployment, or run `npm start` at the repo root for a local server.
 *
 * Security posture mirrors the web CSP: no nodeIntegration in the renderer,
 * contextIsolation on, navigation locked to the app origin, every external
 * link handed to the OS browser.
 */
import { app, BrowserWindow, shell, session } from 'electron';
import { join } from 'node:path';

const WEB_URL = process.env.VESPER_WEB_URL?.trim() || null;

if (!app.requestSingleInstanceLock()) app.quit();

async function main(): Promise<void> {
  await app.whenReady();

  // Belt-and-braces CSP for the file:// mode; the deployed mode already
  // carries the server's header.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!WEB_URL) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: blob:; font-src 'self' data:; base-uri 'self'; form-action 'self'",
          ],
        },
      });
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // No in-app browsing: anything outside the app goes to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = WEB_URL ?? 'file://';
    if (!url.startsWith(allowed)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (WEB_URL) await win.loadURL(WEB_URL);
  else await win.loadFile(join(__dirname, '..', '..', 'client', 'dist', 'index.html'));
}

void main();
