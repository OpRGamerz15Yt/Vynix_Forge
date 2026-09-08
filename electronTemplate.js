// Server-side generator for the real, runnable Electron launcher project.
// Mirrors the same template used by the free client-side source export, so
// what a Free user downloads and what Pro/Dev get compiled are the exact
// same real application -- the only difference is who does the compiling.

function slugify(name){
  return (name||'launcher').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'launcher';
}

function packageJson(project, slug){
  return JSON.stringify({
    name: slug,
    version: project.identity.version || '0.1.0',
    description: project.identity.description || '',
    author: project.identity.publisher || '',
    main: 'main.js',
    scripts: { start: 'electron .', dist: 'electron-builder' },
    dependencies: { 'minecraft-launcher-core': '^3.18.2', 'msmc': '^5.0.5' },
    devDependencies: { electron: '^30.0.9', 'electron-builder': '^24.13.3' },
    build: {
      appId: 'com.vynixforge.'+slug,
      productName: project.identity.launcherName || project.name,
      files: ['**/*', '!*.md'],
      directories: { output: 'dist' },
      win: { target: 'nsis' },
      linux: { target: 'AppImage' },
      mac: { target: 'dmg' }
    }
  }, null, 2);
}

const MAIN_JS = `const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { launchMinecraft, signIn } = require('./launch.js');
let win;
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'launcher.config.json'), 'utf8'));
function createWindow(){
  win = new BrowserWindow({ width: 900, height: 600, backgroundColor: CONFIG.branding.primaryColor || '#131110',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.loadFile('index.html');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
ipcMain.handle('get-config', () => CONFIG);
ipcMain.handle('sign-in', async () => { try { return { ok: true, profile: await signIn() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('launch', async (event, { server }) => {
  try { await launchMinecraft(CONFIG, server, (line) => win.webContents.send('launch-log', line)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
`;

const PRELOAD_JS = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vynix', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  signIn: () => ipcRenderer.invoke('sign-in'),
  launch: (server) => ipcRenderer.invoke('launch', { server }),
  onLaunchLog: (cb) => ipcRenderer.on('launch-log', (_e, line) => cb(line))
});
`;

const LAUNCH_JS = `const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const path = require('path');
const os = require('os');
let cachedAuth = null;
async function signIn(){
  const authManager = new Auth('select_account');
  const xboxManager = await authManager.launch('raw');
  const token = await xboxManager.getMinecraft();
  cachedAuth = token;
  return { name: token.profile.name, uuid: token.profile.id };
}
async function launchMinecraft(config, server, onLog){
  if (!cachedAuth) throw new Error('Not signed in -- call signIn() first.');
  if (config.minecraft.loader !== 'vanilla') onLog('Warning: loader is "' + config.minecraft.loader + '" -- only vanilla is fully wired in this template.');
  const launcher = new Client();
  const opts = {
    authorization: cachedAuth.mclc(),
    root: path.join(os.homedir(), '.' + (config.identity.launcherName || 'vynix-launcher').toLowerCase().replace(/\\s+/g,'-')),
    version: { number: config.minecraft.version, type: 'release' },
    memory: { min: config.minecraft.ram.min + 'M', max: config.minecraft.ram.max + 'M' }
  };
  if (server && server.address) opts.server = { host: server.address, port: server.port || 25565 };
  launcher.on('debug', (e) => onLog(String(e)));
  launcher.on('data', (e) => onLog(String(e)));
  launcher.on('close', (code) => onLog('Game process exited with code ' + code));
  await launcher.launch(opts);
}
module.exports = { signIn, launchMinecraft };
`;

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Launcher</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:var(--bg,#131110);color:var(--text,#ede8e1);height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
#logo{max-height:60px;}#playBtn{font-size:16px;padding:12px 32px;border-radius:8px;border:none;cursor:pointer;font-weight:600;}
#status{font-size:12px;opacity:.7;max-width:80%;text-align:center;white-space:pre-wrap;max-height:120px;overflow-y:auto;}
#signInBtn{background:none;border:1px solid currentColor;border-radius:6px;padding:6px 14px;color:inherit;cursor:pointer;}</style>
</head><body>
<img id="logo" src="assets/logo.png" onerror="this.style.display='none'">
<h1 id="title"></h1>
<button id="signInBtn">Sign in with Microsoft</button>
<button id="playBtn" disabled>Play</button>
<pre id="status"></pre>
<script src="renderer.js"></script>
</body></html>
`;

const RENDERER_JS = `let profile = null;
async function init(){
  const config = await window.vynix.getConfig();
  document.title = config.identity.launcherName || 'Launcher';
  document.getElementById('title').textContent = config.identity.launcherName || 'Launcher';
  document.body.style.setProperty('--bg', config.branding.primaryColor || '#131110');
  document.body.style.setProperty('--text', config.branding.textColor || '#ede8e1');
  document.getElementById('playBtn').style.background = config.branding.accentColor || '#5b7065';
  document.getElementById('playBtn').style.color = config.branding.textColor || '#ede8e1';
  window.vynix.onLaunchLog((line) => { const el = document.getElementById('status'); el.textContent += line + '\\n'; el.scrollTop = el.scrollHeight; });
  document.getElementById('signInBtn').onclick = async () => {
    document.getElementById('status').textContent = 'Opening Microsoft sign-in...';
    const res = await window.vynix.signIn();
    if (res.ok) { profile = res.profile; document.getElementById('status').textContent = 'Signed in as ' + profile.name; document.getElementById('playBtn').disabled = false; }
    else document.getElementById('status').textContent = 'Sign-in failed: ' + res.error;
  };
  document.getElementById('playBtn').onclick = async () => {
    document.getElementById('playBtn').disabled = true;
    document.getElementById('status').textContent = 'Launching...';
    const server = (config.servers || []).find(s => s.isDefault) || (config.servers || [])[0];
    const res = await window.vynix.launch(server);
    if (!res.ok) document.getElementById('status').textContent += '\\nLaunch failed: ' + res.error;
    document.getElementById('playBtn').disabled = false;
  };
}
init();
`;

function generateFiles(project, servers){
  const slug = slugify(project.identity.launcherName || project.name);
  const manifest = {
    schema: 'vynix-forge/launcher-project@1', generatedAt: new Date().toISOString(),
    identity: project.identity, branding: project.branding, layout: project.layout,
    features: project.features, minecraft: project.minecraft,
    servers: (servers||[]).map(s=>({name:s.name,address:s.address,port:s.port,loader:s.loader,autoConnect:s.autoConnect,isDefault:s.isDefault}))
  };
  return {
    slug,
    files: {
      'package.json': packageJson(project, slug),
      'main.js': MAIN_JS,
      'preload.js': PRELOAD_JS,
      'launch.js': LAUNCH_JS,
      'index.html': INDEX_HTML,
      'renderer.js': RENDERER_JS,
      'launcher.config.json': JSON.stringify(manifest, null, 2),
      '.gitignore': 'node_modules/\ndist/\n'
    }
  };
}

module.exports = { generateFiles, slugify };
