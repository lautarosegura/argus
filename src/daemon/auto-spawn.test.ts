import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createDaemon, type Daemon } from './daemon.js';
import { createPipeClient } from './pipe-client.js';
import { DAEMON_VERSION, PROTOCOL_VERSION } from '../shared/protocol.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'));
  return path.join(dir, 'argus.sock');
}

let daemon: Daemon | null = null;

afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
});

describe('auto-spawn integration', () => {
  it('daemon starts, client connects, daemon-status round-trip works end-to-end', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const result = (await client.request('daemon.status', {})) as Record<string, unknown>;
    expect(result.version).toBe(DAEMON_VERSION);
    expect(result.workspaceCount).toBe(0);
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof result.uptime).toBe('number');

    client.destroy();
  });

  it('client connects, requests shutdown, daemon stops', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const stopped = new Promise<void>((resolve) => {
      daemon!.on('stopped', resolve);
    });

    const client = createPipeClient(pipePath);
    await client.connect();
    await client.request('daemon.shutdown', { graceMs: 0 });
    client.destroy();

    await stopped;
    daemon = null;
  });
});
