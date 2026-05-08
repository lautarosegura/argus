import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMetricsStore, type MetricsStore } from './metrics-store.js';
import type { AdapterEvent } from '../pane/adapter-types.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-metrics-test-'));
  return path.join(dir, 'metrics.db');
}

describe('metrics-store', () => {
  const cleanupPaths: string[] = [];
  let store: MetricsStore;

  afterEach(() => {
    if (store) store.close();
    for (const p of cleanupPaths) {
      const dir = path.dirname(p);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it('creates database with expected tables on first open', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);

    store = createMetricsStore(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);

    const tables = store.listTables();
    expect(tables).toContain('pane_events');
    expect(tables).toContain('pane_summary');
    expect(tables).toContain('merge_runs');
    expect(tables).toContain('workspace_summary');
  });

  it('inserts pane events for relevant AdapterEvent kinds', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    const events: AdapterEvent[] = [
      { kind: 'state', state: 'thinking', reason: 'start' },
      { kind: 'toolCall.requested', id: 'tc-1', tool: 'Read', args: { path: '/foo' } },
      { kind: 'toolCall.completed', id: 'tc-1', result: 'ok', durationMs: 150 },
      { kind: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.05 },
      { kind: 'error', source: 'parser', message: 'bad json' },
      { kind: 'sentinel', cmd: 'done', payload: null },
    ];

    for (const event of events) {
      store.insertPaneEvent({
        workspaceId: 'ws-1',
        paneId: 'pane-1',
        event,
      });
    }

    const rows = store.getPaneEvents('ws-1', 'pane-1');
    expect(rows).toHaveLength(6);
    expect(rows[0].event_kind).toBe('state');
    expect(rows[3].event_kind).toBe('usage');
    expect(JSON.parse(rows[3].payload_json).tokensIn).toBe(1000);
  });

  it('ignores output and message events (not persisted)', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    const ignoredEvents: AdapterEvent[] = [
      { kind: 'output', bytes: Buffer.from('hello') },
      { kind: 'message', role: 'assistant', text: 'hi', partial: false },
      { kind: 'thinking', text: 'hmm', partial: false },
    ];

    for (const event of ignoredEvents) {
      store.insertPaneEvent({
        workspaceId: 'ws-1',
        paneId: 'pane-1',
        event,
      });
    }

    const rows = store.getPaneEvents('ws-1', 'pane-1');
    expect(rows).toHaveLength(0);
  });

  it('computes pane summary from pane events', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    const events: { event: AdapterEvent; ts?: string }[] = [
      { event: { kind: 'state', state: 'thinking' }, ts: '2026-05-08T10:00:00.000Z' },
      { event: { kind: 'state', state: 'toolUse' }, ts: '2026-05-08T10:00:05.000Z' },
      { event: { kind: 'toolCall.requested', id: 'tc-1', tool: 'Read', args: {} }, ts: '2026-05-08T10:00:05.100Z' },
      { event: { kind: 'toolCall.completed', id: 'tc-1', result: 'ok', durationMs: 200 }, ts: '2026-05-08T10:00:05.300Z' },
      { event: { kind: 'toolCall.requested', id: 'tc-2', tool: 'Edit', args: {} }, ts: '2026-05-08T10:00:06.000Z' },
      { event: { kind: 'toolCall.completed', id: 'tc-2', result: 'ok', durationMs: 100 }, ts: '2026-05-08T10:00:06.100Z' },
      { event: { kind: 'usage', tokensIn: 500, tokensOut: 100, costUsd: 0.02 }, ts: '2026-05-08T10:00:07.000Z' },
      { event: { kind: 'usage', tokensIn: 300, tokensOut: 80, costUsd: 0.01 }, ts: '2026-05-08T10:00:08.000Z' },
      { event: { kind: 'state', state: 'done' }, ts: '2026-05-08T10:00:10.000Z' },
    ];

    for (const { event, ts } of events) {
      store.insertPaneEvent({
        workspaceId: 'ws-1',
        paneId: 'pane-1',
        event,
        ts,
      });
    }

    store.finalizePaneSummary('ws-1', 'pane-1', 'claude');

    const summary = store.getPaneSummary('ws-1', 'pane-1');
    expect(summary).toBeDefined();
    expect(summary!.tokens_in).toBe(800);
    expect(summary!.tokens_out).toBe(180);
    expect(summary!.cost_usd).toBeCloseTo(0.03);
    expect(summary!.tool_calls_total).toBe(2);
    expect(summary!.tool_calls_blocked).toBe(0);
    expect(summary!.terminal_state).toBe('done');
  });

  it('upserts workspace summary', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    store.upsertWorkspaceSummary({
      id: 'ws-1',
      createdAt: '2026-05-08T10:00:00.000Z',
      panesTotal: 3,
      mergesTotal: 0,
    });

    let ws = store.getWorkspaceSummary('ws-1');
    expect(ws).toBeDefined();
    expect(ws!.panes_total).toBe(3);
    expect(ws!.closed_at).toBeNull();

    store.upsertWorkspaceSummary({
      id: 'ws-1',
      closedAt: '2026-05-08T12:00:00.000Z',
      mergesTotal: 2,
    });

    ws = store.getWorkspaceSummary('ws-1');
    expect(ws!.panes_total).toBe(3);
    expect(ws!.merges_total).toBe(2);
    expect(ws!.closed_at).toBe('2026-05-08T12:00:00.000Z');
  });

  it('getWorkspaceStats returns aggregate statistics', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    store.upsertWorkspaceSummary({
      id: 'ws-1',
      createdAt: '2026-05-08T10:00:00.000Z',
      panesTotal: 2,
      mergesTotal: 1,
    });

    for (const paneId of ['pane-1', 'pane-2']) {
      store.insertPaneEvent({
        workspaceId: 'ws-1',
        paneId,
        event: { kind: 'usage', tokensIn: 500, tokensOut: 100, costUsd: 0.02 },
      });
      store.insertPaneEvent({
        workspaceId: 'ws-1',
        paneId,
        event: { kind: 'state', state: 'done' },
      });
      store.finalizePaneSummary('ws-1', paneId, 'claude');
    }

    const stats = store.getWorkspaceStats('ws-1');
    expect(stats).toBeDefined();
    expect(stats!.workspace.panes_total).toBe(2);
    expect(stats!.paneSummaries).toHaveLength(2);
    expect(stats!.totalTokensIn).toBe(1000);
    expect(stats!.totalTokensOut).toBe(200);
    expect(stats!.totalCostUsd).toBeCloseTo(0.04);
  });

  it('getWorkspaceStats with --cost detail returns per-CLI breakdown', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    store = createMetricsStore(dbPath);

    store.upsertWorkspaceSummary({
      id: 'ws-1',
      createdAt: '2026-05-08T10:00:00.000Z',
      panesTotal: 2,
      mergesTotal: 0,
    });

    store.insertPaneEvent({
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      event: { kind: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.05 },
    });
    store.insertPaneEvent({
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      event: { kind: 'state', state: 'done' },
    });
    store.finalizePaneSummary('ws-1', 'pane-1', 'claude');

    store.insertPaneEvent({
      workspaceId: 'ws-1',
      paneId: 'pane-2',
      event: { kind: 'usage', tokensIn: 800, tokensOut: 150 },
    });
    store.insertPaneEvent({
      workspaceId: 'ws-1',
      paneId: 'pane-2',
      event: { kind: 'state', state: 'done' },
    });
    store.finalizePaneSummary('ws-1', 'pane-2', 'codex');

    const costBreakdown = store.getCostBreakdown('ws-1');
    expect(costBreakdown).toHaveLength(2);

    const claude = costBreakdown.find((c) => c.cli === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.tokens_in).toBe(1000);
    expect(claude!.cost_usd).toBeCloseTo(0.05);

    const codex = costBreakdown.find((c) => c.cli === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.tokens_in).toBe(800);
    expect(codex!.cost_usd).toBeNull();
  });

  it('handles reopening an existing database', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);

    store = createMetricsStore(dbPath);
    store.insertPaneEvent({
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      event: { kind: 'state', state: 'thinking' },
    });
    store.close();

    store = createMetricsStore(dbPath);
    const rows = store.getPaneEvents('ws-1', 'pane-1');
    expect(rows).toHaveLength(1);
  });
});
