/** @type {PaneGrid | null} */
let grid = null;
/** @type {PlanEditor | null} */
let planEditor = null;
/** @type {MergePane | null} */
let mergePane = null;
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
    if (planEditor) {
      planEditor.dispose();
      planEditor = null;
    }
    if (mergePane) {
      mergePane.dispose();
      mergePane = null;
    }

    mainContent.innerHTML = '';
    mainContent.style.display = 'flex';
    mainContent.style.flexDirection = 'column';
    mainContent.style.flex = '1';

    if (workspace.plan) {
      try {
        const planData = await window.argus.getPlan(id);
        const planContainer = document.createElement('div');
        planContainer.style.padding = '8px';
        mainContent.appendChild(planContainer);

        planEditor = new PlanEditor(planContainer);
        planEditor.render(id, planData, (result) => {
          // Plan was approved — workers can be spawned with tasks
        });
      } catch {
        // Plan fetch failed — continue without plan editor
      }
    }

    if (workspace.mergeState) {
      const mergeContainer = document.createElement('div');
      mergeContainer.style.padding = '8px';
      mainContent.appendChild(mergeContainer);

      mergePane = new MergePane(mergeContainer);
      mergePane.render(id, workspace.mergeState);
    }

    const gridContainer = document.createElement('div');
    gridContainer.style.flex = '1';
    gridContainer.style.display = 'flex';
    gridContainer.style.overflow = 'hidden';
    mainContent.appendChild(gridContainer);

    const nodeModulesPath = await window.argus.getNodeModulesPath();
    grid = new PaneGrid(gridContainer);
    await grid.loadXterm(nodeModulesPath);

    grid.render(workspace.panes, async (paneId, text) => {
      await window.argus.sendToPane(paneId, text);
    });

    await window.argus.attachWorkspace(id);
  } catch (err) {
    mainContent.innerHTML = '';
    const errorDiv = document.createElement('div');
    errorDiv.className = 'empty-state';

    const heading = document.createElement('h1');
    heading.textContent = 'Error';
    const msg = document.createElement('p');
    msg.textContent = err.message || 'Failed to open workspace';
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => showEmptyState());

    errorDiv.append(heading, msg, backBtn);
    mainContent.appendChild(errorDiv);
  }
}

window.argus.onNotification((method, params) => {
  if (method === 'pane.event' && grid && params.workspaceId === currentWorkspaceId) {
    grid.handlePaneEvent(params.paneId, params.event);
  }
  if (method === 'merge.progress' && mergePane && params.workspaceId === currentWorkspaceId) {
    mergePane.updatePhase(params.phase, params.detail);
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
