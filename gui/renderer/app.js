/** @type {PaneGrid | null} */
let grid = null;
const form = new WorkspaceForm();
let currentWorkspaceId = null;

const mainContent = document.getElementById('main-content');
const workspaceName = document.getElementById('workspace-name');
const connectionStatus = document.getElementById('connection-status');
const disconnectedBanner = document.getElementById('disconnected-banner');

function showEmptyState() {
  mainContent.innerHTML = '';
  mainContent.style.display = 'flex';

  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML = `
    <h1>Welcome to Argus</h1>
    <p>Create a workspace to start orchestrating agents in parallel.</p>
    <button class="btn btn-primary" id="new-workspace-btn">New Workspace</button>
  `;
  mainContent.appendChild(empty);

  empty.querySelector('#new-workspace-btn').addEventListener('click', () => {
    form.show(async (params) => {
      const result = await window.argus.createWorkspace(params);
      await openWorkspace(result.workspaceId);
    });
  });
}

async function openWorkspace(id) {
  try {
    const { workspace } = await window.argus.getWorkspace(id);

    if (currentWorkspaceId) {
      await window.argus.detachWorkspace(currentWorkspaceId).catch(() => {});
    }

    currentWorkspaceId = id;
    workspaceName.textContent = workspace.name;

    if (grid) {
      grid.dispose();
    }

    mainContent.innerHTML = '';
    mainContent.style.display = 'flex';
    mainContent.style.flex = '1';

    const nodeModulesPath = await window.argus.getNodeModulesPath();
    grid = new PaneGrid(mainContent);
    await grid.loadXterm(nodeModulesPath);

    grid.render(workspace.panes, async (paneId, text) => {
      await window.argus.sendToPane(paneId, text);
    });

    await window.argus.attachWorkspace(id);
  } catch (err) {
    mainContent.innerHTML = `
      <div class="empty-state">
        <h1>Error</h1>
        <p>${err.message || 'Failed to open workspace'}</p>
        <button class="btn btn-secondary" onclick="showEmptyState()">Back</button>
      </div>
    `;
  }
}

window.argus.onNotification((method, params) => {
  if (method === 'pane.event' && grid && params.workspaceId === currentWorkspaceId) {
    grid.handlePaneEvent(params.paneId, params.event);
  }
  if (method === 'workspace.stateChanged' && params.workspaceId === currentWorkspaceId) {
    // Refresh workspace state on major changes
  }
  if (method === 'daemon.shuttingDown') {
    connectionStatus.textContent = 'daemon shutting down';
    disconnectedBanner.style.display = 'block';
  }
});

window.argus.onOpenWorkspace((workspaceId) => {
  openWorkspace(workspaceId);
});

async function init() {
  try {
    const connected = await window.argus.isConnected();
    if (connected) {
      connectionStatus.textContent = 'connected';
      disconnectedBanner.style.display = 'none';
    } else {
      connectionStatus.textContent = 'disconnected';
      disconnectedBanner.style.display = 'block';
    }
  } catch {
    connectionStatus.textContent = 'disconnected';
    disconnectedBanner.style.display = 'block';
  }
  showEmptyState();
}

init();
