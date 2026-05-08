import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  encodeMessage,
  makeRequest,
  LineBuffer,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcMessage,
} from '../shared/json-rpc.js';
import { PROTOCOL_VERSION, DAEMON_VERSION, RpcErrorCode } from '../shared/protocol.js';
import { createDaemon, type Daemon } from './daemon.js';
import { createPipeClient } from './pipe-client.js';

function tmpPipePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'));
  return path.join(dir, 'argus.sock');
}

function sendRaw(pipePath: string, data: string): Promise<JsonRpcMessage[]> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(pipePath, () => {
      client.write(data);
    });
    const buf = new LineBuffer();
    const messages: JsonRpcMessage[] = [];
    client.on('data', (chunk) => {
      for (const msg of buf.append(chunk.toString())) {
        messages.push(msg);
        client.end();
      }
    });
    client.on('end', () => resolve(messages));
    client.on('error', reject);
  });
}

let daemon: Daemon | null = null;

afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
});

describe('pipe-server round-trip', () => {
  it('daemon.status returns version, uptime, workspaceCount, protocolVersion', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();
    const result = (await client.request('daemon.status', {})) as Record<string, unknown>;
    client.destroy();

    expect(result.version).toBe(DAEMON_VERSION);
    expect(typeof result.uptime).toBe('number');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(result.workspaceCount).toBe(0);
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('daemon.shutdown triggers clean exit and emits daemon.shuttingDown notification', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();

    const notifications: { method: string; params: unknown }[] = [];
    client.onNotification((method, params) => {
      notifications.push({ method, params });
    });

    await client.request('daemon.shutdown', { graceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.destroy();

    const shutdownNotif = notifications.find((n) => n.method === 'daemon.shuttingDown');
    expect(shutdownNotif).toBeDefined();
    expect(shutdownNotif!.params).toEqual({ graceMs: 50 });
  });

  it('two daemons on same pipe: first wins, second gets bind error', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const second = createDaemon({ pipePath, idleShutdownMs: 0 });
    await expect(second.start()).rejects.toThrow();
  });

  it('protocolVersion mismatch returns -32004 error', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const msgs = await sendRaw(
      pipePath,
      encodeMessage(makeRequest(1, 'daemon.status', { protocolVersion: 999 })),
    );
    expect(msgs).toHaveLength(1);
    const resp = msgs[0] as JsonRpcResponse;
    expect('error' in resp).toBe(true);
    if ('error' in resp) {
      expect(resp.error.code).toBe(RpcErrorCode.PROTOCOL_VERSION_MISMATCH);
    }
  });

  it('unknown method returns METHOD_NOT_FOUND error', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const client = createPipeClient(pipePath);
    await client.connect();
    await expect(client.request('nonexistent.method', {})).rejects.toThrow('Method not found');
    client.destroy();
  });

  it('idle shutdown timer fires after configured timeout', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 200 });
    await daemon.start();

    const stopped = new Promise<void>((resolve) => {
      daemon!.on('stopped', resolve);
    });

    await stopped;
  });

  it('malformed JSON is silently ignored, connection stays alive', async () => {
    const pipePath = tmpPipePath();
    daemon = createDaemon({ pipePath, idleShutdownMs: 0 });
    await daemon.start();

    const msgs = await new Promise<JsonRpcMessage[]>((resolve, reject) => {
      const client = net.createConnection(pipePath, () => {
        client.write('this is not json\n');
        client.write(encodeMessage(makeRequest(1, 'daemon.status', {})));
      });
      const buf = new LineBuffer();
      const messages: JsonRpcMessage[] = [];
      client.on('data', (chunk) => {
        for (const msg of buf.append(chunk.toString())) {
          messages.push(msg);
          client.end();
        }
      });
      client.on('end', () => resolve(messages));
      client.on('error', reject);
    });

    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const resp = msgs.find((m) => 'id' in m && m.id === 1) as JsonRpcResponse;
    expect(resp).toBeDefined();
    expect('result' in resp).toBe(true);
  });
});
