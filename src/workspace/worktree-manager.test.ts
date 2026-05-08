import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  addWorktree,
  removeWorktree,
  listWorktrees,
  deleteBranch,
  ensureGitignore,
  provisionWorkspace,
  cleanWorkspace,
} from './worktree-manager.js';
import type { PaneState } from './workspace-types.js';

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
}

let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-wt-test-'));
  initRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('addWorktree', () => {
  it('creates a worktree directory and branch', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);

    const branches = git(repoDir, 'branch', '--list');
    expect(branches).toContain('workspace/demo/agent-1');
  });

  it('is idempotent: adding same worktree twice does not error or duplicate', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');

    const worktrees = await listWorktrees(repoDir);
    const matching = worktrees.filter((w) => w.branch === 'workspace/demo/agent-1');
    expect(matching).toHaveLength(1);
  });

  it('fails clearly on branch collision (existing branch, different worktree)', async () => {
    git(repoDir, 'branch', 'workspace/demo/agent-1');

    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await expect(addWorktree(repoDir, wtPath, 'workspace/demo/agent-1')).rejects.toThrow(
      /branch.*already exists/i,
    );
  });
});

describe('removeWorktree', () => {
  it('removes a worktree', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');
    await removeWorktree(repoDir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('handles already-removed worktree directory gracefully', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');

    fs.rmSync(wtPath, { recursive: true, force: true });

    await expect(removeWorktree(repoDir, wtPath)).resolves.not.toThrow();
  });
});

describe('listWorktrees', () => {
  it('lists the main worktree and any added worktrees', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');

    const worktrees = await listWorktrees(repoDir);
    expect(worktrees.length).toBeGreaterThanOrEqual(2);
    expect(worktrees.some((w) => w.branch === 'workspace/demo/agent-1')).toBe(true);
  });
});

describe('deleteBranch', () => {
  it('deletes a branch', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');
    await removeWorktree(repoDir, wtPath);
    await deleteBranch(repoDir, 'workspace/demo/agent-1');

    const branches = git(repoDir, 'branch', '--list');
    expect(branches).not.toContain('workspace/demo/agent-1');
  });
});

describe('ensureGitignore', () => {
  it('adds .workspace/ to .gitignore if not present', async () => {
    await ensureGitignore(repoDir, '.workspace/');

    const content = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.workspace/');
  });

  it('is idempotent: does not duplicate entry', async () => {
    await ensureGitignore(repoDir, '.workspace/');
    await ensureGitignore(repoDir, '.workspace/');

    const content = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf-8');
    const matches = content.split('\n').filter((l) => l.trim() === '.workspace/');
    expect(matches).toHaveLength(1);
  });

  it('preserves existing .gitignore content', async () => {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    await ensureGitignore(repoDir, '.workspace/');

    const content = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.workspace/');
  });
});

describe('stale worktree cleanup', () => {
  it('removeWorktree handles a stale worktree (directory removed externally) without corrupting state', async () => {
    const wtPath = path.join(repoDir, '.workspace', 'worktrees', 'agent-1');
    await addWorktree(repoDir, wtPath, 'workspace/demo/agent-1');

    fs.rmSync(wtPath, { recursive: true, force: true });

    await removeWorktree(repoDir, wtPath);

    const worktrees = await listWorktrees(repoDir);
    const stale = worktrees.filter((w) => w.branch === 'workspace/demo/agent-1');
    expect(stale).toHaveLength(0);
  });
});

describe('provisionWorkspace', () => {
  it('creates worktrees for all agents and returns pane states', async () => {
    const panes = await provisionWorkspace(repoDir, 'demo', [
      { cli: 'claude', count: 2 },
    ]);

    expect(panes).toHaveLength(2);

    expect(panes[0].paneId).toBe('agent-1');
    expect(panes[0].role).toBe('lead');
    expect(panes[0].cli).toBe('claude');
    expect(panes[0].branchName).toBe('workspace/demo/agent-1');
    expect(panes[0].worktreeRelPath).toBe('.workspace/worktrees/agent-1');

    expect(panes[1].paneId).toBe('agent-2');
    expect(panes[1].role).toBe('worker');
    expect(panes[1].branchName).toBe('workspace/demo/agent-2');

    for (const pane of panes) {
      const fullPath = path.join(repoDir, pane.worktreeRelPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });

  it('provisions mixed agent ratios correctly', async () => {
    const panes = await provisionWorkspace(repoDir, 'multi', [
      { cli: 'claude', count: 1 },
      { cli: 'codex', count: 2 },
    ]);

    expect(panes).toHaveLength(3);
    expect(panes[0].cli).toBe('claude');
    expect(panes[1].cli).toBe('codex');
    expect(panes[2].cli).toBe('codex');
  });

  it('adds .workspace/ to .gitignore', async () => {
    await provisionWorkspace(repoDir, 'demo', [{ cli: 'claude', count: 1 }]);

    const content = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.workspace/');
  });
});

describe('cleanWorkspace', () => {
  it('removes all worktrees, branches, and .workspace directory', async () => {
    const panes = await provisionWorkspace(repoDir, 'demo', [
      { cli: 'claude', count: 2 },
    ]);

    await cleanWorkspace(repoDir, panes);

    for (const pane of panes) {
      const fullPath = path.join(repoDir, pane.worktreeRelPath);
      expect(fs.existsSync(fullPath)).toBe(false);
    }

    const branches = git(repoDir, 'branch', '--list');
    expect(branches).not.toContain('workspace/demo/agent-1');
    expect(branches).not.toContain('workspace/demo/agent-2');
  });

  it('handles partial cleanup (some worktrees already removed)', async () => {
    const panes = await provisionWorkspace(repoDir, 'demo', [
      { cli: 'claude', count: 2 },
    ]);

    const firstWtPath = path.join(repoDir, panes[0].worktreeRelPath);
    fs.rmSync(firstWtPath, { recursive: true, force: true });

    await expect(cleanWorkspace(repoDir, panes)).resolves.not.toThrow();

    const branches = git(repoDir, 'branch', '--list');
    expect(branches).not.toContain('workspace/demo/agent-1');
    expect(branches).not.toContain('workspace/demo/agent-2');
  });
});
