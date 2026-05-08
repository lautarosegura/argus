import { connectWithAutoSpawn } from '../pipe-client.js';

export async function clean(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: argus clean <name> [--yes]');
    process.exit(1);
  }

  const skipConfirm = args.includes('--yes') || args.includes('-y');

  if (!skipConfirm) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Remove workspace "${name}" and all its worktrees/branches? [y/N] `,
        resolve,
      );
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  const client = await connectWithAutoSpawn();
  try {
    await client.request('workspace.delete', { id: name, cleanWorktrees: true });
    console.log(`Workspace "${name}" cleaned.`);
  } finally {
    client.destroy();
  }
}
