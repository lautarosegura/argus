import type { WorkspaceStats, CostBreakdownRow } from './metrics-store.js';

function fmtNum(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return n.toLocaleString('en-US');
}

function fmtCost(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return `$${n.toFixed(2)}`;
}

export function formatWorkspaceStats(stats: WorkspaceStats | undefined): string {
  if (!stats) return 'Workspace not found.';

  const ws = stats.workspace;
  const lines: string[] = [
    `Workspace: ${ws.id}`,
    `  Created: ${ws.created_at ?? 'N/A'}`,
    `  Closed:  ${ws.closed_at ?? '(active)'}`,
    `  Panes: ${ws.panes_total}  Merges: ${ws.merges_total}`,
    '',
    `  Tokens in:  ${fmtNum(stats.totalTokensIn)}`,
    `  Tokens out: ${fmtNum(stats.totalTokensOut)}`,
    `  Total cost: ${fmtCost(stats.totalCostUsd || null)}`,
  ];

  return lines.join('\n');
}

export function formatCostBreakdown(breakdown: CostBreakdownRow[]): string {
  if (breakdown.length === 0) return 'No cost data available.';

  const lines: string[] = ['Per-CLI cost breakdown:', ''];

  for (const row of breakdown) {
    lines.push(`  ${row.cli} (${row.pane_count} pane${row.pane_count === 1 ? '' : 's'}):`);
    lines.push(`    Tokens in:  ${fmtNum(row.tokens_in)}`);
    lines.push(`    Tokens out: ${fmtNum(row.tokens_out)}`);
    lines.push(`    Cost:       ${fmtCost(row.cost_usd)}`);
  }

  return lines.join('\n');
}
