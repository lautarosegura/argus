import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDaemon, type Daemon } from '../daemon/daemon.js';
import { createPipeClient } from '../daemon/pipe-client.js';
import type { WorkspaceState } from '../workspace/workspace-types.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plan-rpc-'));
  return path.join(dir, 'argus.sock');
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plan-repo-'));
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plan-state-'));
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

async function createWorkspaceWithPlan(
  pipePath: string,
  repoDir: string,
  name: string,
  agentCount: number,
): Promise<string> {
  const client = createPipeClient(pipePath);
  await client.connect();
  const result = (await client.request('workspace.create', {
    name,
    agentRatio: [{ cli: 'claude', count: agentCount }],
    repoPath: repoDir,
    plan: '.workspace/plan.md',
  })) as { workspaceId: string };
  client.destroy();
  return result.workspaceId;
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

# Refactoring Plan

Split the auth module into two services.
`;

describe('plan.update JSON-RPC', () => {
  it('writes plan content to disk', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'plan-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', {
      workspaceId: wsId,
      content: SAMPLE_PLAN,
    });
    client.destroy();

    const planPath = path.join(repoDir, '.workspace', 'plan.md');
    expect(fs.existsSync(planPath)).toBe(true);
    const onDisk = fs.readFileSync(planPath, 'utf-8');
    expect(onDisk).toBe(SAMPLE_PLAN);
  });

  it('rejects update for workspace without plan configured', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('workspace.create', {
      name: 'no-plan',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    await expect(
      client.request('plan.update', {
        workspaceId: 'no-plan',
        content: SAMPLE_PLAN,
      }),
    ).rejects.toThrow(/plan.*not configured/i);
    client.destroy();
  });

  it('rejects update after plan is already approved', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'approved-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });
    await client.request('plan.approve', { workspaceId: wsId });

    await expect(
      client.request('plan.update', { workspaceId: wsId, content: 'new content' }),
    ).rejects.toThrow(/already approved/i);
    client.destroy();
  });
});

describe('plan.get JSON-RPC', () => {
  it('returns plan content from disk', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'get-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });

    const result = (await client.request('plan.get', { workspaceId: wsId })) as {
      content: string;
      approvedAt: string | null;
    };
    client.destroy();

    expect(result.content).toBe(SAMPLE_PLAN);
    expect(result.approvedAt).toBeNull();
  });

  it('returns null content when plan file does not yet exist', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'empty-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    const result = (await client.request('plan.get', { workspaceId: wsId })) as {
      content: string | null;
      approvedAt: string | null;
    };
    client.destroy();

    expect(result.content).toBeNull();
    expect(result.approvedAt).toBeNull();
  });
});

describe('plan.approve JSON-RPC', () => {
  it('sets approvedAt in state and returns parsed tasks', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'approve-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });

    const result = (await client.request('plan.approve', { workspaceId: wsId })) as {
      approvedAt: string;
      tasks: Array<{ id: string; assignedTo: string; dependsOn: string[] }>;
    };
    client.destroy();

    expect(result.approvedAt).toBeTruthy();
    expect(new Date(result.approvedAt).getTime()).toBeGreaterThan(0);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe('task-1');
    expect(result.tasks[1].dependsOn).toEqual(['task-1']);
  });

  it('persists approvedAt in state.json', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'persist-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });
    await client.request('plan.approve', { workspaceId: wsId });

    const state = (
      (await client.request('workspace.get', { id: wsId })) as { workspace: WorkspaceState }
    ).workspace;
    client.destroy();

    expect(state.plan).not.toBeNull();
    expect(state.plan!.approvedAt).toBeTruthy();
  });

  it('rejects approve when no plan content has been written', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'empty-approve', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await expect(
      client.request('plan.approve', { workspaceId: wsId }),
    ).rejects.toThrow(/no plan content/i);
    client.destroy();
  });

  it('rejects double approve', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const wsId = await createWorkspaceWithPlan(pipePath, repoDir, 'double-ws', 3);

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('plan.update', { workspaceId: wsId, content: SAMPLE_PLAN });
    await client.request('plan.approve', { workspaceId: wsId });

    await expect(
      client.request('plan.approve', { workspaceId: wsId }),
    ).rejects.toThrow(/already approved/i);
    client.destroy();
  });
});
