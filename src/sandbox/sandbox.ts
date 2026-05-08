import path from 'node:path';
import os from 'node:os';
import type { Logger } from '../shared/logger.js';

export type SandboxDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; risk: 'low' | 'medium' | 'high' };

export interface DecideInput {
  cli: 'claude' | 'codex';
  tool: string;
  args: unknown;
  worktreePath: string;
  paneRole: 'lead' | 'worker' | 'merge';
}

export interface DecideOptions {
  homedir?: string;
}

const ALLOW: SandboxDecision = Object.freeze({ kind: 'allow' as const });

function deny(reason: string): SandboxDecision {
  return { kind: 'deny', reason };
}

function isInsidePath(target: string, base: string): boolean {
  const resolved = path.resolve(target);
  const resolvedBase = path.resolve(base);
  return resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep);
}

const DENIED_BASH_COMMANDS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/, reason: 'git push is not allowed in sandbox' },
  { pattern: /\bgit\s+remote\s+add\b/, reason: 'git remote add is not allowed in sandbox' },
  { pattern: /\bgit\s+remote\s+set-url\b/, reason: 'git remote set-url is not allowed in sandbox' },
  { pattern: /\bnpm\s+publish\b/, reason: 'npm publish is not allowed in sandbox' },
  { pattern: /\bcurl\b/, reason: 'curl is not allowed in sandbox' },
  { pattern: /\bwget\b/, reason: 'wget is not allowed in sandbox' },
  { pattern: /\baws\b/, reason: 'aws CLI is not allowed in sandbox' },
];

const GH_READONLY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh\s+issue\s+list\b/,
  /\bgh\s+issue\s+view\b/,
  /\bgh\s+pr\s+list\b/,
  /\bgh\s+pr\s+view\b/,
  /\bgh\s+pr\s+status\b/,
  /\bgh\s+pr\s+checks\b/,
  /\bgh\s+repo\s+view\b/,
];

function checkBashCommand(command: string): SandboxDecision {
  for (const { pattern, reason } of DENIED_BASH_COMMANDS) {
    if (pattern.test(command)) {
      return deny(reason);
    }
  }

  if (/\bgh\b/.test(command)) {
    if (!GH_READONLY_PATTERNS.some((p) => p.test(command))) {
      return deny('gh command is not allowed in sandbox (only read-only subcommands permitted)');
    }
  }

  return ALLOW;
}

const SENSITIVE_SUBDIRS = ['.ssh', '.aws', path.join('.config', 'gh')];

function isSensitivePath(filePath: string, homedir: string): string | null {
  const resolved = path.resolve(filePath);
  for (const subdir of SENSITIVE_SUBDIRS) {
    const sensitiveDir = path.join(homedir, subdir);
    if (isInsidePath(resolved, sensitiveDir)) {
      return `~/${subdir}`;
    }
  }
  return null;
}

function isEnvFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === '.env' || base.startsWith('.env.');
}

function checkFilePath(
  filePath: string,
  worktreePath: string,
  paneRole: 'lead' | 'worker',
  isWrite: boolean,
  homedir: string,
): SandboxDecision {
  const resolved = path.resolve(filePath);

  const sensitive = isSensitivePath(resolved, homedir);
  if (sensitive) {
    return deny(`Access to ${sensitive} is not allowed in sandbox`);
  }

  if (isInsidePath(resolved, worktreePath)) {
    return ALLOW;
  }

  if (isEnvFile(resolved)) {
    return deny('Access to .env file outside worktree is not allowed');
  }

  if (isWrite) {
    return deny('Write outside worktree is not allowed');
  }

  if (paneRole === 'lead') {
    const worktreeParent = path.dirname(worktreePath);
    if (isInsidePath(resolved, worktreeParent)) {
      return ALLOW;
    }
    return deny('Read outside workspace worktrees is not allowed');
  }

  return deny('Read outside worktree is not allowed');
}

export function decide(input: DecideInput, opts?: DecideOptions): SandboxDecision {
  if (input.paneRole === 'merge') {
    return ALLOW;
  }

  const homedir = opts?.homedir ?? os.homedir();
  const args = (input.args ?? {}) as Record<string, unknown>;

  switch (input.tool) {
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command : '';
      return checkBashCommand(command);
    }

    case 'Read': {
      const filePath = typeof args.file_path === 'string' ? args.file_path : '';
      if (!filePath) return ALLOW;
      return checkFilePath(filePath, input.worktreePath, input.paneRole, false, homedir);
    }

    case 'Write':
    case 'Edit': {
      const filePath = typeof args.file_path === 'string' ? args.file_path : '';
      if (!filePath) return ALLOW;
      return checkFilePath(filePath, input.worktreePath, input.paneRole, true, homedir);
    }

    case 'Glob':
    case 'Grep': {
      const searchPath = typeof args.path === 'string' ? args.path : '';
      if (!searchPath) return ALLOW;
      return checkFilePath(searchPath, input.worktreePath, input.paneRole, false, homedir);
    }

    default:
      return ALLOW;
  }
}

export function logDecision(
  logger: Logger,
  paneId: string,
  workspaceId: string,
  input: DecideInput,
  decision: SandboxDecision,
): void {
  const extra: Record<string, unknown> = {
    paneId,
    workspaceId,
    cli: input.cli,
    tool: input.tool,
    args: input.args,
    paneRole: input.paneRole,
    worktreePath: input.worktreePath,
    outcome: decision.kind,
  };
  if (decision.kind === 'deny') {
    extra.reason = decision.reason;
  }
  if (decision.kind === 'ask') {
    extra.risk = decision.risk;
  }
  logger.info('sandbox.decision', extra);
}
