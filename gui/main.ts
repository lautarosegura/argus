import { app, BrowserWindow, ipcMain, protocol, net as electronNet } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeBridge, type PipeBridge } from './pipe-bridge.js';
import { getPipePath } from '../src/shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let bridge: PipeBridge | null = null;
let currentWorkspaceId: string | null = null;

function getRequestedWorkspace(): string | null {
  const idx = process.argv.indexOf('--workspace');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

async function connectBridge(): Promise<PipeBridge> {
  const pipePath = process.env.ARGUS_PIPE ?? getPipePath();
  const b = createPipeBridge(pipePath);
  await b.connect();

  b.onNotification((method, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('daemon-notification', { method, params });
  });

  return b;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Argus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    mainWindow = null;
    if (bridge && currentWorkspaceId) {
      bridge.detachWorkspace(currentWorkspaceId).catch(() => {});
    }
  });

  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle('bridge:status', async () => {
    if (!bridge) throw new Error('Not connected');
    return bridge.status();
  });

  ipcMain.handle('bridge:createWorkspace', async (_e, params) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.createWorkspace(params);
  });

  ipcMain.handle('bridge:listWorkspaces', async () => {
    if (!bridge) throw new Error('Not connected');
    return bridge.listWorkspaces();
  });

  ipcMain.handle('bridge:getWorkspace', async (_e, id: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.getWorkspace(id);
  });

  ipcMain.handle('bridge:attachWorkspace', async (_e, id: string) => {
    if (!bridge) throw new Error('Not connected');
    if (currentWorkspaceId) {
      await bridge.detachWorkspace(currentWorkspaceId).catch(() => {});
    }
    await bridge.attachWorkspace(id);
    currentWorkspaceId = id;
  });

  ipcMain.handle('bridge:detachWorkspace', async (_e, id: string) => {
    if (!bridge) throw new Error('Not connected');
    await bridge.detachWorkspace(id);
    if (currentWorkspaceId === id) currentWorkspaceId = null;
  });

  ipcMain.handle('bridge:deleteWorkspace', async (_e, id: string, cleanWorktrees: boolean) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.deleteWorkspace(id, cleanWorktrees);
  });

  ipcMain.handle('bridge:sendToPane', async (_e, paneId: string, text: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.sendToPane(paneId, text);
  });

  ipcMain.handle('bridge:interruptPane', async (_e, paneId: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.interruptPane(paneId);
  });

  ipcMain.handle('bridge:getPlan', async (_e, workspaceId: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.getPlan(workspaceId);
  });

  ipcMain.handle('bridge:updatePlan', async (_e, workspaceId: string, content: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.updatePlan(workspaceId, content);
  });

  ipcMain.handle('bridge:approvePlan', async (_e, workspaceId: string) => {
    if (!bridge) throw new Error('Not connected');
    return bridge.approvePlan(workspaceId);
  });

  ipcMain.handle('bridge:isConnected', () => {
    return bridge?.isConnected() ?? false;
  });

  ipcMain.handle('get:nodeModulesPath', () => {
    return path.join(__dirname, '..', 'node_modules');
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const wsIdx = argv.indexOf('--workspace');
    const ws = wsIdx !== -1 ? argv[wsIdx + 1] : null;

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (ws) {
        mainWindow.webContents.send('open-workspace', ws);
      }
    }
  });

  app.whenReady().then(async () => {
    protocol.handle('argus-asset', (request) => {
      const url = request.url.replace('argus-asset://', '');
      const filePath = path.join(__dirname, '..', url);
      return electronNet.fetch(`file://${filePath}`);
    });

    registerIpcHandlers();

    try {
      bridge = await connectBridge();
    } catch {
      // Daemon not running — GUI will show disconnected state
    }

    mainWindow = createWindow();

    const requestedWs = getRequestedWorkspace();
    if (requestedWs) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow!.webContents.send('open-workspace', requestedWs);
      });
    }
  });

  app.on('window-all-closed', () => {
    if (bridge) {
      bridge.disconnect();
      bridge = null;
    }
    app.quit();
  });
}
