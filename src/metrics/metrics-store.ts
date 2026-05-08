import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { AdapterEvent } from '../pane/adapter-types.js';

const PERSISTED_EVENT_KINDS = new Set([
  'state',
  'toolCall.requested',
  'toolCall.completed',
  'permissionRequest',
  'sentinel',
  'usage',
  'error',
]);

export interface PaneEventRow {
  id: number;
  ts: string;
  workspace_id: string;
  pane_id: string;
  event_kind: string;
  duration_ms: number | null;
  payload_json: string;
}

export interface PaneSummaryRow {
  workspace_id: string;
  pane_id: string;
  cli: string;
  started_at: string | null;
  ended_at: string | null;
  total_thinking_ms: number;
  total_tool_use_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  tool_calls_total: number;
  tool_calls_blocked: number;
  terminal_state: string | null;
}

export interface WorkspaceSummaryRow {
  id: string;
  created_at: string | null;
  closed_at: string | null;
  panes_total: number;
  merges_total: number;
}

export interface CostBreakdownRow {
  cli: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  pane_count: number;
}

export interface WorkspaceStats {
  workspace: WorkspaceSummaryRow;
  paneSummaries: PaneSummaryRow[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

export interface InsertPaneEventParams {
  workspaceId: string;
  paneId: string;
  event: AdapterEvent;
  ts?: string;
}

export interface UpsertWorkspaceSummaryParams {
  id: string;
  createdAt?: string;
  closedAt?: string;
  panesTotal?: number;
  mergesTotal?: number;
}

export interface MetricsStore {
  insertPaneEvent(params: InsertPaneEventParams): void;
  getPaneEvents(workspaceId: string, paneId: string): PaneEventRow[];
  finalizePaneSummary(workspaceId: string, paneId: string, cli: string): void;
  getPaneSummary(workspaceId: string, paneId: string): PaneSummaryRow | undefined;
  upsertWorkspaceSummary(params: UpsertWorkspaceSummaryParams): void;
  getWorkspaceSummary(workspaceId: string): WorkspaceSummaryRow | undefined;
  getWorkspaceStats(workspaceId: string): WorkspaceStats | undefined;
  getCostBreakdown(workspaceId: string): CostBreakdownRow[];
  listTables(): string[];
  close(): void;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pane_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    duration_ms INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS pane_summary (
    workspace_id TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    cli TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    total_thinking_ms INTEGER NOT NULL DEFAULT 0,
    total_tool_use_ms INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    tool_calls_total INTEGER NOT NULL DEFAULT 0,
    tool_calls_blocked INTEGER NOT NULL DEFAULT 0,
    terminal_state TEXT,
    PRIMARY KEY (workspace_id, pane_id)
  );

  CREATE TABLE IF NOT EXISTS merge_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    conflicts_auto INTEGER NOT NULL DEFAULT 0,
    conflicts_human INTEGER NOT NULL DEFAULT 0,
    tests_passed INTEGER,
    reverted INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS workspace_summary (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    closed_at TEXT,
    panes_total INTEGER NOT NULL DEFAULT 0,
    merges_total INTEGER NOT NULL DEFAULT 0
  );
`;

export function getDefaultMetricsDbPath(): string {
  if (process.env.ARGUS_METRICS_DB) {
    return process.env.ARGUS_METRICS_DB;
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Argus', 'metrics.db');
  }
  return path.join(os.homedir(), '.local', 'share', 'argus', 'metrics.db');
}

export function createMetricsStore(dbPath: string): MetricsStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const insertEventStmt = db.prepare(`
    INSERT INTO pane_events (ts, workspace_id, pane_id, event_kind, duration_ms, payload_json)
    VALUES (@ts, @workspace_id, @pane_id, @event_kind, @duration_ms, @payload_json)
  `);

  const getEventsStmt = db.prepare(`
    SELECT * FROM pane_events WHERE workspace_id = ? AND pane_id = ? ORDER BY id
  `);

  const getPaneSummaryStmt = db.prepare(`
    SELECT * FROM pane_summary WHERE workspace_id = ? AND pane_id = ?
  `);

  const getWorkspaceSummaryStmt = db.prepare(`
    SELECT * FROM workspace_summary WHERE id = ?
  `);

  const getPaneSummariesForWorkspaceStmt = db.prepare(`
    SELECT * FROM pane_summary WHERE workspace_id = ?
  `);

  const getCostBreakdownStmt = db.prepare(`
    SELECT
      cli,
      SUM(tokens_in) as tokens_in,
      SUM(tokens_out) as tokens_out,
      CASE WHEN SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) > 0
        THEN SUM(cost_usd) ELSE NULL END as cost_usd,
      COUNT(*) as pane_count
    FROM pane_summary
    WHERE workspace_id = ?
    GROUP BY cli
  `);

  function eventToPayload(event: AdapterEvent): { kind: string; durationMs: number | null; payload: Record<string, unknown> } {
    const { kind, ...rest } = event as Record<string, unknown> & { kind: string };
    const durationMs = typeof rest.durationMs === 'number' ? rest.durationMs : null;
    const payload = { ...rest };
    delete payload.durationMs;
    if ('bytes' in payload && Buffer.isBuffer(payload.bytes)) {
      delete payload.bytes;
    }
    return { kind, durationMs, payload };
  }

  return {
    insertPaneEvent({ workspaceId, paneId, event, ts }: InsertPaneEventParams): void {
      if (!PERSISTED_EVENT_KINDS.has(event.kind)) return;

      const { kind, durationMs, payload } = eventToPayload(event);
      insertEventStmt.run({
        ts: ts ?? new Date().toISOString(),
        workspace_id: workspaceId,
        pane_id: paneId,
        event_kind: kind,
        duration_ms: durationMs,
        payload_json: JSON.stringify(payload),
      });
    },

    getPaneEvents(workspaceId: string, paneId: string): PaneEventRow[] {
      return getEventsStmt.all(workspaceId, paneId) as PaneEventRow[];
    },

    finalizePaneSummary(workspaceId: string, paneId: string, cli: string): void {
      const events = this.getPaneEvents(workspaceId, paneId);
      if (events.length === 0) return;

      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let hasUsage = false;
      let hasCost = false;
      let toolCallsTotal = 0;
      let toolCallsBlocked = 0;
      let totalToolUseMs = 0;
      let terminalState: string | null = null;
      let startedAt: string | null = null;
      let endedAt: string | null = null;

      for (const row of events) {
        if (!startedAt) startedAt = row.ts;
        endedAt = row.ts;

        if (row.event_kind === 'usage') {
          const payload = JSON.parse(row.payload_json);
          if (payload.tokensIn != null) {
            tokensIn += payload.tokensIn;
            hasUsage = true;
          }
          if (payload.tokensOut != null) {
            tokensOut += payload.tokensOut;
            hasUsage = true;
          }
          if (payload.costUsd != null) {
            costUsd += payload.costUsd;
            hasCost = true;
          }
        } else if (row.event_kind === 'toolCall.requested') {
          toolCallsTotal++;
        } else if (row.event_kind === 'toolCall.completed') {
          if (row.duration_ms != null) {
            totalToolUseMs += row.duration_ms;
          }
        } else if (row.event_kind === 'state') {
          const payload = JSON.parse(row.payload_json);
          if (payload.state === 'done' || payload.state === 'dead') {
            terminalState = payload.state;
          }
        }
      }

      db.prepare(`
        INSERT OR REPLACE INTO pane_summary
          (workspace_id, pane_id, cli, started_at, ended_at, total_thinking_ms, total_tool_use_ms,
           tokens_in, tokens_out, cost_usd, tool_calls_total, tool_calls_blocked, terminal_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspaceId,
        paneId,
        cli,
        startedAt,
        endedAt,
        0,
        totalToolUseMs,
        hasUsage ? tokensIn : null,
        hasUsage ? tokensOut : null,
        hasCost ? costUsd : null,
        toolCallsTotal,
        toolCallsBlocked,
        terminalState,
      );
    },

