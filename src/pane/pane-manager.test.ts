import { describe, it, expect, vi } from 'vitest';
import { createPaneManager } from './pane-manager.js';
import type { IPty, AdapterContext } from './adapter-types.js';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { EventEmitter } from 'node:events';

interface FakePty extends IPty {
  written: string[];
  killed: boolean;
  feedData(data: string): void;
  feedExit(exitCode: number): void;
}

function createFakePty(): FakePty {
  const dataCallbacks: ((data: string) => void)[] = [];
  const exitCallbacks: ((e: { exitCode: number }) => void)[] = [];

  return {
    pid: 99999,
    written: [],
    killed: false,
    onData(cb) {
      dataCallbacks.push(cb);
    },
    onExit(cb) {
      exitCallbacks.push(cb);
    },
    write(data) {
      this.written.push(data);
    },
    kill() {
      this.killed = true;
    },
    feedData(data: string) {
      for (const cb of dataCallbacks) cb(data);
    },
    feedExit(exitCode: number) {
      for (const cb of exitCallbacks) cb({ exitCode });
    },
  };
}

interface FakeSocket extends net.Socket {
  chunks: string[];
}

function createFakeSocket(): FakeSocket {
  const emitter = new EventEmitter();
  const socket = emitter as unknown as FakeSocket;
  socket.chunks = [];
  socket.write = ((data: string) => {
    socket.chunks.push(data);
    return true;
  }) as FakeSocket['write'];
  socket.destroy = (() => {
    socket.emit('close');
    return socket;
  }) as FakeSocket['destroy'];
  return socket;
}

const CTX: AdapterContext = {
  worktreePath: '/tmp/worktree',
  paneId: 'agent-1',
  workspaceId: 'ws-1',
};

describe('PaneManager', () => {
  it('creates and retrieves a pane', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    const pane = mgr.createPane(pty, 'claude', CTX);
    expect(pane.paneId).toBe('agent-1');
    expect(mgr.getPane('agent-1')).toBe(pane);
  });

  it('lists panes by workspace', () => {
    const mgr = createPaneManager();
    const pty1 = createFakePty();
    const pty2 = createFakePty();
    mgr.createPane(pty1, 'claude', { ...CTX, paneId: 'agent-1' });
    mgr.createPane(pty2, 'claude', { ...CTX, paneId: 'agent-2' });
    expect(mgr.listPanes('ws-1').length).toBe(2);
    expect(mgr.listPanes('ws-other').length).toBe(0);
  });

  it('removes a pane', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    mgr.createPane(pty, 'claude', CTX);
    mgr.removePane('agent-1');
    expect(mgr.getPane('agent-1')).toBeUndefined();
  });

  it('sends pane.event notifications to attached subscribers', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    const socket = createFakeSocket();

    mgr.attach('ws-1', socket);
    mgr.createPane(pty, 'claude', CTX);

    // Feed some data to trigger events
    pty.feedData('{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}],"model":"claude-sonnet-4-20250514","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}}\n');

    expect(socket.chunks.length).toBeGreaterThan(0);

    const notifications = socket.chunks.map((c) => JSON.parse(c));
    const paneEvents = notifications.filter(
      (n: { method: string }) => n.method === 'pane.event',
    );
    expect(paneEvents.length).toBeGreaterThan(0);
    expect(paneEvents[0].params.workspaceId).toBe('ws-1');
    expect(paneEvents[0].params.paneId).toBe('agent-1');
  });

  it('does not send notifications after detach', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    const socket = createFakeSocket();

    mgr.attach('ws-1', socket);
    mgr.createPane(pty, 'claude', CTX);

    // Clear initial events
    socket.chunks.length = 0;

    mgr.detach('ws-1', socket);

    pty.feedData('{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"After detach"}],"model":"claude-sonnet-4-20250514","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}}\n');

    expect(socket.chunks.length).toBe(0);
  });

  it('encodes output bytes as base64 in notifications', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    const socket = createFakeSocket();

    mgr.attach('ws-1', socket);
    mgr.createPane(pty, 'claude', CTX);

    pty.feedData('raw bytes here\n');

    const notifications = socket.chunks.map((c) => JSON.parse(c));
    const outputNotifs = notifications.filter(
      (n: { method: string; params: { event: { kind: string } } }) =>
        n.method === 'pane.event' && n.params.event.kind === 'output',
    );

    expect(outputNotifs.length).toBeGreaterThan(0);
    for (const n of outputNotifs) {
      expect(typeof n.params.event.bytes).toBe('string');
      const decoded = Buffer.from(n.params.event.bytes, 'base64').toString();
      expect(decoded.length).toBeGreaterThan(0);
    }
  });

  it('auto-detaches on socket close', () => {
    const mgr = createPaneManager();
    const pty = createFakePty();
    const socket = createFakeSocket();

    mgr.attach('ws-1', socket);
    mgr.createPane(pty, 'claude', CTX);

    socket.chunks.length = 0;
    socket.emit('close');

    pty.feedData('{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"After close"}],"model":"claude-sonnet-4-20250514","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}}\n');

    expect(socket.chunks.length).toBe(0);
  });
});
