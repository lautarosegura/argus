import fs from 'node:fs';
import path from 'node:path';
import { getDefaultLogDir, type LogLevel } from '../../src/shared/logger.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

interface LogsOptions {
  follow: boolean;
  workspace?: string;
  level: LogLevel;
}

function formatEntry(line: string, minLevel: LogLevel): string | null {
  try {
    const entry = JSON.parse(line) as { ts: string; level: LogLevel; component: string; msg: string };
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[minLevel]) return null;
    const lvl = entry.level.toUpperCase().padEnd(5);
    const { ts, level: _, component, msg, ...rest } = entry;
    const extra = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
    return `${ts} ${lvl} [${component}] ${msg}${extra}`;
  } catch {
    return null;
  }
}

export function parseLogsArgs(args: string[]): LogsOptions {
  let follow = false;
  let workspace: string | undefined;
  let level: LogLevel = 'debug';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--follow':
      case '-f':
        follow = true;
        break;
      case '--workspace':
        workspace = args[++i];
        break;
      case '--level':
        {
          const val = args[++i];
          if (val && VALID_LEVELS.has(val)) level = val as LogLevel;
        }
        break;
    }
  }

  return { follow, workspace, level };
}

export async function logs(args: string[]): Promise<void> {
  const opts = parseLogsArgs(args);
  const logDir = getDefaultLogDir();
  const component = opts.workspace ? `workspace-${opts.workspace}` : 'daemon';
  const componentDir = path.join(logDir, component);

  const today = new Date().toISOString().slice(0, 10);
  const filePath = path.join(componentDir, `${today}.ndjson`);

  if (!fs.existsSync(filePath)) {
    console.error(`No log file found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const formatted = formatEntry(line, opts.level);
    if (formatted) console.log(formatted);
  }

  if (!opts.follow) return;

  let position = fs.statSync(filePath).size;

  const watcher = fs.watch(filePath, () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (stat.size <= position) return;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - position);
    fs.readSync(fd, buf, 0, buf.length, position);
    fs.closeSync(fd);
    position = stat.size;

    for (const line of buf.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const formatted = formatEntry(line, opts.level);
      if (formatted) console.log(formatted);
    }
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  await new Promise(() => {});
}