    getPaneSummary(workspaceId: string, paneId: string): PaneSummaryRow | undefined {
      return getPaneSummaryStmt.get(workspaceId, paneId) as PaneSummaryRow | undefined;
    },

    upsertWorkspaceSummary(params: UpsertWorkspaceSummaryParams): void {
      const existing = this.getWorkspaceSummary(params.id);
      if (existing) {
        db.prepare(`
          UPDATE workspace_summary SET
            closed_at = COALESCE(?, closed_at),
            panes_total = COALESCE(?, panes_total),
            merges_total = COALESCE(?, merges_total)
          WHERE id = ?
        `).run(
          params.closedAt ?? null,
          params.panesTotal ?? null,
          params.mergesTotal ?? null,
          params.id,
        );
      } else {
        db.prepare(`
          INSERT INTO workspace_summary (id, created_at, closed_at, panes_total, merges_total)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          params.id,
          params.createdAt ?? null,
          params.closedAt ?? null,
          params.panesTotal ?? 0,
          params.mergesTotal ?? 0,
        );
      }
    },

    getWorkspaceSummary(workspaceId: string): WorkspaceSummaryRow | undefined {
      return getWorkspaceSummaryStmt.get(workspaceId) as WorkspaceSummaryRow | undefined;
    },

    getWorkspaceStats(workspaceId: string): WorkspaceStats | undefined {
      const workspace = this.getWorkspaceSummary(workspaceId);
      if (!workspace) return undefined;

      const paneSummaries = getPaneSummariesForWorkspaceStmt.all(workspaceId) as PaneSummaryRow[];

      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let totalCostUsd = 0;

      for (const ps of paneSummaries) {
        totalTokensIn += ps.tokens_in ?? 0;
        totalTokensOut += ps.tokens_out ?? 0;
        totalCostUsd += ps.cost_usd ?? 0;
      }

      return {
        workspace,
        paneSummaries,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd,
      };
    },

    getCostBreakdown(workspaceId: string): CostBreakdownRow[] {
      return getCostBreakdownStmt.all(workspaceId) as CostBreakdownRow[];
    },

    listTables(): string[] {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      return rows.map((r) => r.name);
    },

    close(): void {
      db.close();
    },
  };
}
