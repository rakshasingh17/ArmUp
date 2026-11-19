/*
 * main.cjs -- Electron main process
 * ---------------------------------
 * Opens the window and passes the React app's "API calls" (over IPC) on to
 * the ArmUp server over HTTPS. Accounts, appointments and notes live in the
 * server's database; the camera and pose tracking stay on this computer.
 */
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const { createServerClient } = require('./server-client.cjs');
const { registerPdfExport } = require('./pdf-export.cjs');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const SPLASH_MIN_MS = 1600;   // keep the splash up long enough to be seen
const SPLASH_MAX_MS = 15000;  // never let it hang around if something goes wrong

function createSplash() {
  const splash = new BrowserWindow({
    width: 520,
    height: 340,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#f5f1e8',
    icon: ICON_PATH,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

function createWindow(splash, splashShownAt) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'ArmUp',
    icon: ICON_PATH,
    show: false, // revealed once loaded, after the splash has had its moment
    backgroundColor: '#f5f1e8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (splash && !splash.isDestroyed()) splash.close();
    if (win.isDestroyed()) return;
    win.setOpacity(0);
    win.show();
    // quick fade-in (setOpacity is a no-op on platforms that don't support it)
    let o = 0;
    const timer = setInterval(() => {
      o = Math.min(1, o + 0.1);
      if (win.isDestroyed()) return clearInterval(timer);
      win.setOpacity(o);
      if (o >= 1) clearInterval(timer);
    }, 20);
  };

  win.once('ready-to-show', () => {
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
    setTimeout(reveal, wait);
  });
  // Safety nets: if loading fails or stalls, still show the window (and its error).
  win.webContents.once('did-fail-load', reveal);
  setTimeout(reveal, SPLASH_MAX_MS);

  if (process.env.ARMUP_DEV_URL) {
    win.loadURL(process.env.ARMUP_DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  // Show the splash first and let it paint before the (synchronous) startup work.
  const splash = createSplash();
  await splash.loadFile(path.join(__dirname, 'splash.html'));
  const splashShownAt = Date.now();

  // Where the server is: the address saved in the app, or the shipped default.
  const server = createServerClient({
    userDataDir: app.getPath('userData'),
    defaultConfigPath: path.join(__dirname, 'server-config.json'),
  });
  console.log('[armup] server:', server.getUrl() || '(no address set)');

  ipcMain.handle('api:request', (_event, method, apiPath, body, token) =>
    server.forward(String(method), String(apiPath), body, token)
  );
  // The connection box in the app: read, change, and check the server address.
  ipcMain.handle('server:get', () => server.getUrl());
  ipcMain.handle('server:set', (_event, address) => server.setUrl(String(address ?? '')));
  ipcMain.handle('server:ping', () => server.ping());
  // Save a patient's progress summary as a PDF.
  registerPdfExport({ ipcMain, dialog, BrowserWindow });

  // Camera only. Everything else the page asks for is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  );

  createWindow(splash, splashShownAt);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null, 0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
