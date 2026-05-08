import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeClient as createBasePipeClient, type PipeClient } from '../src/daemon/pipe-client.js';
import { getPipePath } from '../src/shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_MAIN = path.resolve(__dirname, '..', 'src', 'daemon', 'main.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findInstalledDaemon(): string | null {
  // In production, argus.exe and argusd.exe are co-located in {app}\bin.
  // process.execPath is the running binary (argus.exe), so the daemon lives next to it.
  const cliDir = path.dirname(process.execPath);
  const candidate = path.join(cliDir, process.platform === 'win32' ? 'argusd.exe' : 'argusd');
  return existsSync(candidate) ? candidate : null;
}

function spawnDaemon(pipePath: string): void {
  const env = { ...process.env, ARGUS_PIPE: pipePath };
  const installed = findInstalledDaemon();
  const child = installed
    ? spawn(installed, [], { env, stdio: 'ignore', detached: true })
    : spawn(process.execPath, ['--import', 'tsx', DAEMON_MAIN], {
        env,
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
