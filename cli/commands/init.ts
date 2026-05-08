import path from 'node:path';
import type { AgentRatioEntry } from '../../src/workspace/workspace-types.js';
import { connectWithAutoSpawn } from '../pipe-client.js';

function parseAgentRatio(raw: string): AgentRatioEntry[] {
  return raw.split(',').map((part) => {
    const match = part.match(/^(\d+)x(\w+)$/);
    if (!match) {
      throw new Error(`Invalid agent ratio "${part}". Expected format: NxCLI (e.g., 1xclaude)`);
    }
    return { cli: match[2], count: parseInt(match[1], 10) };
  });
}

export async function init(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: argus init <name> --agents <ratio> [--repo <path>]');
    process.exit(1);
  }

  let agentsRaw: string | undefined;
  let repoPath: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agents' && args[i + 1]) {
      agentsRaw = args[++i];
    } else if (args[i] === '--repo' && args[i + 1]) {
      repoPath = args[++i];
    }
  }

  if (!agentsRaw) {
    console.error('Missing required --agents flag. Example: --agents 1xclaude');
    process.exit(1);
  }

  const agentRatio = parseAgentRatio(agentsRaw);
  const resolvedRepo = path.resolve(repoPath ?? process.cwd());

  const client = await connectWithAutoSpawn();
  try {
    const result = (await client.request('workspace.create', {
      name,
      agentRatio,
      repoPath: resolvedRepo,
    })) as { workspaceId: string };

    console.log(`Workspace created: ${result.workspaceId}`);
  } finally {
    client.destroy();
  }
}
