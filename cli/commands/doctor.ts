import { execFile } from 'node:child_process';
import net from 'node:net';
import { getPipePath } from '../../src/shared/protocol.js';
import { connectWithAutoSpawn } from '../pipe-client.js';

export interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
  remediation?: string;
}

export interface WhichDeps {
  which(cli: string): Promise<string | null>;
}

export interface VersionDeps {
  runVersion(cli: string): Promise<{ ok: boolean; output: string }>;
}

export interface PipeDeps {
  connect(): Promise<{ connected: boolean; autoSpawned: boolean }>;
}

export async function checkCliInPath(
  cli: string,
  deps: WhichDeps,
): Promise<CheckResult> {
  const resolved = await deps.which(cli);
  if (resolved) {
    return { name: `${cli} in PATH`, status: 'PASS', detail: resolved };
  }
  return {
    name: `${cli} in PATH`,
    status: 'FAIL',
    detail: `${cli} not found in PATH`,
    remediation: `Install ${cli} and ensure it is on your PATH. See the ${cli} documentation for install instructions.`,
  };
}

export async function checkCliVersion(
  cli: string,
  deps: VersionDeps,
): Promise<CheckResult> {
  const { ok, output } = await deps.runVersion(cli);
  if (ok) {
    return { name: `${cli} version`, status: 'PASS', detail: output.trim() };
  }
  return {
    name: `${cli} version`,
    status: 'FAIL',
    detail: output.trim(),
    remediation: `Run "${cli} login" to authenticate, then retry.`,
  };
}

export async function checkDaemonPipe(deps: PipeDeps): Promise<CheckResult> {
  const { connected, autoSpawned } = await deps.connect();
  if (connected && autoSpawned) {
    return {
      name: 'argusd pipe',
      status: 'PASS',
      detail: 'argusd was not running; auto-spawned successfully',
    };
  }
  if (connected) {
    return {
      name: 'argusd pipe',
      status: 'PASS',
      detail: 'argusd reachable',
    };
  }
  return {
    name: 'argusd pipe',
    status: 'FAIL',
    detail: 'Could not connect to argusd',
    remediation: 'Start the daemon manually with: npx tsx src/daemon/main.ts',
  };
}

function realWhich(cli: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, [cli], (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout.trim().split('\n')[0] ?? null);
      }
    });
  });
}

function realRunVersion(cli: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cli, ['--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: stderr || stdout || err.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

function realConnect(): Promise<{ connected: boolean; autoSpawned: boolean }> {
  const pipePath = getPipePath();
  return new Promise((resolve) => {
    const probe = net.createConnection(pipePath, () => {
      probe.end();
      resolve({ connected: true, autoSpawned: false });
    });
    probe.on('error', async () => {
      try {
        const client = await connectWithAutoSpawn({ pipePath });
        client.destroy();
        resolve({ connected: true, autoSpawned: true });
      } catch {
        resolve({ connected: false, autoSpawned: false });
      }
    });
  });
}

const CONFIGURED_CLIS = ['claude', 'codex'];

export async function doctor(): Promise<void> {
  const results: CheckResult[] = [];

  for (const cli of CONFIGURED_CLIS) {
    const pathResult = await checkCliInPath(cli, { which: realWhich });
    results.push(pathResult);

    if (pathResult.status === 'PASS') {
      results.push(await checkCliVersion(cli, { runVersion: realRunVersion }));
    }
  }

  results.push(await checkDaemonPipe({ connect: realConnect }));

  let hasFail = false;
  for (const r of results) {
    const line = `  [${r.status}] ${r.name}`;
    console.log(r.detail ? `${line}: ${r.detail}` : line);
    if (r.status === 'FAIL' && r.remediation) {
      console.log(`         -> ${r.remediation}`);
      hasFail = true;
    }
  }

  if (hasFail) {
    process.exitCode = 1;
  }
}
