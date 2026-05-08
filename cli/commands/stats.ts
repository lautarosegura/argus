import { createMetricsStore, getDefaultMetricsDbPath } from '../../src/metrics/metrics-store.js';
import { formatWorkspaceStats, formatCostBreakdown } from '../../src/metrics/stats-formatter.js';

export async function stats(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand !== 'workspace') {
    console.error('Usage: argus stats workspace <id> [--cost]');
    process.exit(1);
  }

  const workspaceId = args[1];
  if (!workspaceId) {
    console.error('Usage: argus stats workspace <id> [--cost]');
    process.exit(1);
  }

  const showCost = args.includes('--cost');
  const dbPath = getDefaultMetricsDbPath();
  const store = createMetricsStore(dbPath);

  try {
    const wsStats = store.getWorkspaceStats(workspaceId);
    console.log(formatWorkspaceStats(wsStats));

    if (showCost && wsStats) {
      console.log('');
      const breakdown = store.getCostBreakdown(workspaceId);
      console.log(formatCostBreakdown(breakdown));
    }
  } finally {
    store.close();
  }
}
