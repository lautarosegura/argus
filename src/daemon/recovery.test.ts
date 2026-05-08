import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDaemon, type Daemon } from './daemon.js';
import { createPipeClient } from './pipe-client.js';
import type { WorkspaceState, MergeRunState } from '../workspace/workspace-types.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-recovery-'));
  return path.join(dir, 'argus.sock');
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-recovery-repo-'));
  git(dir, 'init', '-b', 'main');
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-recovery-state-'));
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

function writeWorkspaceState(state: WorkspaceState): void {
  fs.writeFileSync(
    path.join(stateDir, `${state.id}.json`),
    JSON.stringify(state, null, 2),
  );
}

function makeInterruptedMergeState(
  repoDir: string,
  overrides?: Partial<MergeRunState>,
): MergeRunState {
  return {
    mergeRunId: 'merge-interrupted-1',
    phase: 'merging',
    preMergeTag: 'workspace-pre-merge-test',
    branchOrder: ['workspace/test-ws/agent-2', 'workspace/test-ws/agent-3'],
    mergedBranches: [],
    verifyCommand: 'true',
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function makeWorkspaceState(repoDir: string, overrides?: Partial<WorkspaceState>): WorkspaceState {
  return {
    schemaVersion: 1,
    id: 'test-ws',
    name: 'test-ws',
    createdAt: new Date().toISOString(),
    repoPath: repoDir,
    intent: '',
    agentRatio: [{ cli: 'claude', count: 3 }],
    panes: [
      { paneId: 'agent-1', role: 'lead', cli: 'claude', worktreeRelPath: '.workspace/worktrees/agent-1', branchName: 'workspace/test-ws/agent-1', userClosed: false, lastKnownState: 'idle' },
      { paneId: 'agent-2', role: 'worker', cli: 'claude', worktreeRelPath: '.workspace/worktrees/agent-2', branchName: 'workspace/test-ws/agent-2', userClosed: false, lastKnownState: 'done' },
      { paneId: 'agent-3', role: 'worker', cli: 'claude', worktreeRelPath: '.workspace/worktrees/agent-3', branchName: 'workspace/test-ws/agent-3', userClosed: false, lastKnownState: 'done' },
    ],
    plan: null,
    mergeState: null,
    ...overrides,
  };
}

function setupRepoWithWorkerBranches(repoDir: string): void {
  const mainHead = git(repoDir, 'rev-parse', 'HEAD');
  git(repoDir, 'tag', 'workspace-pre-merge-test');

  for (const paneId of ['agent-2', 'agent-3']) {
    const branch = `workspace/test-ws/${paneId}`;
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', paneId);
    fs.mkdirSync(wtPath, { recursive: true });
    git(repoDir, 'worktree', 'add', '-b', branch, wtPath);
    const fileName = `${paneId}.ts`;
    fs.writeFileSync(path.join(wtPath, fileName), `export const x = 1;\n`);
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-m', `${paneId} changes`);
  }
}

describe('merge.revert RPC', () => {
  it('reverts interrupted merge to pre-merge tag', async () => {
    const repoDir = makeRepo();
    setupRepoWithWorkerBranches(repoDir);

    const mainBefore = git(repoDir, 'rev-parse', 'workspace-pre-merge-test');

    git(repoDir, 'merge', 'workspace/test-ws/agent-2', '--no-edit');

    const state = makeWorkspaceState(repoDir, {
      mergeState: makeInterruptedMergeState(repoDir, {
        phase: 'merging',
        mergedBranches: ['workspace/test-ws/agent-2'],
      }),
    });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('merge.revert', { workspaceId: 'test-ws' });

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    const ws = (await client.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    expect(ws.workspace.mergeState).not.toBeNull();
    expect(ws.workspace.mergeState!.phase).toBe('reverted');

    client.destroy();
  });

  it('rejects revert when no interrupted merge exists', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir, { mergeState: null });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await expect(
      client.request('merge.revert', { workspaceId: 'test-ws' }),
    ).rejects.toThrow();

    client.destroy();
  });

  it('rejects revert when merge already completed', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir, {
      mergeState: makeInterruptedMergeState(repoDir, {
        phase: 'complete',
        completedAt: new Date().toISOString(),
      }),
    });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await expect(
      client.request('merge.revert', { workspaceId: 'test-ws' }),
    ).rejects.toThrow();

    client.destroy();
  });
});

