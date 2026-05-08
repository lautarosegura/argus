import { connectWithAutoSpawn } from '../pipe-client.js';

export interface SentinelCommand {
  cmd: 'done' | 'blocked' | 'status';
  payload: unknown;
}

export function parseSentinelArgs(args: string[]): SentinelCommand {
  const subcommand = args[0];

  switch (subcommand) {
    case 'done': {
      let summary: string | undefined;
      let needsReview = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--summary' && i + 1 < args.length) {
          summary = args[++i];
        } else if (args[i] === '--needs-review') {
          needsReview = true;
        }
      }
      return { cmd: 'done', payload: { summary, needsReview } };
    }

    case 'blocked': {
      const reason = args.slice(1).join(' ');
      if (!reason) {
        throw new Error('blocked: reason is required. Usage: workspace blocked <reason>');
      }
      return { cmd: 'blocked', payload: { reason } };
    }

    case 'status': {
      const text = args.slice(1).join(' ');
      if (!text) {
        throw new Error('status: text is required. Usage: workspace status <text>');
      }
      return { cmd: 'status', payload: { text } };
    }

    default:
      throw new Error(
        `Unknown workspace command: ${subcommand ?? '(none)'}. ` +
        `workspace only supports: done, blocked, status. For admin commands, use argus.`,
      );
  }
}

export async function sentinel(args: string[]): Promise<void> {
  const parsed = parseSentinelArgs(args);

  const workspaceId = process.env.ARGUS_WORKSPACE_ID;
  const paneId = process.env.ARGUS_PANE_ID;

  if (!workspaceId || !paneId) {
    console.error(
      'ARGUS_WORKSPACE_ID and ARGUS_PANE_ID must be set. ' +
      'The workspace command is meant to be run from inside an argus-managed worktree.',
    );
    process.exit(1);
  }

  const client = await connectWithAutoSpawn();
  try {
    await client.request('sentinel.report', {
      workspaceId,
      paneId,
      cmd: parsed.cmd,
      payload: parsed.payload,
    });
  } finally {
    client.destroy();
  }
}
