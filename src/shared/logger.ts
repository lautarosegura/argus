import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface LoggerOptions {
  logDir: string;
  component: string;
  level?: LogLevel;
  retentionDays?: number;
  now?: () => Date;
}

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rotateFile(componentDir: string, date: string): void {
  const filePath = path.join(componentDir, `${date}.ndjson`);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath);
  const compressed = zlib.gzipSync(content);
  fs.writeFileSync(path.join(componentDir, `${date}.ndjson.gz`), compressed);
  fs.unlinkSync(filePath);
}

function pruneOldFiles(componentDir: string, retentionDays: number, now: Date): void {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = formatDate(cutoff);

  let files: string[];
  try {
    files = fs.readdirSync(componentDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.ndjson.gz')) continue;
    const date = file.replace('.ndjson.gz', '');
    if (date < cutoffStr) {
      fs.unlinkSync(path.join(componentDir, file));
    }
  }
}

export function resolveLogLevel(): LogLevel {
  const env = process.env.ARGUS_LOG;
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return 'info';
}

export function getDefaultLogDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Argus', 'logs');
  }
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'argus', 'logs');
}

export function createLogger(opts: LoggerOptions): Logger {
  const minLevel = opts.level ?? 'info';
  const retentionDays = opts.retentionDays ?? 14;
  const getNow = opts.now ?? (() => new Date());
  const componentDir = path.join(opts.logDir, opts.component);

  fs.mkdirSync(componentDir, { recursive: true });

  let currentDate = formatDate(getNow());

  pruneOldFiles(componentDir, retentionDays, getNow());

  function write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

    const now = getNow();
    const date = formatDate(now);

    if (date !== currentDate) {
      rotateFile(componentDir, currentDate);
      pruneOldFiles(componentDir, retentionDays, now);
      currentDate = date;
    }

    const entry = {
      ts: now.toISOString(),
      level,
      component: opts.component,
      msg,
      ...extra,
    };

    fs.appendFileSync(
      path.join(componentDir, `${date}.ndjson`),
      JSON.stringify(entry) + '\n',
    );
  }

  return {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
    close: async () => {},
  };
}
