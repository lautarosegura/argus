import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMetricsStore } from './metrics-store.js';
import { formatWorkspaceStats, formatCostBreakdown } from './stats-formatter.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-stats-test-'));
  return path.join(dir, 'metrics.db');
}

describe('stats formatter', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      const dir = path.dirname(p);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it('formatWorkspaceStats produces a readable summary', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const store = createMetricsStore(dbPath);

    store.upsertWorkspaceSummary({
      id: 'demo',
      createdAt: '2026-05-08T10:00:00.000Z',
      panesTotal: 2,
      mergesTotal: 1,
    });

    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-1',
      event: { kind: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.05 },
    });
    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-1',
      event: { kind: 'state', state: 'done' },
    });
    store.finalizePaneSummary('demo', 'pane-1', 'claude');

    const stats = store.getWorkspaceStats('demo');
    store.close();

    const output = formatWorkspaceStats(stats!);
    expect(output).toContain('demo');
    expect(output).toContain('Panes: 2');
    expect(output).toContain('Merges: 1');
    expect(output).toContain('1,000');
    expect(output).toContain('200');
  });

  it('formatCostBreakdown shows per-CLI token and cost totals', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const store = createMetricsStore(dbPath);

    store.upsertWorkspaceSummary({
      id: 'demo',
      createdAt: '2026-05-08T10:00:00.000Z',
      panesTotal: 2,
      mergesTotal: 0,
    });

    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-1',
      event: { kind: 'usage', tokensIn: 1000, tokensOut: 200, costUsd: 0.05 },
    });
    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-1',
      event: { kind: 'state', state: 'done' },
    });
    store.finalizePaneSummary('demo', 'pane-1', 'claude');

    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-2',
      event: { kind: 'usage', tokensIn: 800, tokensOut: 150 },
    });
    store.insertPaneEvent({
      workspaceId: 'demo',
      paneId: 'pane-2',
      event: { kind: 'state', state: 'done' },
    });
    store.finalizePaneSummary('demo', 'pane-2', 'codex');

    const breakdown = store.getCostBreakdown('demo');
    store.close();

    const output = formatCostBreakdown(breakdown);
    expect(output).toContain('claude');
    expect(output).toContain('$0.05');
    expect(output).toContain('codex');
    expect(output).toContain('N/A');
  });

  it('formatWorkspaceStats returns not-found message for undefined stats', () => {
    const output = formatWorkspaceStats(undefined);
    expect(output).toContain('not found');
  });

  it('formatCostBreakdown handles empty breakdown', () => {
    const output = formatCostBreakdown([]);
    expect(output).toContain('No cost data');
  });
});
