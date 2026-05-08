import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createMergeRun, resumeMergeRun, type MergePhase, type MergeRunState, type SubAgentResolver } from './merge-runner.js';

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-merge-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

let repoDir: string;

beforeEach(() => {
  repoDir = initRepo();
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function mergeLogPath(): string {
  return path.join(repoDir, '.workspace', 'merge-log.md');
}

describe('merge runner — clean merge', () => {
  it('reaches complete for two non-overlapping branches', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'worker-2');
    fs.writeFileSync(path.join(repoDir, 'file-b.ts'), 'export const b = 2;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-b');

    git(repoDir, 'checkout', 'main');

    const phases: MergePhase[] = [];
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1', 'worker-2'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
    });

    const result = await run.promise;

    expect(result.phase).toBe('complete');
    expect(result.mergedBranches).toEqual(['worker-1', 'worker-2']);
    expect(result.completedAt).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('emits phases in correct order for clean merge', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');

    const phases: MergePhase[] = [];
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
    });

    await run.promise;

    expect(phases).toEqual(['tagging', 'merging', 'testing', 'complete']);
  });

  it('creates pre-merge tag on main', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');

    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: () => {},
    });

    const result = await run.promise;

    const tags = git(repoDir, 'tag', '-l', result.preMergeTag);
    expect(tags).toBe(result.preMergeTag);

    const tagCommit = git(repoDir, 'rev-parse', result.preMergeTag);
    const initialCommit = git(repoDir, 'rev-parse', 'main~1');
    expect(tagCommit).toBe(initialCommit);
  });

  it('merged files are present on main after complete', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'worker-2');
    fs.writeFileSync(path.join(repoDir, 'file-b.ts'), 'export const b = 2;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-b');

    git(repoDir, 'checkout', 'main');

    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1', 'worker-2'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: () => {},
    });

    await run.promise;

    expect(fs.existsSync(path.join(repoDir, 'file-a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'file-b.ts'))).toBe(true);
  });
});

describe('merge runner — failing verify', () => {
  it('reverts to pre-merge tag when verify command fails', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const phases: MergePhase[] = [];
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'false',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
    });

    const result = await run.promise;

    expect(result.phase).toBe('reverted');
    expect(result.error).toMatch(/verify/i);
    expect(phases).toContain('reverted');

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    expect(fs.existsSync(path.join(repoDir, 'file-a.ts'))).toBe(false);
  });

  it('records revert in merge log', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');

    const logPath = mergeLogPath();
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'false',
      mergeLogPath: logPath,
      onProgress: () => {},
    });

    await run.promise;

    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/revert/i);
  });
});

describe('merge runner — cancel', () => {
  it('reverts when cancelled during verify', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'sleep 30',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => {
        if (phase === 'testing') {
          setTimeout(() => run.cancel(), 100);
        }
      },
    });

    const result = await run.promise;

    expect(result.phase).toBe('reverted');
    expect(result.error).toMatch(/cancel/i);

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);
  });
});

describe('merge runner — trivial conflict auto-resolve', () => {
  it('auto-resolves whitespace-only conflict and records in merge log', async () => {
    fs.writeFileSync(path.join(repoDir, 'shared.ts'), '  const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add shared');

    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'shared.ts'), '    const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'reindent shared');

    git(repoDir, 'checkout', 'main');
    fs.writeFileSync(path.join(repoDir, 'shared.ts'), '\tconst x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'tab-indent shared on main');

    const phases: MergePhase[] = [];
    const logPath = mergeLogPath();
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: logPath,
      onProgress: (phase) => { phases.push(phase); },
    });

    const result = await run.promise;

    expect(result.phase).toBe('complete');
    expect(phases).toContain('resolving');
    expect(result.mergedBranches).toEqual(['worker-1']);

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/auto-resolv/i);
    expect(log).toMatch(/shared\.ts/);
  });
});

