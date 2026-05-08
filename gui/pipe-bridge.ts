import { createPipeClient, type PipeClient } from '../src/daemon/pipe-client.js';
import type { CreateWorkspaceParams, WorkspaceState, WorkspaceSummary } from '../src/workspace/workspace-types.js';
import type { DaemonStatusResult } from '../src/shared/protocol.js';

export interface PipeBridge {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;

  request(method: string, params: unknown): Promise<unknown>;
  status(): Promise<DaemonStatusResult>;
  createWorkspace(params: CreateWorkspaceParams): Promise<{ workspaceId: string }>;
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }>;
  getWorkspace(id: string): Promise<{ workspace: WorkspaceState }>;
  attachWorkspace(id: string): Promise<void>;
  detachWorkspace(id: string): Promise<void>;
  deleteWorkspace(id: string, cleanWorktrees: boolean): Promise<void>;
  sendToPane(paneId: string, text: string): Promise<void>;
  interruptPane(paneId: string): Promise<void>;

  onNotification(handler: (method: string, params: unknown) => void): void;
}

export function createPipeBridge(pipePath: string): PipeBridge {
  let client: PipeClient | null = null;
  let connected = false;
  const notificationHandlers: ((method: string, params: unknown) => void)[] = [];

  function assertConnected(): PipeClient {
    if (!client || !connected) throw new Error('Not connected');
    return client;
  }

  return {
    async connect() {
      client = createPipeClient(pipePath);
      await client.connect();
      connected = true;
      client.onNotification((method, params) => {
        for (const handler of notificationHandlers) {
          handler(method, params);
        }
      });
    },

    disconnect() {
      if (client) {
        client.destroy();
        client = null;
      }
      connected = false;
    },

    isConnected() {
      return connected;
    },

    request(method, params) {
      return assertConnected().request(method, params);
    },

    async status() {
      return (await assertConnected().request('daemon.status', {})) as DaemonStatusResult;
    },

    async createWorkspace(params) {
      return (await assertConnected().request('workspace.create', params)) as { workspaceId: string };
    },

    async listWorkspaces() {
      return (await assertConnected().request('workspace.list', {})) as { workspaces: WorkspaceSummary[] };
    },

    async getWorkspace(id) {
      return (await assertConnected().request('workspace.get', { id })) as { workspace: WorkspaceState };
    },

    async attachWorkspace(id) {
      await assertConnected().request('workspace.attach', { id });
    },

    async detachWorkspace(id) {
      await assertConnected().request('workspace.detach', { id });
    },

    async deleteWorkspace(id, cleanWorktrees) {
      await assertConnected().request('workspace.delete', { id, cleanWorktrees });
    },

    async sendToPane(paneId, text) {
      await assertConnected().request('pane.send', { paneId, text });
    },

    async interruptPane(paneId) {
      await assertConnected().request('pane.interrupt', { paneId });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },
  };
}
