import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceRegistry, type WorkspaceRegistry } from './workspace-registry.js';
import { CURRENT_SCHEMA_VERSION, type WorkspaceState } from './workspace-types.js';

let tmpDir: string;
let registry: WorkspaceRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-reg-test-'));
  registry = createWorkspaceRegistry(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workspace-registry CRUD', () => {
  it('create returns a workspace with the correct shape', async () => {
    const result = await registry.create({
      name: 'demo',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/some-repo',
    });

    expect(result.id).toBe('demo');
    expect(result.name).toBe('demo');
    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.repoPath).toBe('/tmp/some-repo');
    expect(result.agentRatio).toEqual([{ cli: 'claude', count: 1 }]);
    expect(result.panes).toEqual([]);
    expect(result.plan).toBeNull();
    expect(result.mergeState).toBeNull();
    expect(typeof result.createdAt).toBe('string');
  });

  it('create persists a state file to disk', async () => {
    await registry.create({
      name: 'demo',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/some-repo',
    });

    const filePath = path.join(tmpDir, 'demo.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkspaceState;
    expect(raw.id).toBe('demo');
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('create with plan sets the plan field', async () => {
    const result = await registry.create({
      name: 'with-plan',
      agentRatio: [{ cli: 'claude', count: 2 }],
      repoPath: '/tmp/repo',
      plan: '.workspace/plan.md',
    });

    expect(result.plan).toEqual({ path: '.workspace/plan.md', approvedAt: null });
  });

  it('create rejects duplicate workspace names', async () => {
    await registry.create({
      name: 'dup',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    await expect(
      registry.create({
        name: 'dup',
        agentRatio: [{ cli: 'claude', count: 1 }],
        repoPath: '/tmp/repo',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('list returns all workspaces as summaries', async () => {
    await registry.create({
      name: 'ws-a',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo-a',
    });
    await registry.create({
      name: 'ws-b',
      agentRatio: [{ cli: 'codex', count: 3 }],
      repoPath: '/tmp/repo-b',
    });

    const list = await registry.list();
    expect(list).toHaveLength(2);

    const names = list.map((w) => w.name).sort();
    expect(names).toEqual(['ws-a', 'ws-b']);

    const wsB = list.find((w) => w.name === 'ws-b')!;
    expect(wsB.paneCount).toBe(0);
    expect(wsB.agentRatio).toEqual([{ cli: 'codex', count: 3 }]);
  });

  it('list returns empty array when no workspaces exist', async () => {
    const list = await registry.list();
    expect(list).toEqual([]);
  });

  it('get returns the full workspace state', async () => {
    await registry.create({
      name: 'full',
      agentRatio: [{ cli: 'claude', count: 2 }],
      repoPath: '/tmp/full-repo',
    });

    const ws = await registry.get('full');
    expect(ws.id).toBe('full');
    expect(ws.name).toBe('full');
    expect(ws.repoPath).toBe('/tmp/full-repo');
    expect(ws.panes).toEqual([]);
  });

  it('get throws for non-existent workspace', async () => {
    await expect(registry.get('nonexistent')).rejects.toThrow(/not found/i);
  });

  it('delete removes the state file', async () => {
    await registry.create({
      name: 'to-delete',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    await registry.delete('to-delete');

    const filePath = path.join(tmpDir, 'to-delete.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('delete throws for non-existent workspace', async () => {
    await expect(registry.delete('ghost')).rejects.toThrow(/not found/i);
  });

  it('list excludes deleted workspaces', async () => {
    await registry.create({
      name: 'keep',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });
    await registry.create({
      name: 'remove',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    await registry.delete('remove');

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('keep');
  });
});

describe('workspace-registry atomic write', () => {
  it('state file is valid JSON after write (not partial)', async () => {
    await registry.create({
      name: 'atomic',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    const filePath = path.join(tmpDir, 'atomic.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();

    const parsed = JSON.parse(content) as WorkspaceState;
    expect(parsed.id).toBe('atomic');
  });

  it('no tmp files remain after successful write', async () => {
    await registry.create({
      name: 'clean',
      agentRatio: [{ cli: 'claude', count: 1 }],
      repoPath: '/tmp/repo',
    });

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('workspace-registry schema migration', () => {
  it('reads a state file with current schemaVersion', async () => {
    const state: WorkspaceState = {
      schemaVersion: 1,
      id: 'migrated',
      name: 'migrated',
      createdAt: new Date().toISOString(),
      repoPath: '/tmp/repo',
      intent: '',
      agentRatio: [{ cli: 'claude', count: 1 }],
      panes: [],
      plan: null,
      mergeState: null,
    };

    fs.writeFileSync(path.join(tmpDir, 'migrated.json'), JSON.stringify(state));

    const ws = await registry.get('migrated');
    expect(ws.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(ws.id).toBe('migrated');
  });

  it('migrates an older schemaVersion (no-op for v0.1, but code path triggers)', async () => {
    const oldState = {
      schemaVersion: 0,
      id: 'old-schema',
      name: 'old-schema',
      createdAt: new Date().toISOString(),
      repoPath: '/tmp/repo',
      agentRatio: [{ cli: 'claude', count: 1 }],
      panes: [],
      plan: null,
      mergeState: null,
    };

    fs.writeFileSync(path.join(tmpDir, 'old-schema.json'), JSON.stringify(oldState));

    const ws = await registry.get('old-schema');
    expect(ws.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'old-schema.json'), 'utf-8'),
    ) as WorkspaceState;
    expect(onDisk.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});
