import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPane } from './pane.js';
import type { AdapterEvent, IPty, AdapterContext } from './adapter-types.js';
import { MAX_PARSE_BUFFER_BYTES } from './adapter-types.js';
import { decide } from '../sandbox/sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '__fixtures__');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.ndjson`), 'utf-8');
}

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

function replayFixture(pty: FakePty, fixtureName: string): void {
  const content = loadFixture(fixtureName);
  const lines = content.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    pty.feedData(line + '\n');
  }
}

const CTX: AdapterContext = {
  worktreePath: '/tmp/worktree',
  paneId: 'agent-1',
  workspaceId: 'test-workspace',
  paneRole: 'worker',
};

describe('Pane', () => {
  it('exposes paneId and workspaceId', () => {
    const pty = createFakePty();
    const pane = createPane({
      pty,
      cliKind: 'claude',
      ctx: CTX,
    });
    expect(pane.paneId).toBe('agent-1');
    expect(pane.workspaceId).toBe('test-workspace');
  });

  it('starts in idle state', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
    expect(pane.state).toBe('idle');
  });

  it('tracks state transitions from adapter events', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });

    replayFixture(pty, 'single-message');
    expect(pane.state).toBe('thinking');

    pty.feedExit(0);
    expect(pane.state).toBe('done');
  });

  it('emits pane.event notifications with paneId and workspaceId', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });

    const notifications: Array<{ workspaceId: string; paneId: string; event: AdapterEvent }> = [];
    pane.onEvent((n) => notifications.push(n));

    replayFixture(pty, 'single-message');
    pty.feedExit(0);

    expect(notifications.length).toBeGreaterThan(0);
    for (const n of notifications) {
      expect(n.workspaceId).toBe('test-workspace');
      expect(n.paneId).toBe('agent-1');
    }

    const stateNotifs = notifications.filter((n) => n.event.kind === 'state');
    const states = stateNotifs.map((n) => (n.event as { state: string }).state);
    expect(states).toContain('thinking');
    expect(states[states.length - 1]).toBe('done');
  });

  it('forwards sendInput to adapter', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
    pane.send('hello\n');
    expect(pty.written).toContain('hello\n');
  });

  it('forwards interrupt to adapter', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
    pane.interrupt();
    expect(pty.written).toContain('\x03');
  });

  it('sets state to dead on non-zero exit', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
    replayFixture(pty, 'error');
    pty.feedExit(1);
    expect(pane.state).toBe('dead');
  });

  it('16 MB buffer guard kills the pane', () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });

    const events: AdapterEvent[] = [];
    pane.onEvent((n) => events.push(n.event));

    const bigChunk = 'x'.repeat(MAX_PARSE_BUFFER_BYTES + 1);
    pty.feedData(bigChunk);

    expect(pty.killed).toBe(true);

    const errorEvents = events.filter((e) => e.kind === 'error');
    expect(errorEvents.length).toBe(1);
    expect((errorEvents[0] as { source: string }).source).toBe('parser');

    expect(pane.state).toBe('dead');
  });

  it('dispose cleans up resources', async () => {
    const pty = createFakePty();
    const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
    await pane.dispose();
    expect(pane.disposed).toBe(true);
  });

  describe('sandbox integration via createPane', () => {
    it('sandbox-denied tool calls emit error event', () => {
      const pty = createFakePty();
      const pane = createPane({
        pty,
        cliKind: 'claude',
        ctx: CTX,
        sandbox: (input) => decide(input),
      });

      const events: AdapterEvent[] = [];
      pane.onEvent((n) => events.push(n.event));

      // Feed a tool call for curl (denied by sandbox)
      pty.feedData(
        '{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"curl https://evil.com"}}],"model":"claude-sonnet-4-20250514","stop_reason":"tool_use","usage":{"input_tokens":100,"output_tokens":20}}}\n',
      );

      const sandboxErrors = events.filter(
        (e) => e.kind === 'error' && (e as { source: string }).source === 'sandbox',
      );
      expect(sandboxErrors.length).toBe(1);
      expect((sandboxErrors[0] as { message: string }).message).toContain('curl');

      // Tool decision written as deny
      expect(pty.written.some((w) => w.includes('"deny"'))).toBe(true);
    });

    it('sandbox-allowed tool calls are auto-approved', () => {
      const pty = createFakePty();
      const pane = createPane({
        pty,
        cliKind: 'claude',
        ctx: CTX,
        sandbox: (input) => decide(input),
      });

      const events: AdapterEvent[] = [];
      pane.onEvent((n) => events.push(n.event));

      // Feed a tool call for Read inside worktree (allowed)
      pty.feedData(
        '{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/tmp/worktree/src/main.ts"}}],"model":"claude-sonnet-4-20250514","stop_reason":"tool_use","usage":{"input_tokens":100,"output_tokens":20}}}\n',
      );

      const toolRequested = events.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);

      const sandboxErrors = events.filter(
        (e) => e.kind === 'error' && (e as { source: string }).source === 'sandbox',
      );
      expect(sandboxErrors.length).toBe(0);

      // Tool decision written as allow
      expect(pty.written.some((w) => w.includes('"allow"'))).toBe(true);
    });
  });

  describe('static dispatch', () => {
    it('creates ClaudeAdapter for cliKind "claude"', () => {
      const pty = createFakePty();
      const pane = createPane({ pty, cliKind: 'claude', ctx: CTX });
      expect(pane.cliKind).toBe('claude');
    });

    it('throws for unknown cliKind', () => {
      const pty = createFakePty();
      expect(() =>
        createPane({ pty, cliKind: 'unknown' as 'claude', ctx: CTX }),
      ).toThrow();
    });
  });
});
