import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SubAgentResolver, SubAgentResolveRequest, SubAgentResolveResult } from './merge-runner.js';

function buildResolutionPrompt(repoPath: string, conflictFiles: string[], branch: string): string {
  const fileContents = conflictFiles.map((file) => {
    const filePath = path.join(repoPath, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    return `### ${file}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');

  return [
    `You are resolving a git merge conflict on branch "${branch}".`,
    'The following files have conflict markers (<<<<<<< / ======= / >>>>>>>).',
    'Resolve each conflict by choosing the correct version or combining them.',
    'Write ONLY the resolved file content to each file path. Do not add any other files.',
    '',
    fileContents,
  ].join('\n');
}

function hasConflictMarkers(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.includes('<<<<<<<') || content.includes('>>>>>>>');
  } catch {
    return true;
  }
}

export interface SubAgentSpawnerOptions {
  cli: 'claude' | 'codex';
}

export function createSubAgentResolver(opts: SubAgentSpawnerOptions): SubAgentResolver {
  let nextId = 1;

  return async (
    req: SubAgentResolveRequest,
    onProgress: (subAgentId: string, detail: string) => void,
  ): Promise<SubAgentResolveResult> => {
    const subAgentId = `merge-sub-${nextId++}`;
    const prompt = buildResolutionPrompt(req.repoPath, req.conflictFiles, req.branch);

    onProgress(subAgentId, `Spawning ${opts.cli} to resolve ${req.conflictFiles.join(', ')}`);

    const cliArgs = opts.cli === 'claude'
      ? ['-p', prompt, '--output-format', 'stream-json']
      : ['exec', prompt, '--json'];

    return new Promise<SubAgentResolveResult>((resolve) => {
      const proc: ChildProcess = execFile(opts.cli, cliArgs, {
        cwd: req.repoPath,
        env: {
          ...process.env,
          ARGUS_SUB_AGENT: '1',
        },
      }, () => {
        const resolvedFiles = req.conflictFiles.filter(
          (file) => !hasConflictMarkers(path.join(req.repoPath, file)),
        );

        const allResolved = resolvedFiles.length === req.conflictFiles.length;

        onProgress(subAgentId, allResolved
          ? `Resolved: ${resolvedFiles.join(', ')}`
          : `Failed to resolve all conflicts`,
        );

        resolve({
          resolved: allResolved,
          resolvedFiles,
          subAgentId,
          cli: opts.cli,
        });
      });

      proc.on('error', () => {
        resolve({
          resolved: false,
          resolvedFiles: [],
          subAgentId,
          cli: opts.cli,
        });
      });
    });
  };
}
