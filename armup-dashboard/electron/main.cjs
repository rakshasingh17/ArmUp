/*
 * main.cjs -- Electron main process
 * ---------------------------------
 * Opens the window, opens the SQLite database in the app's own data folder,
 * and answers the React app's "API calls" over IPC (no HTTP server, no port).
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const db = require('./db.cjs');
const { handleRequest } = require('./routes.cjs');

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'ArmUp',
    backgroundColor: '#f5f1e8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  if (process.env.ARMUP_DEV_URL) {
    win.loadURL(process.env.ARMUP_DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  // Database lives in the per-user data folder, so it survives app updates.
  const dbPath = path.join(app.getPath('userData'), 'armup.db');
  db.openDb(dbPath, {
    // Dev only: carry over the old Python database on the very first run.
    legacyDbPath: isDev ? path.join(__dirname, '..', '..', 'backend', 'armup.db') : null,
  });
  console.log('[armup] database:', dbPath);

  ipcMain.handle('api:request', (_event, method, apiPath, body) =>
    handleRequest(String(method).toUpperCase(), String(apiPath), body)
  );

  // Camera only. Everything else the page asks for is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
