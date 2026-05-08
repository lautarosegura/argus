import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDaemon, type Daemon } from '../daemon/daemon.js';
import { createPipeClient } from '../daemon/pipe-client.js';
import type { WorkspaceState, WorkspaceSummary } from './workspace-types.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rpc-test-'));
  return path.join(dir, 'argus.sock');
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rpc-repo-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

let daemon: Daemon | null = null;
let stateDir: string;
const repoDirs: string[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-state-test-'));
});

afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  for (const dir of repoDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  repoDirs.length = 0;
});

function makeRepo(): string {
  const dir = initRepo();
  repoDirs.push(dir);
  return dir;
}

describe('workspace.* JSON-RPC', () => {
  it('workspace.create returns workspaceId', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();
    const result = (await client.request('workspace.create', {
      name: 'test-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    })) as { workspaceId: string };
    client.destroy();

    expect(result.workspaceId).toBe('test-ws');
  });

  it('workspace.list returns all workspaces', async () => {
    const repo1 = makeRepo();
    const repo2 = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'ws-1',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repo1,
    });
    await client.request('workspace.create', {
      name: 'ws-2',
      agentRatio: [{ cli: 'codex', count: 2 }],
      repoPath: repo2,
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
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'detailed',
      agentRatio: [{ cli: 'claude', count: 3 }],
      repoPath: repoDir,
    });

    const result = (await client.request('workspace.get', { id: 'detailed' })) as {
      workspace: WorkspaceState;
    };
    client.destroy();

    expect(result.workspace.id).toBe('detailed');
    expect(result.workspace.name).toBe('detailed');
    expect(result.workspace.repoPath).toBe(repoDir);
    expect(result.workspace.agentRatio).toEqual([{ cli: 'claude', count: 3 }]);
    expect(result.workspace.panes).toHaveLength(3);
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
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'to-remove',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    await client.request('workspace.delete', { id: 'to-remove', cleanWorktrees: false });

    await expect(
      client.request('workspace.get', { id: 'to-remove' }),
    ).rejects.toThrow(/not found/i);
    client.destroy();
  });

  it('workspace.create updates daemon.status workspaceCount', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'counted',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    const status = (await client.request('daemon.status', {})) as { workspaceCount: number };
    client.destroy();

    expect(status.workspaceCount).toBe(1);
  });

  it('workspace.create rejects duplicate names', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'dup',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    await expect(
      client.request('workspace.create', {
        name: 'dup',
        agentRatio: [{ cli: 'claude', count: 1 }],
        repoPath: repoDir,
      }),
    ).rejects.toThrow(/already exists/);
    client.destroy();
  });

  it('workspace.create provisions worktrees and populates panes', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'demo',
      agentRatio: [{ cli: 'claude', count: 2 }],
      repoPath: repoDir,
    });

    const result = (await client.request('workspace.get', { id: 'demo' })) as {
      workspace: WorkspaceState;
    };
    client.destroy();

    expect(result.workspace.panes).toHaveLength(2);
    expect(result.workspace.panes[0].paneId).toBe('agent-1');
    expect(result.workspace.panes[0].role).toBe('lead');
    expect(result.workspace.panes[0].branchName).toBe('workspace/demo/agent-1');
    expect(result.workspace.panes[1].paneId).toBe('agent-2');
    expect(result.workspace.panes[1].role).toBe('worker');

    expect(fs.existsSync(path.join(repoDir, '.workspace', 'worktrees', 'agent-1'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, '.workspace', 'worktrees', 'agent-2'))).toBe(true);

    const gitignore = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.workspace/');
  });

  it('workspace.delete with cleanWorktrees removes worktrees and branches', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'to-clean',
      agentRatio: [{ cli: 'claude', count: 2 }],
      repoPath: repoDir,
    });

    await client.request('workspace.delete', { id: 'to-clean', cleanWorktrees: true });
    client.destroy();

    expect(fs.existsSync(path.join(repoDir, '.workspace', 'worktrees', 'agent-1'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, '.workspace', 'worktrees', 'agent-2'))).toBe(false);

    const branches = git(repoDir, 'branch', '--list');
    expect(branches).not.toContain('workspace/to-clean/agent-1');
    expect(branches).not.toContain('workspace/to-clean/agent-2');
  });
});
