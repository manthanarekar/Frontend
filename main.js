const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const { spawn, execSync } = require('child_process');
const http   = require('http');
const fs     = require('fs');

const API_PORT    = 12345;
let mainWindow    = null;
let serverProcess = null;

// ── Find the system node binary (NOT Electron's execPath) ─────────────────
function findNode() {
  // Try common locations first
  const candidates = ['node'];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\nodejs\\node.exe',
      `${process.env.APPDATA}\\npm\\node.exe`,
      `${process.env.ProgramFiles}\\nodejs\\node.exe`,
    );
  }
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" --version`, { stdio: 'ignore' });
      return bin;
    } catch { /* try next */ }
  }
  return 'node'; // last resort
}

// ── Launch the Node WhatsApp server ───────────────────────────────────────
function startServer() {
  const script = path.join(__dirname, '..', 'server', 'server.js');
  if (!fs.existsSync(script)) {
    console.error('[main] ../server/server.js not found');
    return;
  }

  const nodeBin = findNode();
  console.log(`[main] Spawning server with: ${nodeBin}`);

  serverProcess = spawn(nodeBin, [script], {
    cwd:   path.join(__dirname, '..', 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env },
  });

  serverProcess.stdout.on('data', d => {
    const msg = d.toString().trim();
    process.stdout.write(`[server] ${msg}\n`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('server-log', msg);
  });
  serverProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    process.stderr.write(`[server] ${msg}\n`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('server-log', msg);
  });
  serverProcess.on('exit', code => {
    console.log(`[server] exited (${code})`);
    // code 0 = clean exit (e.g. port already in use — another instance is running)
    if (code !== 0 && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('api-status', 'crashed');
  });
}

// ── Poll /health until the server responds ────────────────────────────────
function waitForAPI(retries = 40) {
  const req = http.get(`https://server-2aeo.onrender.com/health`, res => {
    if (res.statusCode === 200) {
      console.log('[main] Server is ready');
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('api-status', 'ready');
    } else {
      retry(retries);
    }
    res.resume();
  });
  req.on('error',    () => retry(retries));
  req.setTimeout(1200, () => { req.destroy(); retry(retries); });

  function retry(n) {
    if (n <= 0) {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('api-status', 'timeout');
      return;
    }
    setTimeout(() => waitForAPI(n - 1), 1000);
  }
}

// ── Browser window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    800,
    minWidth:  960,
    minHeight: 620,
    show:      false,
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.on('open-external', (_e, url) => shell.openExternal(url));

// ── Check if server is already running on the port ───────────────────────
function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`https://server-2aeo.onrender.com/health`, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();

  const alreadyUp = await isServerRunning();
  if (alreadyUp) {
    console.log('[main] Server already running — skipping spawn');
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('api-status', 'ready');
  } else {
    startServer();
    setTimeout(waitForAPI, 1500);
  }
});

function killServer() {
  if (!serverProcess) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', serverProcess.pid, '/f', '/t']);
    } else {
      serverProcess.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  serverProcess = null;
}

app.on('before-quit',        killServer);
app.on('window-all-closed', () => { killServer(); app.quit(); });
