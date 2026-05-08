import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRatioEntry, PaneState } from './workspace-types.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
}

async function gitExec(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath });
  return stdout.trim();
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  const existing = await listWorktrees(repoPath);
  const alreadyExists = existing.find(
    (w) => w.branch === branchName || w.path === path.resolve(worktreePath),
  );
  if (alreadyExists) return;

  const branches = await gitExec(repoPath, ['branch', '--list', branchName]);
  if (branches) {
    throw new Error(`Branch "${branchName}" already exists but is not associated with a worktree`);
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await gitExec(repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const absPath = path.resolve(worktreePath);
  if (!fs.existsSync(absPath)) {
    await gitExec(repoPath, ['worktree', 'prune']);
    return;
  }
  await gitExec(repoPath, ['worktree', 'remove', '--force', absPath]);
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const output = await gitExec(repoPath, ['worktree', 'list', '--porcelain']);
  if (!output) return [];

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n');
    const info: Partial<WorktreeInfo> = { bare: false };
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        info.path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        info.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        info.branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === 'bare') {
        info.bare = true;
      }
    }
    if (info.path) {
      worktrees.push(info as WorktreeInfo);
    }
  }
  return worktrees;
}

export async function deleteBranch(repoPath: string, branchName: string): Promise<void> {
  try {
    await gitExec(repoPath, ['branch', '-D', branchName]);
  } catch {}
}

export async function ensureGitignore(repoPath: string, pattern: string): Promise<void> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {}

  const lines = content.split('\n');
  if (lines.some((l) => l.trim() === pattern)) return;

  const suffix = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, content + suffix + pattern + '\n');
}

export async function provisionWorkspace(
  repoPath: string,
  workspaceName: string,
  agentRatio: AgentRatioEntry[],
): Promise<PaneState[]> {
  await ensureGitignore(repoPath, '.workspace/');

  const panes: PaneState[] = [];
  let agentIndex = 1;

  for (const entry of agentRatio) {
    for (let i = 0; i < entry.count; i++) {
      const paneId = `agent-${agentIndex}`;
      const worktreeRelPath = `.workspace/worktrees/${paneId}`;
      const branchName = `workspace/${workspaceName}/${paneId}`;
      const worktreePath = path.join(repoPath, worktreeRelPath);

      await addWorktree(repoPath, worktreePath, branchName);

      panes.push({
        paneId,
        role: panes.length === 0 ? 'lead' : 'worker',
        cli: entry.cli,
        worktreeRelPath,
        branchName,
        userClosed: false,
        lastKnownState: 'idle',
      });

      agentIndex++;
    }
  }

  return panes;
}

export async function cleanWorkspace(
  repoPath: string,
  panes: PaneState[],
): Promise<void> {
  for (const pane of panes) {
    const worktreePath = path.join(repoPath, pane.worktreeRelPath);
    await removeWorktree(repoPath, worktreePath);
    await deleteBranch(repoPath, pane.branchName);
  }
}
