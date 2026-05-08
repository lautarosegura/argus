import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function open(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: argus open <name>');
    process.exit(1);
  }

  const electronBin = resolveElectron();
  const mainScript = path.resolve(__dirname, '..', '..', 'gui', 'main.ts');

  const child = spawn(electronBin, [mainScript, '--workspace', name], {
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  console.log(`Opening workspace "${name}" in Argus GUI`);
}

function resolveElectron(): string {
  try {
    const electronPath = path.resolve(
      __dirname, '..', '..', 'node_modules', 'electron', 'cli.js',
    );
    return electronPath;
  } catch {
    console.error('Electron not found. Install it with: npm install --save-dev electron');
    process.exit(1);
  }
}
