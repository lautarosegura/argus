import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeClient as createBasePipeClient, type PipeClient } from '../src/daemon/pipe-client.js';
import { getPipePath } from '../src/shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_MAIN = path.resolve(__dirname, '..', 'src', 'daemon', 'main.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDaemon(pipePath: string): void {
  const child = spawn(process.execPath, ['--import', 'tsx', DAEMON_MAIN], {
    env: { ...process.env, ARGUS_PIPE: pipePath },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

export async function connectWithAutoSpawn(opts?: {
  pipePath?: string;
  retries?: number;
  retryDelayMs?: number;
}): Promise<PipeClient> {
  const pipePath = opts?.pipePath ?? getPipePath();
  const retries = opts?.retries ?? 5;
  const retryDelayMs = opts?.retryDelayMs ?? 300;
  let spawned = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = createBasePipeClient(pipePath);
    try {
      await client.connect();
      return client;
    } catch {
      client.destroy();
      if (!spawned) {
        spawnDaemon(pipePath);
        spawned = true;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(`Could not connect to argusd at ${pipePath} after ${retries} retries`);
}
