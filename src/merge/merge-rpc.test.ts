import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDaemon, type Daemon } from '../daemon/daemon.js';
import { createPipeClient, type PipeClient } from '../daemon/pipe-client.js';
import type { WorkspaceState } from '../workspace/workspace-types.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-merge-rpc-'));
  return path.join(dir, 'argus.sock');
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-merge-repo-'));
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-merge-state-'));
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

const SAMPLE_PLAN = `---
tasks:
  - id: task-1
    assignedTo: agent-2
    dependsOn: []
  - id: task-2
    assignedTo: agent-3
    dependsOn: [task-1]
---

# Merge Test Plan

Two tasks for merging.
`;

async function setupWorkspaceWithDoneWorkers(
  pipePath: string,
  repoDir: string,
): Promise<string> {
  const client = createPipeClient(pipePath);
  await client.connect();

  const result = (await client.request('workspace.create', {
    name: 'merge-ws',
    agentRatio: [{ cli: 'claude', count: 3 }],
    repoPath: repoDir,
    plan: '.workspace/plan.md',
  })) as { workspaceId: string };

  const wsId = result.workspaceId;

  await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });
  await client.request('plan.approve', { workspaceId: wsId });

  const stateResult = (await client.request('workspace.get', { id: wsId })) as {
    workspace: WorkspaceState;
  };
  const state = stateResult.workspace;
  for (const pane of state.panes) {
    if (pane.role === 'worker') {
      pane.lastKnownState = 'done';
    }
  }

  const stateFile = path.join(stateDir, `${wsId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  client.destroy();
  return wsId;
}

function addWorkerCommits(repoDir: string): void {
  const worktrees = [
    { paneId: 'agent-2', index: 1 },
    { paneId: 'agent-3', index: 2 },
  ];

  for (const { paneId, index } of worktrees) {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', paneId);
    const fileName = `worker-${index}.ts`;
    fs.writeFileSync(path.join(wtPath, fileName), `export const w${index} = ${index};\n`);
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-m', `worker ${index} changes`);
  }
}

async function waitForMergePhase(
  client: PipeClient,
  wsId: string,
  targetPhases: string[],
  timeoutMs = 5000,
): Promise<WorkspaceState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = (await client.request('workspace.get', { id: wsId })) as {
      workspace: WorkspaceState;
    };
    if (result.workspace.mergeState && targetPhases.includes(result.workspace.mergeState.phase)) {
      return result.workspace;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const result = (await client.request('workspace.get', { id: wsId })) as {
    workspace: WorkspaceState;
  };
  return result.workspace;
}

describe('merge.start JSON-RPC', () => {
  it('returns mergeRunId and reaches complete', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await setupWorkspaceWithDoneWorkers(pipePath, repoDir);
    addWorkerCommits(repoDir);

    const client = createPipeClient(pipePath);
    await client.connect();

    const result = (await client.request('merge.start', {
      workspaceId: wsId,
      verifyCommand: 'true',
    })) as { mergeRunId: string };

    expect(result.mergeRunId).toMatch(/^merge-/);

    const ws = await waitForMergePhase(client, wsId, ['complete', 'reverted']);
    expect(ws.mergeState).not.toBeNull();
    expect(ws.mergeState!.phase).toBe('complete');

    client.destroy();
  });

  it('fails when workers are not done', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'not-done-ws',
      agentRatio: [{ cli: 'claude', count: 2 }],
      repoPath: repoDir,
      plan: '.workspace/plan.md',
    });

    await expect(
      client.request('merge.start', { workspaceId: 'not-done-ws' }),
    ).rejects.toThrow(/not.*done|not ready/i);

    client.destroy();
  });

  it('emits merge.progress notifications', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await setupWorkspaceWithDoneWorkers(pipePath, repoDir);
    addWorkerCommits(repoDir);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('workspace.attach', { id: wsId });

    const notifications: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('merge.start', {
      workspaceId: wsId,
      verifyCommand: 'true',
    });

    await waitForMergePhase(client, wsId, ['complete', 'reverted']);

    const progressNotifs = notifications.filter((n) => n.method === 'merge.progress');
    expect(progressNotifs.length).toBeGreaterThan(0);

    const phases = progressNotifs.map(
      (n) => (n.params as { phase: string }).phase,
    );
    expect(phases).toContain('tagging');
    expect(phases).toContain('complete');

    client.destroy();
  });

  it('reverts on failing verify command', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await setupWorkspaceWithDoneWorkers(pipePath, repoDir);
    addWorkerCommits(repoDir);

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('merge.start', {
      workspaceId: wsId,
      verifyCommand: 'false',
    });

    const ws = await waitForMergePhase(client, wsId, ['reverted']);
    expect(ws.mergeState!.phase).toBe('reverted');

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    client.destroy();
  });
});

describe('merge.cancel JSON-RPC', () => {
  it('reverts cleanly when cancelled', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await setupWorkspaceWithDoneWorkers(pipePath, repoDir);
    addWorkerCommits(repoDir);

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('workspace.attach', { id: wsId });

    await client.request('merge.start', {
      workspaceId: wsId,
      verifyCommand: 'sleep 30',
    });

    await waitForMergePhase(client, wsId, ['testing'], 3000);

    await client.request('merge.cancel', { workspaceId: wsId });

    const ws = await waitForMergePhase(client, wsId, ['reverted']);
    expect(ws.mergeState!.phase).toBe('reverted');

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    client.destroy();
  });
});
