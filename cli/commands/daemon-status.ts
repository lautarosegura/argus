import type { DaemonStatusResult } from '../../src/shared/protocol.js';
import { connectWithAutoSpawn } from '../pipe-client.js';

export async function daemonStatus(pipePath?: string): Promise<void> {
  const client = await connectWithAutoSpawn({ pipePath });
  try {
    const result = (await client.request('daemon.status', {})) as DaemonStatusResult;
    console.log(`argusd v${result.version}`);
    console.log(`  uptime:          ${result.uptime}s`);
    console.log(`  workspaces:      ${result.workspaceCount}`);
    console.log(`  protocolVersion: ${result.protocolVersion}`);
  } finally {
    client.destroy();
  }
}
