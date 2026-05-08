import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { MergePhase, MergeRunState, SubAgentEntry } from '../workspace/workspace-types.js';

const execFileAsync = promisify(execFile);

export type { MergePhase, MergeRunState, SubAgentEntry };

export interface SubAgentResolveRequest {
  repoPath: string;
  conflictFiles: string[];
  branch: string;
}

export interface SubAgentResolveResult {
  resolved: boolean;
  resolvedFiles: string[];
  subAgentId: string;
  cli: string;
}

export type SubAgentResolver = (
  req: SubAgentResolveRequest,
  onProgress: (subAgentId: string, detail: string) => void,
) => Promise<SubAgentResolveResult>;

export interface MergeRunOptions {
  repoPath: string;
  branchOrder: string[];
  verifyCommand: string;
  mergeLogPath: string;
  onProgress: (phase: MergePhase, detail?: string) => void;
  subAgentResolver?: SubAgentResolver;
  subAgentTimeoutMs?: number;
}

export interface ResumeMergeRunOptions {
  repoPath: string;
  mergeLogPath: string;
  onProgress: (phase: MergePhase, detail?: string) => void;
  previousState: MergeRunState;
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

async function getConflictFiles(repoPath: string): Promise<string[]> {
  const output = await gitExec(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  return output ? output.split('\n').filter(Boolean) : [];
}

async function tryAutoResolve(
  repoPath: string,
  logPath: string,
): Promise<{ resolved: boolean; files: string[] }> {
  const files = await getConflictFiles(repoPath);
  if (files.length === 0) return { resolved: false, files: [] };
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

async function trySubAgentResolve(
  repoPath: string,
  logPath: string,
  branch: string,
  resolver: SubAgentResolver,
  timeoutMs: number,
  state: MergeRunState,
  onProgress: (phase: MergePhase, detail?: string) => void,
): Promise<boolean> {
  const conflictFiles = await getConflictFiles(repoPath);
  if (conflictFiles.length === 0) return false;

  const entry: SubAgentEntry = {
    subAgentId: '',
    cli: '',
    file: conflictFiles.join(', '),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  state.subAgents!.push(entry);

  onProgress('resolving', `Sub-agent resolving: ${conflictFiles.join(', ')}`);

  const resolvePromise = resolver(
    { repoPath, conflictFiles, branch },
    (subAgentId, detail) => {
      entry.subAgentId = subAgentId;
      onProgress('resolving', `Sub-agent ${subAgentId}: ${detail}`);
    },
  );

  const timeoutPromise = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );

  const raceResult = await Promise.race([resolvePromise, timeoutPromise]);

  if (raceResult === 'timeout') {
    entry.status = 'timeout';
    entry.completedAt = new Date().toISOString();
    appendMergeLog(logPath, `Sub-agent timed out resolving ${conflictFiles.join(', ')} on branch ${branch}`);
    return false;
  }

  entry.subAgentId = raceResult.subAgentId;
  entry.cli = raceResult.cli;
  entry.completedAt = new Date().toISOString();

  if (raceResult.resolved && raceResult.resolvedFiles.length > 0) {
    for (const file of raceResult.resolvedFiles) {
      await gitExec(repoPath, ['add', file]);
    }
    await gitExec(repoPath, ['commit', '--no-edit']);
    entry.status = 'resolved';
    appendMergeLog(logPath, `Sub-agent ${raceResult.subAgentId} (${raceResult.cli}) resolved: ${raceResult.resolvedFiles.join(', ')}`);
    return true;
  }

  entry.status = 'failed';
  appendMergeLog(logPath, `Sub-agent ${raceResult.subAgentId} (${raceResult.cli}) failed to resolve ${conflictFiles.join(', ')} on branch ${branch}`);
  return false;
}

interface MergeRunContext {
  repoPath: string;
  mergeLogPath: string;
  onProgress: (phase: MergePhase, detail?: string) => void;
  state: MergeRunState;
  branchesToMerge: string[];
  preRun?: () => Promise<void>;
  subAgentResolver?: SubAgentResolver;
  subAgentTimeoutMs?: number;
}

function buildMergeRun(ctx: MergeRunContext): MergeRun {
  let cancelled = false;
  let verifyProcess: ChildProcess | null = null;
  const { state } = ctx;

  function transition(phase: MergePhase, detail?: string): void {
    state.phase = phase;
    ctx.onProgress(phase, detail);
  }

  async function revert(reason: string): Promise<MergeRunState> {
    state.error = reason;
    try {
      await gitExec(ctx.repoPath, ['reset', '--hard', state.preMergeTag]);
    } catch {}
    state.completedAt = new Date().toISOString();
    transition('reverted', reason);
    try {
      appendMergeLog(ctx.mergeLogPath, `Reverted to ${state.preMergeTag}: ${reason}`);
    } catch {}
    return state;
  }

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

  const promise = (async (): Promise<MergeRunState> => {
    try {
      if (ctx.preRun) await ctx.preRun();

      if (ctx.branchesToMerge.length > 0) {
        transition('merging');
        for (const branch of ctx.branchesToMerge) {
          if (cancelled) return await revert('Cancelled');

          try {
            await gitExec(ctx.repoPath, ['merge', branch, '--no-edit']);
            state.mergedBranches.push(branch);
            appendMergeLog(ctx.mergeLogPath, `Merged ${branch} cleanly`);
          } catch {
            transition('resolving', `Conflict merging ${branch}`);
            const result = await tryAutoResolve(ctx.repoPath, ctx.mergeLogPath);
            if (result.resolved) {
              state.mergedBranches.push(branch);
            } else if (ctx.subAgentResolver) {
              const subAgentResult = await trySubAgentResolve(
                ctx.repoPath, ctx.mergeLogPath, branch, ctx.subAgentResolver,
                ctx.subAgentTimeoutMs ?? 300_000,
                state, ctx.onProgress,
              );
              if (subAgentResult) {
                state.mergedBranches.push(branch);
              } else {
                try { await gitExec(ctx.repoPath, ['merge', '--abort']); } catch {}
                return await revert(`Sub-agent failed to resolve conflict merging ${branch} — escalate to human`);
              }
            } else {
              try { await gitExec(ctx.repoPath, ['merge', '--abort']); } catch {}
              return await revert(`Semantic conflict merging ${branch} — escalate to human`);
            }
          }
        }
      }

      if (cancelled) return await revert('Cancelled');

      transition('testing');
      const testPassed = await runVerify(ctx.repoPath, state.verifyCommand);

      if (cancelled) return await revert('Cancelled');

      if (!testPassed) {
        return await revert('Verify command failed');
      }

      state.completedAt = new Date().toISOString();
      transition('complete');
      appendMergeLog(ctx.mergeLogPath, 'Merge completed successfully');
      return state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return await revert(msg);
    }
  })();

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

export function createMergeRun(opts: MergeRunOptions): MergeRun {
  const state: MergeRunState = {
    mergeRunId: `merge-${Date.now()}`,
    phase: 'tagging',
    preMergeTag: `workspace-pre-merge-${Date.now()}`,
    branchOrder: opts.branchOrder,
    mergedBranches: [],
    verifyCommand: opts.verifyCommand,
    startedAt: new Date().toISOString(),
    completedAt: null,
    subAgents: [],
  };

  return buildMergeRun({
    repoPath: opts.repoPath,
    mergeLogPath: opts.mergeLogPath,
    onProgress: opts.onProgress,
    state,
    branchesToMerge: opts.branchOrder,
    subAgentResolver: opts.subAgentResolver,
    subAgentTimeoutMs: opts.subAgentTimeoutMs,
    async preRun() {
      state.phase = 'tagging';
      opts.onProgress('tagging');
      await gitExec(opts.repoPath, ['tag', state.preMergeTag]);
      appendMergeLog(opts.mergeLogPath, `Created pre-merge tag: ${state.preMergeTag}`);
    },
  });
}

export function resumeMergeRun(opts: ResumeMergeRunOptions): MergeRun {
  const prev = opts.previousState;
  const remaining = prev.branchOrder.filter((b) => !prev.mergedBranches.includes(b));

  const state: MergeRunState = {
    mergeRunId: `merge-resume-${Date.now()}`,
    phase: 'merging',
    preMergeTag: prev.preMergeTag,
    branchOrder: prev.branchOrder,
    mergedBranches: [...prev.mergedBranches],
    verifyCommand: prev.verifyCommand,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  return buildMergeRun({
    repoPath: opts.repoPath,
    mergeLogPath: opts.mergeLogPath,
    onProgress: opts.onProgress,
    state,
    branchesToMerge: remaining,
    async preRun() {
      try { await gitExec(opts.repoPath, ['merge', '--abort']); } catch {}
      appendMergeLog(opts.mergeLogPath, `Resuming merge from phase: ${prev.phase}, already merged: [${prev.mergedBranches.join(', ')}]`);
    },
  });
}