describe('merge runner — sub-agent conflict resolution', () => {
  it('sub-agent successful resolution lands in merge-log and merge proceeds', async () => {
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 3000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add config');

    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 8080;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 8080');

    git(repoDir, 'checkout', 'main');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 4000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 4000');

    const resolver: SubAgentResolver = async (req, onProgress) => {
      const subAgentId = 'sub-agent-1';
      onProgress(subAgentId, 'Resolving config.ts');
      for (const file of req.conflictFiles) {
        const filePath = path.join(req.repoPath, file);
        fs.writeFileSync(filePath, 'export const port = 8080;\n');
      }
      return { resolved: true, resolvedFiles: req.conflictFiles, subAgentId, cli: 'claude' };
    };

    const phases: MergePhase[] = [];
    const logPath = mergeLogPath();
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: logPath,
      onProgress: (phase) => { phases.push(phase); },
      subAgentResolver: resolver,
    });

    const result = await run.promise;

    expect(result.phase).toBe('complete');
    expect(result.mergedBranches).toEqual(['worker-1']);
    expect(phases).toContain('resolving');

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/sub-agent/i);
    expect(log).toMatch(/config\.ts/);
    expect(log).toMatch(/claude/i);

    expect(result.subAgents).toBeDefined();
    expect(result.subAgents!.length).toBe(1);
    expect(result.subAgents![0].status).toBe('resolved');
    expect(result.subAgents![0].cli).toBe('claude');
  });

  it('sub-agent timeout produces escalation and revert', async () => {
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 3000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add config');

    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 8080;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 8080');

    git(repoDir, 'checkout', 'main');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 4000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 4000');

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const resolver: SubAgentResolver = async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { resolved: true, resolvedFiles: [], subAgentId: 'sub-agent-1', cli: 'claude' };
    };

    const phases: MergePhase[] = [];
    const logPath = mergeLogPath();
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: logPath,
      onProgress: (phase) => { phases.push(phase); },
      subAgentResolver: resolver,
      subAgentTimeoutMs: 200,
    });

    const result = await run.promise;

    expect(result.phase).toBe('reverted');
    expect(result.error).toMatch(/timeout|escalat/i);
    expect(phases).toContain('resolving');

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    expect(result.subAgents).toBeDefined();
    expect(result.subAgents![0].status).toBe('timeout');
  });

  it('sub-agent failure falls back to revert', async () => {
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 3000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add config');

    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 8080;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 8080');

    git(repoDir, 'checkout', 'main');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 4000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 4000');

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const resolver: SubAgentResolver = async () => {
      return { resolved: false, resolvedFiles: [], subAgentId: 'sub-agent-1', cli: 'codex' };
    };

    const phases: MergePhase[] = [];
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
      subAgentResolver: resolver,
    });

    const result = await run.promise;

    expect(result.phase).toBe('reverted');
    expect(result.error).toMatch(/sub-agent.*fail|escalat/i);

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);

    expect(result.subAgents).toBeDefined();
    expect(result.subAgents![0].status).toBe('failed');
  });
});

describe('merge runner — resume', () => {
  it('resumes from interrupted merge skipping already-merged branches', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'checkout', '-b', 'worker-2');
    fs.writeFileSync(path.join(repoDir, 'file-b.ts'), 'export const b = 2;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-b');

    git(repoDir, 'checkout', 'main');

    git(repoDir, 'tag', 'workspace-pre-merge-test');
    git(repoDir, 'merge', 'worker-1', '--no-edit');

    const previousState: MergeRunState = {
      mergeRunId: 'merge-old',
      phase: 'merging',
      preMergeTag: 'workspace-pre-merge-test',
      branchOrder: ['worker-1', 'worker-2'],
      mergedBranches: ['worker-1'],
      verifyCommand: 'true',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    const phases: MergePhase[] = [];
    const run = resumeMergeRun({
      repoPath: repoDir,
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
      previousState,
    });

    const result = await run.promise;

    expect(result.phase).toBe('complete');
    expect(result.mergedBranches).toEqual(['worker-1', 'worker-2']);
    expect(phases).not.toContain('tagging');
    expect(phases).toContain('merging');
    expect(phases).toContain('complete');

    expect(fs.existsSync(path.join(repoDir, 'file-a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'file-b.ts'))).toBe(true);
  });

  it('resumes from testing phase and reaches complete', async () => {
    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add file-a');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'tag', 'workspace-pre-merge-test');
    git(repoDir, 'merge', 'worker-1', '--no-edit');

    const previousState: MergeRunState = {
      mergeRunId: 'merge-old',
      phase: 'testing',
      preMergeTag: 'workspace-pre-merge-test',
      branchOrder: ['worker-1'],
      mergedBranches: ['worker-1'],
      verifyCommand: 'true',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    const phases: MergePhase[] = [];
    const run = resumeMergeRun({
      repoPath: repoDir,
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
      previousState,
    });

    const result = await run.promise;

    expect(result.phase).toBe('complete');
    expect(phases).toContain('testing');
    expect(phases).not.toContain('tagging');
    expect(phases).not.toContain('merging');
  });
});

describe('merge runner — semantic conflict (no sub-agent)', () => {
  it('escalates semantic conflict and reverts', async () => {
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 3000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add config');

    git(repoDir, 'checkout', '-b', 'worker-1');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 8080;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 8080');

    git(repoDir, 'checkout', 'main');
    fs.writeFileSync(path.join(repoDir, 'config.ts'), 'export const port = 4000;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'change port to 4000');

    const mainBefore = git(repoDir, 'rev-parse', 'HEAD');

    const phases: MergePhase[] = [];
    const run = createMergeRun({
      repoPath: repoDir,
      branchOrder: ['worker-1'],
      verifyCommand: 'true',
      mergeLogPath: mergeLogPath(),
      onProgress: (phase) => { phases.push(phase); },
    });

    const result = await run.promise;

    expect(result.phase).toBe('reverted');
    expect(result.error).toMatch(/semantic.*conflict|escalat/i);
    expect(phases).toContain('resolving');

    const mainAfter = git(repoDir, 'rev-parse', 'HEAD');
    expect(mainAfter).toBe(mainBefore);
  });
});
