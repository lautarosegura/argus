import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { MergePhase, MergeRunState } from '../workspace/workspace-types.js';

const execFileAsync = promisify(execFile);

export type { MergePhase, MergeRunState };

export interface MergeRunOptions {
  repoPath: string;
  branchOrder: string[];
  verifyCommand: string;
  mergeLogPath: string;
  onProgress: (phase: MergePhase, detail?: string) => void;
}

export interface MergeRun {
  readonly state: MergeRunState;
  readonly promise: Promise<MergeRunState>;
  cancel(): void;
}

async function gitExec(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath });
  return stdout.trim();
}

function appendMergeLog(logPath: string, entry: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `- ${new Date().toISOString()}: ${entry}\n`);
}

interface ConflictSection {
  ours: string;
  theirs: string;
}

function parseConflictMarkers(content: string): ConflictSection[] {
  const sections: ConflictSection[] = [];
  const lines = content.split('\n');
  let inConflict = false;
  let inOurs = false;
  let ours: string[] = [];
  let theirs: string[] = [];

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inOurs = true;
      ours = [];
      theirs = [];
    } else if (line.startsWith('=======') && inConflict) {
      inOurs = false;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      sections.push({ ours: ours.join('\n'), theirs: theirs.join('\n') });
      inConflict = false;
      inOurs = false;
    } else if (inConflict) {
      if (inOurs) {
        ours.push(line);
      } else {
        theirs.push(line);
      }
    }
  }
  return sections;
}

function isWhitespaceOnlyDiff(ours: string, theirs: string): boolean {
  return ours.replace(/\s/g, '') === theirs.replace(/\s/g, '');
}

function resolveConflictMarkers(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inConflict = false;
  let inOurs = false;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inOurs = true;
    } else if (line.startsWith('=======') && inConflict) {
      inOurs = false;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      inConflict = false;
    } else if (inConflict) {
      if (!inOurs) {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

async function tryAutoResolve(
  repoPath: string,
  logPath: string,
): Promise<{ resolved: boolean; files: string[] }> {
  const conflictOutput = await gitExec(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  if (!conflictOutput) return { resolved: false, files: [] };

  const files = conflictOutput.split('\n').filter(Boolean);
  const resolvedFiles: string[] = [];

  for (const file of files) {
    const filePath = path.join(repoPath, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const sections = parseConflictMarkers(content);

    if (sections.length === 0) continue;

    const allWhitespace = sections.every((s) => isWhitespaceOnlyDiff(s.ours, s.theirs));
    if (!allWhitespace) {
      return { resolved: false, files: [] };
    }

    const resolved = resolveConflictMarkers(content);
    fs.writeFileSync(filePath, resolved);
    await gitExec(repoPath, ['add', file]);
    resolvedFiles.push(file);
  }

  if (resolvedFiles.length > 0) {
    await gitExec(repoPath, ['commit', '--no-edit']);
    appendMergeLog(logPath, `Auto-resolved whitespace conflicts in: ${resolvedFiles.join(', ')}`);
  }

  return { resolved: true, files: resolvedFiles };
}

export function createMergeRun(opts: MergeRunOptions): MergeRun {
  let cancelled = false;
  let verifyProcess: ChildProcess | null = null;

  const state: MergeRunState = {
    mergeRunId: `merge-${Date.now()}`,
    phase: 'tagging',
    preMergeTag: `workspace-pre-merge-${Date.now()}`,
    branchOrder: opts.branchOrder,
    mergedBranches: [],
    verifyCommand: opts.verifyCommand,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  function transition(phase: MergePhase, detail?: string): void {
    state.phase = phase;
    opts.onProgress(phase, detail);
  }

  async function revert(reason: string): Promise<MergeRunState> {
    state.error = reason;
    try {
      await gitExec(opts.repoPath, ['reset', '--hard', state.preMergeTag]);
    } catch {}
    state.completedAt = new Date().toISOString();
    transition('reverted', reason);
    try {
      appendMergeLog(opts.mergeLogPath, `Reverted to ${state.preMergeTag}: ${reason}`);
    } catch {}
    return state;
  }

  const promise = (async (): Promise<MergeRunState> => {
    try {
      // Phase: tagging
      transition('tagging');
      await gitExec(opts.repoPath, ['tag', state.preMergeTag]);
      appendMergeLog(opts.mergeLogPath, `Created pre-merge tag: ${state.preMergeTag}`);

      if (cancelled) return await revert('Cancelled');

      // Phase: merging
      transition('merging');
      for (const branch of opts.branchOrder) {
        if (cancelled) return await revert('Cancelled');

        try {
          await gitExec(opts.repoPath, ['merge', branch, '--no-edit']);
          state.mergedBranches.push(branch);
          appendMergeLog(opts.mergeLogPath, `Merged ${branch} cleanly`);
        } catch {
          transition('resolving', `Conflict merging ${branch}`);
          const result = await tryAutoResolve(opts.repoPath, opts.mergeLogPath);
          if (result.resolved) {
            state.mergedBranches.push(branch);
          } else {
            try { await gitExec(opts.repoPath, ['merge', '--abort']); } catch {}
            return await revert(`Semantic conflict merging ${branch} — escalate to human`);
          }
        }
      }

      if (cancelled) return await revert('Cancelled');

      // Phase: testing
      transition('testing');
      const testPassed = await runVerify(opts.repoPath, opts.verifyCommand);

      if (cancelled) return await revert('Cancelled');

      if (!testPassed) {
        return await revert('Verify command failed');
      }

      // Phase: complete
      state.completedAt = new Date().toISOString();
      transition('complete');
      appendMergeLog(opts.mergeLogPath, 'Merge completed successfully');
      return state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return await revert(msg);
    }
  })();

  function runVerify(repoPath: string, command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command.split(/\s+/);
      verifyProcess = execFile(cmd, args, { cwd: repoPath }, (error) => {
        verifyProcess = null;
        if (cancelled) {
          resolve(false);
          return;
        }
        resolve(!error);
      });
    });
  }

  return {
    get state() { return state; },
    promise,
    cancel() {
      cancelled = true;
      if (verifyProcess) {
        verifyProcess.kill('SIGTERM');
        const proc = verifyProcess;
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 5000);
      }
    },
  };
}
