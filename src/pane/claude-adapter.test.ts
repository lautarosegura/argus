import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from './claude-adapter.js';
import type { AdapterEvent, IPty, AdapterContext } from './adapter-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '__fixtures__');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.ndjson`), 'utf-8');
}

function createFakePty(fixture: string): IPty & { written: string[] } {
  const dataCallbacks: ((data: string) => void)[] = [];
  const exitCallbacks: ((e: { exitCode: number }) => void)[] = [];
  const written: string[] = [];

  const pty: IPty & { written: string[] } = {
    pid: 12345,
    written,
    onData(cb) {
      dataCallbacks.push(cb);
    },
    onExit(cb) {
      exitCallbacks.push(cb);
    },
    write(data) {
      written.push(data);
    },
    kill() {},
  };

  // Schedule fixture replay after start
  queueMicrotask(() => {
    const lines = fixture.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      for (const cb of dataCallbacks) {
        cb(line + '\n');
      }
    }
    // Simulate process exit after all data
    queueMicrotask(() => {
      for (const cb of exitCallbacks) {
        cb({ exitCode: 0 });
      }
    });
  });

  return pty;
}

function createErrorExitPty(fixture: string): IPty {
  const dataCallbacks: ((data: string) => void)[] = [];
  const exitCallbacks: ((e: { exitCode: number }) => void)[] = [];

  const pty: IPty = {
    pid: 12345,
    onData(cb) {
      dataCallbacks.push(cb);
    },
    onExit(cb) {
      exitCallbacks.push(cb);
    },
    write() {},
    kill() {},
  };

  queueMicrotask(() => {
    const lines = fixture.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      for (const cb of dataCallbacks) {
        cb(line + '\n');
      }
    }
    queueMicrotask(() => {
      for (const cb of exitCallbacks) {
        cb({ exitCode: 1 });
      }
    });
  });

  return pty;
}

const CTX: AdapterContext = {
  worktreePath: '/tmp/worktree',
  paneId: 'agent-1',
  workspaceId: 'test-workspace',
};

function collectEvents(adapter: ClaudeAdapter): Promise<AdapterEvent[]> {
  return new Promise((resolve) => {
    const events: AdapterEvent[] = [];
    adapter.on('event', (e) => events.push(e));
    adapter.on('exit', () => resolve(events));
  });
}

describe('ClaudeAdapter', () => {
  it('has cliKind "claude"', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.cliKind).toBe('claude');
  });

  describe('fixture replay: idle', () => {
    it('emits state→idle on init, state→done on exit', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('idle');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const stateEvents = result.filter((e) => e.kind === 'state');
      expect(stateEvents.length).toBeGreaterThanOrEqual(2);
      expect(stateEvents[0]).toEqual({ kind: 'state', state: 'idle' });
      expect(stateEvents[stateEvents.length - 1]).toEqual({ kind: 'state', state: 'done' });
    });
  });

  describe('fixture replay: single-message', () => {
    it('emits message and usage events', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('single-message');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const messageEvents = result.filter((e) => e.kind === 'message');
      expect(messageEvents.length).toBe(1);
      expect(messageEvents[0]).toEqual({
        kind: 'message',
        role: 'assistant',
        text: 'Hello! How can I help you today?',
        partial: false,
      });

      const usageEvents = result.filter((e) => e.kind === 'usage');
      expect(usageEvents.length).toBeGreaterThanOrEqual(1);
      const lastUsage = usageEvents[usageEvents.length - 1];
      expect(lastUsage).toMatchObject({
        kind: 'usage',
        tokensIn: 100,
        tokensOut: 15,
        costUsd: 0.003,
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states[0]).toBe('idle');
      expect(states).toContain('thinking');
      expect(states[states.length - 1]).toBe('done');
    });
  });

  describe('fixture replay: tool-use', () => {
    it('emits thinking, toolCall.requested, message, and usage', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('tool-use');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const thinkingEvents = result.filter((e) => e.kind === 'thinking');
      expect(thinkingEvents.length).toBe(1);
      expect(thinkingEvents[0]).toMatchObject({
        kind: 'thinking',
        text: 'I need to read the file to understand the code.',
        partial: false,
      });

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]).toMatchObject({
        kind: 'toolCall.requested',
        id: 'toolu_01',
        tool: 'Read',
        args: { file_path: '/tmp/test.ts' },
      });

      const messageEvents = result.filter((e) => e.kind === 'message');
      expect(messageEvents.length).toBe(1);
      expect(messageEvents[0]).toMatchObject({
        kind: 'message',
        text: 'The file contains a simple variable declaration: `const x = 1;`',
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states).toContain('thinking');
      expect(states).toContain('toolUse');
    });
  });

  describe('fixture replay: permission-blocked', () => {
    it('emits toolCall.requested for the blocked tool', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('permission-blocked');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]).toMatchObject({
        kind: 'toolCall.requested',
        id: 'toolu_01',
        tool: 'Bash',
        args: { command: 'curl https://example.com' },
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states).toContain('toolUse');
      expect(states[states.length - 1]).toBe('done');
    });
  });

  describe('fixture replay: error', () => {
    it('emits an error event and state→dead on non-zero exit', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('error');
      const pty = createErrorExitPty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const errorEvents = result.filter((e) => e.kind === 'error');
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]).toMatchObject({
        kind: 'error',
        source: 'cli',
        message: 'Authentication failed: invalid API key',
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states[states.length - 1]).toBe('dead');
    });
  });

  describe('output events', () => {
    it('emits raw output bytes for every line received', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('single-message');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const outputEvents = result.filter((e) => e.kind === 'output');
      expect(outputEvents.length).toBeGreaterThan(0);
      for (const e of outputEvents) {
        expect(Buffer.isBuffer((e as { bytes: Buffer }).bytes)).toBe(true);
      }
    });
  });

  describe('decideToolCall', () => {
    it('writes allow response to PTY stdin', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('tool-use');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);

      // Wait for events to be processed
      await new Promise((r) => setTimeout(r, 50));
      adapter.decideToolCall('toolu_01', 'allow');
      expect(pty.written.length).toBeGreaterThan(0);
    });
  });

  describe('sendInput', () => {
    it('writes text to PTY stdin', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('idle');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);
      adapter.sendInput('hello world\n');
      expect(pty.written).toContain('hello world\n');
    });
  });

  describe('interrupt', () => {
    it('writes SIGINT character to PTY', async () => {
      const adapter = new ClaudeAdapter();
      const fixture = loadFixture('idle');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);
      adapter.interrupt();
      expect(pty.written).toContain('\x03');
    });
  });
});
