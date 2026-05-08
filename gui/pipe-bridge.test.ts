import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createDaemon, type Daemon } from '../src/daemon/daemon.js';
import { createPipeBridge, type PipeBridge } from './pipe-bridge.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bridge-test-'));
  return path.join(dir, 'argus.sock');
}

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bridge-state-'));
}

let daemon: Daemon | null = null;
let bridge: PipeBridge | null = null;

afterEach(async () => {
  if (bridge) {
    bridge.disconnect();
    bridge = null;
  }
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
});

describe('pipe-bridge', () => {
  it('connects and reports daemon status', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    bridge = createPipeBridge(pipePath);
    await bridge.connect();

    expect(bridge.isConnected()).toBe(true);
    const status = await bridge.status();
    expect(status.version).toBe('0.1.0');
    expect(status.protocolVersion).toBe(1);
  });

  it('lists workspaces (empty)', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir: tmpStateDir() });
    await daemon.start();

    bridge = createPipeBridge(pipePath);
    await bridge.connect();

    const result = await bridge.listWorkspaces();
    expect(result.workspaces).toEqual([]);
  });

  it('creates a workspace and retrieves it', async () => {
    const pipePath = tmpPipePath();
    const stateDir = tmpStateDir();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bridge-repo-'));

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: repoDir,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
    });

    daemon = createDaemon({ pipePath, idleShutdownMs: 0, stateDir });
    await daemon.start();

    bridge = createPipeBridge(pipePath);
    await bridge.connect();

    const { workspaceId } = await bridge.createWorkspace({
      name: 'test-ws',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: repoDir,
    });

    expect(workspaceId).toBe('test-ws');

    const { workspace } = await bridge.getWorkspace('test-ws');
    expect(workspace.name).toBe('test-ws');
    expect(workspace.agentRatio).toEqual([{ cli: 'claude', count: 1 }]);
  });

  it('forwards notifications after attach', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    bridge = createPipeBridge(pipePath);
    await bridge.connect();

    const notifications: { method: string; params: unknown }[] = [];
    bridge.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await bridge.request('daemon.shutdown', { graceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(notifications).toContainEqual({
      method: 'daemon.shuttingDown',
      params: { graceMs: 50 },
    });
  });

  it('disconnect cleans up connection', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    bridge = createPipeBridge(pipePath);
    await bridge.connect();
    expect(bridge.isConnected()).toBe(true);

    bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
  });
});
