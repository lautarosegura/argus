import { describe, it, expect } from 'vitest';
import { decide, logDecision, type DecideInput, type SandboxDecision } from './sandbox.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../shared/logger.js';

const WORKTREE = '/repo/.workspace/worktrees/agent-1';
const HOMEDIR = '/home/testuser';
const OPTS = { homedir: HOMEDIR };

function makeInput(overrides: Partial<DecideInput>): DecideInput {
  return {
    cli: 'claude',
    tool: 'Bash',
    args: {},
    worktreePath: WORKTREE,
    paneRole: 'worker',
    ...overrides,
  };
}

describe('sandbox decide()', () => {
  describe('merge bypass', () => {
    it('allows any denied command for merge role', () => {
      const result = decide(
        makeInput({ paneRole: 'merge', args: { command: 'git push origin main' } }),
        OPTS,
      );
      expect(result).toEqual({ kind: 'allow' });
    });

    it('allows sensitive path access for merge role', () => {
      const result = decide(
        makeInput({
          paneRole: 'merge',
          tool: 'Read',
          args: { file_path: `${HOMEDIR}/.ssh/id_rsa` },
        }),
        OPTS,
      );
      expect(result).toEqual({ kind: 'allow' });
    });

    it('allows writes outside worktree for merge role', () => {
      const result = decide(
        makeInput({
          paneRole: 'merge',
          tool: 'Write',
          args: { file_path: '/etc/some-config' },
        }),
        OPTS,
      );
      expect(result).toEqual({ kind: 'allow' });
    });
  });

  describe('Bash command deny list', () => {
    describe('git push', () => {
      it('denies git push', () => {
        const result = decide(makeInput({ args: { command: 'git push origin main' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('allows git status', () => {
        const result = decide(makeInput({ args: { command: 'git status' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('denies git push in chained command', () => {
        const result = decide(makeInput({ args: { command: 'cd /tmp && git push' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('allows git pull (not push)', () => {
        const result = decide(makeInput({ args: { command: 'git pull origin main' } }), OPTS);
        expect(result.kind).toBe('allow');
      });
    });

    describe('git remote add', () => {
      it('denies git remote add', () => {
        const result = decide(
          makeInput({ args: { command: 'git remote add origin https://github.com/x/y' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('allows git remote -v', () => {
        const result = decide(makeInput({ args: { command: 'git remote -v' } }), OPTS);
        expect(result.kind).toBe('allow');
      });
    });

    describe('git remote set-url', () => {
      it('denies git remote set-url', () => {
        const result = decide(
          makeInput({ args: { command: 'git remote set-url origin https://github.com/x/y' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('allows git remote show', () => {
        const result = decide(
          makeInput({ args: { command: 'git remote show origin' } }),
          OPTS,
        );
        expect(result.kind).toBe('allow');
      });
    });

    describe('npm publish', () => {
      it('denies npm publish', () => {
        const result = decide(makeInput({ args: { command: 'npm publish' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('denies npm publish with flags', () => {
        const result = decide(
          makeInput({ args: { command: 'npm publish --access public' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('allows npm install', () => {
        const result = decide(makeInput({ args: { command: 'npm install express' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows npm test', () => {
        const result = decide(makeInput({ args: { command: 'npm test' } }), OPTS);
        expect(result.kind).toBe('allow');
      });
    });

    describe('curl', () => {
      it('denies curl', () => {
        const result = decide(
          makeInput({ args: { command: 'curl https://example.com' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('denies curl with flags', () => {
        const result = decide(
          makeInput({ args: { command: 'curl -s -o /dev/null https://example.com' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });
    });

    describe('wget', () => {
      it('denies wget', () => {
        const result = decide(
          makeInput({ args: { command: 'wget https://example.com/file.tar.gz' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });
    });

    describe('aws CLI', () => {
      it('denies aws commands', () => {
        const result = decide(makeInput({ args: { command: 'aws s3 ls' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('denies aws in piped command', () => {
        const result = decide(
          makeInput({ args: { command: 'echo test | aws s3 cp - s3://bucket/key' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('does not match aws as substring of another word', () => {
        const result = decide(
          makeInput({ args: { command: 'echo drawing straws' } }),
          OPTS,
        );
        expect(result.kind).toBe('allow');
      });
    });

    describe('gh (GitHub CLI)', () => {
      it('denies gh pr create', () => {
        const result = decide(
          makeInput({ args: { command: 'gh pr create --title "fix"' } }),
          OPTS,
        );
        expect(result.kind).toBe('deny');
      });

      it('denies gh issue create', () => {
        const result = decide(makeInput({ args: { command: 'gh issue create' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('denies gh pr merge', () => {
        const result = decide(makeInput({ args: { command: 'gh pr merge 42' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('denies gh repo create', () => {
        const result = decide(makeInput({ args: { command: 'gh repo create my-repo' } }), OPTS);
        expect(result.kind).toBe('deny');
      });

      it('allows gh pr list (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh pr list' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh pr view (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh pr view 42' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh issue list (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh issue list' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh issue view (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh issue view 9' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh pr status (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh pr status' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh pr checks (read-only)', () => {
        const result = decide(makeInput({ args: { command: 'gh pr checks 42' } }), OPTS);
        expect(result.kind).toBe('allow');
      });

      it('allows gh repo view (read-only)', () => {
        const result = decide(
          makeInput({ args: { command: 'gh repo view owner/repo' } }),
          OPTS,
        );
        expect(result.kind).toBe('allow');
      });
    });

    it('allows safe commands', () => {
      const safeCommands = [
        'ls -la',
        'cat file.txt',
        'echo hello',
        'node index.js',
        'npm test',
        'git diff',
        'git log --oneline',
        'git commit -m "test"',
        'tsc --noEmit',
      ];
      for (const cmd of safeCommands) {
        const result = decide(makeInput({ args: { command: cmd } }), OPTS);
        expect(result.kind).toBe('allow');
      }
    });
  });

  describe('sensitive path access', () => {
    it('denies Read of ~/.ssh/', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: `${HOMEDIR}/.ssh/id_rsa` } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain('~/.ssh');
    });

    it('denies Read of ~/.ssh/ subdirectory', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: `${HOMEDIR}/.ssh/config` } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('denies Read of ~/.aws/', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: `${HOMEDIR}/.aws/credentials` } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain('~/.aws');
    });

    it('denies Read of ~/.config/gh/', () => {
      const result = decide(
        makeInput({
          tool: 'Read',
          args: { file_path: `${HOMEDIR}/.config/gh/hosts.yml` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain('~/.config/gh');
    });

    it('denies Write to ~/.ssh/', () => {
      const result = decide(
        makeInput({
          tool: 'Write',
          args: { file_path: `${HOMEDIR}/.ssh/authorized_keys` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('denies Edit of ~/.aws/', () => {
      const result = decide(
        makeInput({
          tool: 'Edit',
          args: {
            file_path: `${HOMEDIR}/.aws/config`,
            old_string: 'a',
            new_string: 'b',
          },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('denies sensitive paths for lead role too', () => {
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Read',
          args: { file_path: `${HOMEDIR}/.ssh/id_rsa` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });
  });

  describe('.env files', () => {
    it('denies Read of .env outside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: '/other/project/.env' } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain('.env');
    });

    it('denies Read of .env.local outside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: '/other/project/.env.local' } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('denies Read of .env.production outside worktree', () => {
      const result = decide(
        makeInput({
          tool: 'Read',
          args: { file_path: '/other/project/.env.production' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('allows Read of .env inside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: `${WORKTREE}/.env` } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows Read of .env.local inside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: `${WORKTREE}/.env.local` } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows Write of .env inside worktree', () => {
      const result = decide(
        makeInput({
          tool: 'Write',
          args: { file_path: `${WORKTREE}/.env`, content: 'KEY=value' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });
  });

  describe('writes outside worktree', () => {
    it('denies Write outside worktree for worker', () => {
      const result = decide(
        makeInput({ tool: 'Write', args: { file_path: '/etc/passwd' } }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain('Write outside worktree');
    });

    it('denies Write outside worktree for lead', () => {
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Write',
          args: { file_path: '/tmp/outside.txt' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('denies Edit outside worktree', () => {
      const result = decide(
        makeInput({
          tool: 'Edit',
          args: { file_path: '/usr/local/lib/config.js' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('allows Write inside worktree', () => {
      const result = decide(
        makeInput({
          tool: 'Write',
          args: { file_path: `${WORKTREE}/src/new-file.ts` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows Edit inside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Edit', args: { file_path: `${WORKTREE}/package.json` } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('denies lead Write to sibling worktree', () => {
      const siblingPath = '/repo/.workspace/worktrees/agent-2/src/file.ts';
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Write',
          args: { file_path: siblingPath },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });
  });

  describe('reads outside worktree', () => {
    it('denies worker Read outside worktree', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          tool: 'Read',
          args: { file_path: '/other/repo/file.ts' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain(
        'Read outside worktree',
      );
    });

    it('allows worker Read inside worktree', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          tool: 'Read',
          args: { file_path: `${WORKTREE}/src/index.ts` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows lead Read of sibling worktree', () => {
      const siblingPath = '/repo/.workspace/worktrees/agent-2/src/file.ts';
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Read',
          args: { file_path: siblingPath },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('denies lead Read outside workspace worktrees', () => {
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Read',
          args: { file_path: '/completely/different/path.ts' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
      expect((result as { reason: string }).reason).toContain(
        'Read outside workspace worktrees',
      );
    });
  });

  describe('worker inside worktree (destructive ops allowed)', () => {
    it('allows destructive Bash operations inside worktree', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          args: { command: `rm -rf ${WORKTREE}/node_modules` },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows Write of any file inside worktree', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          tool: 'Write',
          args: {
            file_path: `${WORKTREE}/src/destructive.ts`,
            content: '// overwritten',
          },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows Edit of any file inside worktree', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          tool: 'Edit',
          args: {
            file_path: `${WORKTREE}/src/main.ts`,
            old_string: 'old',
            new_string: 'new',
          },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });
  });

  describe('Glob and Grep tools', () => {
    it('allows Glob inside worktree', () => {
      const result = decide(
        makeInput({ tool: 'Glob', args: { pattern: '**/*.ts', path: WORKTREE } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('denies Grep outside worktree for worker', () => {
      const result = decide(
        makeInput({
          paneRole: 'worker',
          tool: 'Grep',
          args: { pattern: 'TODO', path: '/other/repo' },
        }),
        OPTS,
      );
      expect(result.kind).toBe('deny');
    });

    it('allows Glob/Grep with no path (defaults to cwd)', () => {
      const result = decide(
        makeInput({ tool: 'Glob', args: { pattern: '**/*.ts' } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows lead Grep on sibling worktree', () => {
      const siblingPath = '/repo/.workspace/worktrees/agent-2';
      const result = decide(
        makeInput({
          paneRole: 'lead',
          tool: 'Grep',
          args: { pattern: 'export', path: siblingPath },
        }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });
  });

  describe('unknown tools', () => {
    it('allows unknown tools by default', () => {
      const result = decide(
        makeInput({ tool: 'CustomTool', args: { data: 'hello' } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('allows tools without args', () => {
      const result = decide(makeInput({ tool: 'SomeTool', args: null }), OPTS);
      expect(result.kind).toBe('allow');
    });
  });

  describe('edge cases', () => {
    it('handles empty command string', () => {
      const result = decide(makeInput({ args: { command: '' } }), OPTS);
      expect(result.kind).toBe('allow');
    });

    it('handles Read with empty file_path', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: '' } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('handles Write with no file_path key', () => {
      const result = decide(
        makeInput({ tool: 'Write', args: { content: 'test' } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });

    it('handles Read of worktree root itself', () => {
      const result = decide(
        makeInput({ tool: 'Read', args: { file_path: WORKTREE } }),
        OPTS,
      );
      expect(result.kind).toBe('allow');
    });
  });
});

describe('logDecision', () => {
  it('writes NDJSON audit entry for allow decision', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-log-'));
    const logger = createLogger({ logDir, component: 'sandbox', level: 'debug' });

    const input = makeInput({ args: { command: 'git status' } });
    const decision: SandboxDecision = { kind: 'allow' };
    logDecision(logger, 'agent-1', 'ws-1', input, decision);

    const logFile = path.join(logDir, 'sandbox', `${new Date().toISOString().slice(0, 10)}.ndjson`);
    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(content);

    expect(entry.msg).toBe('sandbox.decision');
    expect(entry.paneId).toBe('agent-1');
    expect(entry.workspaceId).toBe('ws-1');
    expect(entry.tool).toBe('Bash');
    expect(entry.outcome).toBe('allow');
    expect(entry.ts).toBeDefined();

    fs.rmSync(logDir, { recursive: true });
  });

  it('writes NDJSON audit entry for deny decision with reason', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-log-'));
    const logger = createLogger({ logDir, component: 'sandbox', level: 'debug' });

    const input = makeInput({ args: { command: 'git push' } });
    const decision: SandboxDecision = {
      kind: 'deny',
      reason: 'git push is not allowed in sandbox',
    };
    logDecision(logger, 'agent-1', 'ws-1', input, decision);

    const logFile = path.join(logDir, 'sandbox', `${new Date().toISOString().slice(0, 10)}.ndjson`);
    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(content);

    expect(entry.outcome).toBe('deny');
    expect(entry.reason).toBe('git push is not allowed in sandbox');

    fs.rmSync(logDir, { recursive: true });
  });
});
