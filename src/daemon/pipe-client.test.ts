import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PROTOCOL_VERSION, DAEMON_VERSION } from '../shared/protocol.js';
import { createDaemon, type Daemon } from './daemon.js';
import { createPipeClient, type PipeClient } from './pipe-client.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'));
  return path.join(dir, 'argus.sock');
}

let daemon: Daemon | null = null;
let client: PipeClient | null = null;

afterEach(async () => {
  if (client) {
    client.destroy();
    client = null;
  }
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
});

describe('pipe-client', () => {
  it('connects to daemon and sends daemon.status request', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    client = createPipeClient(pipePath);
    await client.connect();

    const result = await client.request('daemon.status', {});
    expect(result).toMatchObject({
      version: DAEMON_VERSION,
      workspaceCount: 0,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(typeof (result as Record<string, unknown>).uptime).toBe('number');
  });

  it('sends multiple sequential requests on same connection', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    client = createPipeClient(pipePath);
    await client.connect();

    const r1 = await client.request('daemon.status', {});
    const r2 = await client.request('daemon.status', {});
    expect((r1 as Record<string, unknown>).version).toBe(DAEMON_VERSION);
    expect((r2 as Record<string, unknown>).version).toBe(DAEMON_VERSION);
  });

  it('receives error for unknown method', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    client = createPipeClient(pipePath);
    await client.connect();

    await expect(client.request('nonexistent.method', {})).rejects.toThrow('Method not found');
  });

  it('rejects connect when no daemon is listening', async () => {
    const pipePath = tmpPipePath();
    client = createPipeClient(pipePath);
    await expect(client.connect()).rejects.toThrow();
  });

  it('receives notifications from daemon', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    client = createPipeClient(pipePath);
    await client.connect();

    const notifications: unknown[] = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('daemon.shutdown', { graceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(notifications).toContainEqual({
      method: 'daemon.shuttingDown',
      params: { graceMs: 50 },
    });
  });
});
