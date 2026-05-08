import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDaemon, type Daemon } from './daemon.js';
import { createPipeClient } from './pipe-client.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sentinel-test-'));
  return path.join(dir, 'argus.sock');
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sentinel-repo-'));
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-state-sentinel-'));
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

describe('sentinel.report JSON-RPC', () => {
  it('sentinel.report done updates pane state and emits sentinel event', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'sentinel-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    const notifications: { method: string; params: unknown }[] = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('workspace.attach', { id: 'sentinel-ws' });

    const result = await client.request('sentinel.report', {
      workspaceId: 'sentinel-ws',
      paneId: 'agent-1',
      cmd: 'done',
      payload: { summary: 'shipped auth flow', needsReview: true },
    });

    expect(result).toEqual({});

    await new Promise((r) => setTimeout(r, 50));

    const sentinelEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'sentinel',
    );
    expect(sentinelEvents).toHaveLength(1);
    expect((sentinelEvents[0].params as any).event.cmd).toBe('done');
    expect((sentinelEvents[0].params as any).event.payload).toEqual({
      summary: 'shipped auth flow',
      needsReview: true,
    });

    const stateEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'state',
    );
    expect(stateEvents).toHaveLength(1);
    expect((stateEvents[0].params as any).event.state).toBe('done');

    client.destroy();
  });

  it('sentinel.report blocked updates pane state and emits sentinel event', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'blocked-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    const notifications: { method: string; params: unknown }[] = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('workspace.attach', { id: 'blocked-ws' });

    await client.request('sentinel.report', {
      workspaceId: 'blocked-ws',
      paneId: 'agent-1',
      cmd: 'blocked',
      payload: { reason: 'need DB password' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const sentinelEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'sentinel',
    );
    expect(sentinelEvents).toHaveLength(1);
    expect((sentinelEvents[0].params as any).event.cmd).toBe('blocked');

    const stateEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'state',
    );
    expect(stateEvents).toHaveLength(1);
    expect((stateEvents[0].params as any).event.state).toBe('blocked');

    client.destroy();
  });

  it('sentinel.report status emits sentinel event without state change', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'status-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    const notifications: { method: string; params: unknown }[] = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('workspace.attach', { id: 'status-ws' });

    await client.request('sentinel.report', {
      workspaceId: 'status-ws',
      paneId: 'agent-1',
      cmd: 'status',
      payload: { text: 'running tests' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const sentinelEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'sentinel',
    );
    expect(sentinelEvents).toHaveLength(1);
    expect((sentinelEvents[0].params as any).event.cmd).toBe('status');

    const stateEvents = notifications.filter(
      (n) => n.method === 'pane.event' && (n.params as any).event.kind === 'state',
    );
    expect(stateEvents).toHaveLength(0);

    client.destroy();
  });

  it('sentinel.report done persists lastKnownState in workspace state', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'persist-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    await client.request('sentinel.report', {
      workspaceId: 'persist-ws',
      paneId: 'agent-1',
      cmd: 'done',
      payload: { summary: 'all tasks complete' },
    });

    const result = (await client.request('workspace.get', { id: 'persist-ws' })) as {
      workspace: { panes: { paneId: string; lastKnownState: string }[] };
    };

    expect(result.workspace.panes[0].lastKnownState).toBe('done');
    client.destroy();
  });

  it('sentinel.report with unknown paneId returns PANE_DEAD error', async () => {
    const repoDir = makeRepo();
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    await client.request('workspace.create', {
      name: 'err-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    await expect(
      client.request('sentinel.report', {
        workspaceId: 'err-ws',
        paneId: 'nonexistent',
        cmd: 'done',
        payload: {},
      }),
    ).rejects.toThrow(/Pane not found/i);

    client.destroy();
  });
});
