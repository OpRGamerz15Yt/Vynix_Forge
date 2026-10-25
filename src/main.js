const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { launchMinecraft } = require('./minecraft');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('launch-game', async (event, username) => {
  try {
    const config = require('./config');
    await launchMinecraft(config, username);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
