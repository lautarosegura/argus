import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from './codex-adapter.js';
import type { AdapterEvent, IPty, AdapterContext } from './adapter-types.js';
import { decide } from '../sandbox/sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '__fixtures__');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.ndjson`), 'utf-8');
}

function createFakePty(fixture: string, exitCode = 0): IPty & { written: string[] } {
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

  queueMicrotask(() => {
    const lines = fixture.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      for (const cb of dataCallbacks) {
        cb(line + '\n');
      }
    }
    queueMicrotask(() => {
      for (const cb of exitCallbacks) {
        cb({ exitCode });
      }
    });
  });

  return pty;
}

const CTX: AdapterContext = {
  worktreePath: '/tmp/worktree',
  paneId: 'agent-1',
  workspaceId: 'test-workspace',
  paneRole: 'worker',
};

function collectEvents(adapter: CodexAdapter): Promise<AdapterEvent[]> {
  return new Promise((resolve) => {
    const events: AdapterEvent[] = [];
    adapter.on('event', (e) => events.push(e));
    adapter.on('exit', () => resolve(events));
  });
}

describe('CodexAdapter', () => {
  it('has cliKind "codex"', () => {
    const adapter = new CodexAdapter();
    expect(adapter.cliKind).toBe('codex');
  });

  describe('fixture replay: codex-idle', () => {
    it('emits state→idle on init, state→done on exit', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-idle');
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

  describe('fixture replay: codex-single-message', () => {
    it('emits message and usage events', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-single-message');
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
        tokensIn: 80,
        tokensOut: 12,
        costUsd: 0.002,
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states[0]).toBe('idle');
      expect(states).toContain('thinking');
      expect(states[states.length - 1]).toBe('done');
    });
  });

  describe('fixture replay: codex-tool-use', () => {
    it('emits thinking, toolCall.requested, message, and usage', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-tool-use');
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
        id: 'call_01',
        tool: 'read_file',
        args: { path: '/tmp/test.ts' },
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

  describe('fixture replay: codex-permission-blocked', () => {
    it('emits toolCall.requested for the blocked tool', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-permission-blocked');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]).toMatchObject({
        kind: 'toolCall.requested',
        id: 'call_01',
        tool: 'shell',
        args: { command: ['curl', 'https://example.com'] },
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states).toContain('toolUse');
      expect(states[states.length - 1]).toBe('done');
    });
  });

  describe('fixture replay: codex-error', () => {
    it('emits an error event and state→dead on non-zero exit', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-error');
      const pty = createFakePty(fixture, 1);
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
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-single-message');
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
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);

      await new Promise((r) => setTimeout(r, 50));
      adapter.decideToolCall('call_01', 'allow');
      expect(pty.written).toContain(
        JSON.stringify({ type: 'tool_decision', call_id: 'call_01', decision: 'allow' }) + '\n',
      );
    });
  });

  describe('sendInput', () => {
    it('writes text to PTY stdin', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-idle');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);
      adapter.sendInput('hello world\n');
      expect(pty.written).toContain('hello world\n');
    });
  });

  describe('interrupt', () => {
    it('writes SIGINT character to PTY', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-idle');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);
      adapter.interrupt();
      expect(pty.written).toContain('\x03');
    });
  });

  describe('sandbox integration', () => {
    it('auto-allows tool call when sandbox allows', async () => {
      const sandbox = (input: Parameters<typeof decide>[0]) => decide(input);
      const adapter = new CodexAdapter(sandbox);
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      // Use /tmp as worktree so fixture's read_file of /tmp/test.ts is inside worktree
      adapter.start(pty, { ...CTX, worktreePath: '/tmp' });
      const result = await events;

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]).toMatchObject({ tool: 'read_file' });

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(1);
      const decision = JSON.parse(written[0].trim());
      expect(decision.decision).toBe('allow');
      expect(decision.call_id).toBe('call_01');
    });

    it('auto-denies tool call when sandbox denies', async () => {
      const sandbox = (input: Parameters<typeof decide>[0]) => decide(input);
      const adapter = new CodexAdapter(sandbox);
      const fixture = loadFixture('codex-permission-blocked');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]).toMatchObject({ tool: 'shell' });

      const errorEvents = result.filter(
        (e) => e.kind === 'error' && (e as { source: string }).source === 'sandbox',
      );
      expect(errorEvents.length).toBe(1);
      expect((errorEvents[0] as { message: string }).message).toContain('curl');

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(1);
      const decision = JSON.parse(written[0].trim());
      expect(decision.decision).toBe('deny');
    });

    it('emits permissionRequest for ask decisions', async () => {
      const askSandbox = () => ({
        kind: 'ask' as const,
        risk: 'medium' as const,
      });
      const adapter = new CodexAdapter(askSandbox);
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const permEvents = result.filter((e) => e.kind === 'permissionRequest');
      expect(permEvents.length).toBe(1);
      expect(permEvents[0]).toMatchObject({
        kind: 'permissionRequest',
        id: 'call_01',
        risk: 'medium',
      });

      const stateEvents = result.filter((e) => e.kind === 'state');
      const states = stateEvents.map((e) => (e as { state: string }).state);
      expect(states).toContain('waitingPerm');

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(0);
    });

    it('decideTool round-trip: ask → external allow writes to PTY', async () => {
      const askSandbox = () => ({
        kind: 'ask' as const,
        risk: 'low' as const,
      });
      const adapter = new CodexAdapter(askSandbox);
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);

      await new Promise((r) => setTimeout(r, 50));

      expect(pty.written.filter((w) => w.includes('tool_decision')).length).toBe(0);

      adapter.decideToolCall('call_01', 'allow');

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(1);
      const decision = JSON.parse(written[0].trim());
      expect(decision).toEqual({ type: 'tool_decision', call_id: 'call_01', decision: 'allow' });
    });

    it('decideTool round-trip: ask → external deny writes to PTY', async () => {
      const askSandbox = () => ({
        kind: 'ask' as const,
        risk: 'high' as const,
      });
      const adapter = new CodexAdapter(askSandbox);
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      adapter.start(pty, CTX);

      await new Promise((r) => setTimeout(r, 50));

      adapter.decideToolCall('call_01', 'deny', 'User rejected');

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(1);
      const decision = JSON.parse(written[0].trim());
      expect(decision.decision).toBe('deny');
    });

    it('does not auto-decide when sandbox is not provided', async () => {
      const adapter = new CodexAdapter();
      const fixture = loadFixture('codex-tool-use');
      const pty = createFakePty(fixture);
      const events = collectEvents(adapter);
      adapter.start(pty, CTX);
      const result = await events;

      const toolRequested = result.filter((e) => e.kind === 'toolCall.requested');
      expect(toolRequested.length).toBe(1);

      const written = pty.written.filter((w) => w.includes('tool_decision'));
      expect(written.length).toBe(0);
    });
  });
});
