import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createLogger, resolveLogLevel, getDefaultLogDir, type LogEntry } from './logger.js';

function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-log-test-'));
}

describe('logger', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it('writes valid NDJSON entries to {component}/{date}.ndjson', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    const now = new Date('2026-05-08T12:00:00Z');

    const log = createLogger({ logDir, component: 'daemon', now: () => now });
    log.info('started', { pid: 123 });
    log.warn('low memory');
    await log.close();

    const filePath = path.join(logDir, 'daemon', '2026-05-08.ndjson');
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1: LogEntry = JSON.parse(lines[0]);
    expect(entry1.ts).toBe('2026-05-08T12:00:00.000Z');
    expect(entry1.level).toBe('info');
    expect(entry1.component).toBe('daemon');
    expect(entry1.msg).toBe('started');
    expect((entry1 as unknown as Record<string, unknown>).pid).toBe(123);

    const entry2: LogEntry = JSON.parse(lines[1]);
    expect(entry2.level).toBe('warn');
    expect(entry2.msg).toBe('low memory');
  });

  it('filters entries below configured level', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    const now = new Date('2026-05-08T12:00:00Z');

    const log = createLogger({ logDir, component: 'daemon', level: 'warn', now: () => now });
    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');
    await log.close();

    const filePath = path.join(logDir, 'daemon', '2026-05-08.ndjson');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1: LogEntry = JSON.parse(lines[0]);
    expect(entry1.level).toBe('warn');

    const entry2: LogEntry = JSON.parse(lines[1]);
    expect(entry2.level).toBe('error');
  });

  it('ARGUS_LOG=debug produces debug-level entries; default does not', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    const now = new Date('2026-05-08T12:00:00Z');

    const defaultLog = createLogger({ logDir, component: 'daemon', now: () => now });
    defaultLog.debug('should not appear');
    defaultLog.info('should appear');
    await defaultLog.close();

    const filePath = path.join(logDir, 'daemon', '2026-05-08.ndjson');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('should appear');

    fs.unlinkSync(filePath);

    const debugLog = createLogger({ logDir, component: 'daemon', level: 'debug', now: () => now });
    debugLog.debug('debug visible');
    debugLog.info('info visible');
    await debugLog.close();

    const debugLines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(debugLines).toHaveLength(2);
    expect(JSON.parse(debugLines[0]).msg).toBe('debug visible');
    expect(JSON.parse(debugLines[1]).msg).toBe('info visible');
  });

  it('gzips previous day file on date rollover', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    let currentDate = new Date('2026-05-08T23:59:00Z');

    const log = createLogger({ logDir, component: 'daemon', now: () => currentDate });
    log.info('day 1 entry');

    currentDate = new Date('2026-05-09T00:01:00Z');
    log.info('day 2 entry');
    await log.close();

    const gzPath = path.join(logDir, 'daemon', '2026-05-08.ndjson.gz');
    expect(fs.existsSync(gzPath)).toBe(true);

    const compressed = fs.readFileSync(gzPath);
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
    const entry: LogEntry = JSON.parse(decompressed.trim());
    expect(entry.msg).toBe('day 1 entry');

    const newPath = path.join(logDir, 'daemon', '2026-05-09.ndjson');
    expect(fs.existsSync(newPath)).toBe(true);

    const oldPath = path.join(logDir, 'daemon', '2026-05-08.ndjson');
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it('prunes gzip files older than retentionDays', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    const componentDir = path.join(logDir, 'daemon');
    fs.mkdirSync(componentDir, { recursive: true });

    fs.writeFileSync(path.join(componentDir, '2026-04-18.ndjson.gz'), 'old1');
    fs.writeFileSync(path.join(componentDir, '2026-04-19.ndjson.gz'), 'old2');
    fs.writeFileSync(path.join(componentDir, '2026-05-03.ndjson.gz'), 'recent');

    const now = new Date('2026-05-09T00:01:00Z');
    const log = createLogger({ logDir, component: 'daemon', retentionDays: 14, now: () => now });
    log.info('test');
    await log.close();

    expect(fs.existsSync(path.join(componentDir, '2026-04-18.ndjson.gz'))).toBe(false);
    expect(fs.existsSync(path.join(componentDir, '2026-04-19.ndjson.gz'))).toBe(false);
    expect(fs.existsSync(path.join(componentDir, '2026-05-03.ndjson.gz'))).toBe(true);
  });

  it('creates component subdirectories for different log sources', async () => {
    const logDir = tmpLogDir();
    cleanupDirs.push(logDir);
    const now = new Date('2026-05-08T12:00:00Z');

    const daemonLog = createLogger({ logDir, component: 'daemon', now: () => now });
    const wsLog = createLogger({ logDir, component: 'workspace-auth-flow', now: () => now });
    const paneLog = createLogger({ logDir, component: 'pane-stderr', now: () => now });

    daemonLog.info('daemon started');
    wsLog.info('workspace event');
    paneLog.error('pane error');

    await Promise.all([daemonLog.close(), wsLog.close(), paneLog.close()]);

    expect(fs.existsSync(path.join(logDir, 'daemon', '2026-05-08.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'workspace-auth-flow', '2026-05-08.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'pane-stderr', '2026-05-08.ndjson'))).toBe(true);
  });

  it('resolveLogLevel respects ARGUS_LOG env var', () => {
    const original = process.env.ARGUS_LOG;
    try {
      process.env.ARGUS_LOG = 'debug';
      expect(resolveLogLevel()).toBe('debug');

      process.env.ARGUS_LOG = 'error';
      expect(resolveLogLevel()).toBe('error');

      delete process.env.ARGUS_LOG;
      expect(resolveLogLevel()).toBe('info');
    } finally {
      if (original !== undefined) {
        process.env.ARGUS_LOG = original;
      } else {
        delete process.env.ARGUS_LOG;
      }
    }
  });

  it('getDefaultLogDir returns platform-appropriate path', () => {
    const dir = getDefaultLogDir();
    expect(dir).toContain('logs');
    expect(path.isAbsolute(dir)).toBe(true);
  });
});
