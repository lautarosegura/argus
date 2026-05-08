import type { WorkspaceSummary } from '../../src/workspace/workspace-types.js';
import { connectWithAutoSpawn } from '../pipe-client.js';

export async function list(): Promise<void> {
  const client = await connectWithAutoSpawn();
  try {
    const result = (await client.request('workspace.list', {})) as {
      workspaces: WorkspaceSummary[];
    };

    if (result.workspaces.length === 0) {
      console.log('No workspaces.');
      return;
    }

    for (const ws of result.workspaces) {
      const agents = ws.agentRatio.map((a) => `${a.count}x${a.cli}`).join(', ');
      console.log(`${ws.name}  agents=${agents}  panes=${ws.paneCount}  repo=${ws.repoPath}`);
    }
  } finally {
    client.destroy();
  }
}
