const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('argus', {
  status: () => ipcRenderer.invoke('bridge:status'),
  createWorkspace: (params) => ipcRenderer.invoke('bridge:createWorkspace', params),
  listWorkspaces: () => ipcRenderer.invoke('bridge:listWorkspaces'),
  getWorkspace: (id) => ipcRenderer.invoke('bridge:getWorkspace', id),
  attachWorkspace: (id) => ipcRenderer.invoke('bridge:attachWorkspace', id),
  detachWorkspace: (id) => ipcRenderer.invoke('bridge:detachWorkspace', id),
  deleteWorkspace: (id, cleanWorktrees) => ipcRenderer.invoke('bridge:deleteWorkspace', id, cleanWorktrees),
  sendToPane: (paneId, text) => ipcRenderer.invoke('bridge:sendToPane', paneId, text),
  interruptPane: (paneId) => ipcRenderer.invoke('bridge:interruptPane', paneId),
  isConnected: () => ipcRenderer.invoke('bridge:isConnected'),
  getNodeModulesPath: () => ipcRenderer.invoke('get:nodeModulesPath'),

  onNotification: (callback) => {
    const handler = (_event, data) => callback(data.method, data.params);
    ipcRenderer.on('daemon-notification', handler);
    return () => ipcRenderer.removeListener('daemon-notification', handler);
  },

  onOpenWorkspace: (callback) => {
    const handler = (_event, workspaceId) => callback(workspaceId);
    ipcRenderer.on('open-workspace', handler);
    return () => ipcRenderer.removeListener('open-workspace', handler);
  },
});
