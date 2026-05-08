import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDaemon, type Daemon } from '../daemon/daemon.js';
import { createPipeClient } from '../daemon/pipe-client.js';
import type { WorkspaceState, WorkspaceSummary } from './workspace-types.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rpc-test-'));
  return path.join(dir, 'argus.sock');
}

let daemon: Daemon | null = null;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-state-test-'));
});

afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('workspace.* JSON-RPC', () => {
  it('workspace.create returns workspaceId', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();
    const result = (await client.request('workspace.create', {
      name: 'test-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    })) as { workspaceId: string };
    client.destroy();

    expect(result.workspaceId).toBe('test-ws');
  });

  it('workspace.list returns all workspaces', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'ws-1',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo-1',
    });
    await client.request('workspace.create', {
      name: 'ws-2',
      agentRatio: [{ cli: 'codex', count: 2 }],
      repoPath: '/tmp/repo-2',
    });

    const result = (await client.request('workspace.list', {})) as {
      workspaces: WorkspaceSummary[];
    };
    client.destroy();

    expect(result.workspaces).toHaveLength(2);
    const names = result.workspaces.map((w) => w.name).sort();
    expect(names).toEqual(['ws-1', 'ws-2']);
  });

  it('workspace.get returns the full workspace state', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'detailed',
      agentRatio: [{ cli: 'claude', count: 3 }],
      repoPath: '/tmp/detail-repo',
    });

    const result = (await client.request('workspace.get', { id: 'detailed' })) as {
      workspace: WorkspaceState;
    };
    client.destroy();

    expect(result.workspace.id).toBe('detailed');
    expect(result.workspace.name).toBe('detailed');
    expect(result.workspace.repoPath).toBe('/tmp/detail-repo');
    expect(result.workspace.agentRatio).toEqual([{ cli: 'claude', count: 3 }]);
    expect(result.workspace.panes).toEqual([]);
    expect(result.workspace.schemaVersion).toBe(1);
  });

  it('workspace.get with non-existent id returns WORKSPACE_NOT_FOUND error', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await expect(client.request('workspace.get', { id: 'ghost' })).rejects.toThrow(/not found/i);
    client.destroy();
  });

  it('workspace.delete removes the workspace', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'to-remove',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    await client.request('workspace.delete', { id: 'to-remove', cleanWorktrees: false });

    await expect(
      client.request('workspace.get', { id: 'to-remove' }),
    ).rejects.toThrow(/not found/i);
    client.destroy();
  });

  it('workspace.create updates daemon.status workspaceCount', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'counted',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    const status = (await client.request('daemon.status', {})) as { workspaceCount: number };
    client.destroy();

    expect(status.workspaceCount).toBe(1);
  });

  it('workspace.create rejects duplicate names', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'dup',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    await expect(
      client.request('workspace.create', {
        name: 'dup',
        agentRatio: [{ cli: 'claude', count: 1 }],
        repoPath: '/tmp/repo',
      }),
    ).rejects.toThrow(/already exists/);
    client.destroy();
  });
});