describe('merge.resume RPC', () => {
  it('resumes interrupted merge and reaches complete', async () => {
    const repoDir = makeRepo();
    setupRepoWithWorkerBranches(repoDir);

    git(repoDir, 'merge', 'workspace/test-ws/agent-2', '--no-edit');

    const state = makeWorkspaceState(repoDir, {
      mergeState: makeInterruptedMergeState(repoDir, {
        phase: 'merging',
        mergedBranches: ['workspace/test-ws/agent-2'],
      }),
    });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const result = (await client.request('merge.resume', {
      workspaceId: 'test-ws',
    })) as { mergeRunId: string };

    expect(result.mergeRunId).toBeTruthy();

    const start = Date.now();
    let ws: WorkspaceState | null = null;
    while (Date.now() - start < 5000) {
      const resp = (await client.request('workspace.get', { id: 'test-ws' })) as {
        workspace: WorkspaceState;
      };
      if (resp.workspace.mergeState &&
        ['complete', 'reverted'].includes(resp.workspace.mergeState.phase)) {
        ws = resp.workspace;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(ws).not.toBeNull();
    expect(ws!.mergeState!.phase).toBe('complete');

    client.destroy();
  });

  it('rejects resume when no interrupted merge exists', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir, { mergeState: null });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await expect(
      client.request('merge.resume', { workspaceId: 'test-ws' }),
    ).rejects.toThrow();

    client.destroy();
  });

  it('rejects resume when merge is already active', async () => {
    const repoDir = makeRepo();
    setupRepoWithWorkerBranches(repoDir);

    const state = makeWorkspaceState(repoDir, {
      mergeState: makeInterruptedMergeState(repoDir, { phase: 'merging' }),
    });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('merge.resume', { workspaceId: 'test-ws' });

    await expect(
      client.request('merge.resume', { workspaceId: 'test-ws' }),
    ).rejects.toThrow(/in progress/i);

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const resp = (await client.request('workspace.get', { id: 'test-ws' })) as {
        workspace: WorkspaceState;
      };
      if (resp.workspace.mergeState &&
        ['complete', 'reverted'].includes(resp.workspace.mergeState.phase)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    client.destroy();
  });
});

describe('pane.close RPC', () => {
  it('sets userClosed to true for the specified pane', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir);
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('pane.close', {
      workspaceId: 'test-ws',
      paneId: 'agent-2',
    });

    const ws = (await client.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    const pane = ws.workspace.panes.find((p) => p.paneId === 'agent-2');
    expect(pane!.userClosed).toBe(true);

    const otherPane = ws.workspace.panes.find((p) => p.paneId === 'agent-1');
    expect(otherPane!.userClosed).toBe(false);

    client.destroy();
  });

  it('rejects close for non-existent pane', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir);
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await expect(
      client.request('pane.close', {
        workspaceId: 'test-ws',
        paneId: 'nonexistent',
      }),
    ).rejects.toThrow();

    client.destroy();
  });
});

describe('daemon recovery on restart', () => {
  it('preserves workspace state across daemon restart', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir);
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client1 = createPipeClient(pipePath);
    await client1.connect();
    const ws1 = (await client1.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    expect(ws1.workspace.panes).toHaveLength(3);
    client1.destroy();

    await daemon.stop();
    daemon = null;

    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client2 = createPipeClient(pipePath);
    await client2.connect();
    const ws2 = (await client2.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    expect(ws2.workspace.panes).toHaveLength(3);
    expect(ws2.workspace.id).toBe('test-ws');

    client2.destroy();
  });

  it('userClosed panes stay closed after restart', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir);
    state.panes[1].userClosed = true;
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const ws = (await client.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    const closedPane = ws.workspace.panes.find((p) => p.paneId === 'agent-2');
    expect(closedPane!.userClosed).toBe(true);

    client.destroy();
  });

  it('interrupted merge detected via workspace.get after restart', async () => {
    const repoDir = makeRepo();
    const state = makeWorkspaceState(repoDir, {
      mergeState: makeInterruptedMergeState(repoDir, { phase: 'testing' }),
    });
    writeWorkspaceState(state);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const ws = (await client.request('workspace.get', { id: 'test-ws' })) as {
      workspace: WorkspaceState;
    };
    expect(ws.workspace.mergeState).not.toBeNull();
    expect(ws.workspace.mergeState!.phase).toBe('testing');
    expect(ws.workspace.mergeState!.preMergeTag).toBe('workspace-pre-merge-test');

    client.destroy();
  });

  it('workspace.listRecoverable returns workspaces needing recovery', async () => {
    const repoDir = makeRepo();

    const active = makeWorkspaceState(repoDir, {
      id: 'active-ws',
      name: 'active-ws',
    });
    writeWorkspaceState(active);

    const interrupted = makeWorkspaceState(repoDir, {
      id: 'merge-ws',
      name: 'merge-ws',
      mergeState: makeInterruptedMergeState(repoDir, { phase: 'merging' }),
    });
    writeWorkspaceState(interrupted);

    const completed = makeWorkspaceState(repoDir, {
      id: 'done-ws',
      name: 'done-ws',
      mergeState: makeInterruptedMergeState(repoDir, {
        phase: 'complete',
        completedAt: new Date().toISOString(),
      }),
    });
    writeWorkspaceState(completed);

    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const result = (await client.request('workspace.listRecoverable', {})) as {
      workspaces: Array<{
        id: string;
        interruptedMerge: boolean;
        activePaneCount: number;
      }>;
    };

    expect(result.workspaces).toHaveLength(3);

    const mergeWs = result.workspaces.find((w) => w.id === 'merge-ws');
    expect(mergeWs!.interruptedMerge).toBe(true);

    const activeWs = result.workspaces.find((w) => w.id === 'active-ws');
    expect(activeWs!.interruptedMerge).toBe(false);

    const doneWs = result.workspaces.find((w) => w.id === 'done-ws');
    expect(doneWs!.interruptedMerge).toBe(false);

    client.destroy();
  });
});
