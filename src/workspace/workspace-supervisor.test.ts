import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspaceSupervisor, type WorkspaceSupervisor } from './workspace-supervisor.js';

let supervisor: WorkspaceSupervisor | null = null;

afterEach(async () => {
  if (supervisor) {
    await supervisor.stopAll();
    supervisor = null;
  }
});

describe('workspace-supervisor', () => {
  it('spawn starts a child process and reports it as running', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-1');

    expect(supervisor.isRunning('ws-1')).toBe(true);
    expect(supervisor.runningIds()).toEqual(['ws-1']);
  });

  it('spawn multiple workspaces independently', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-a');
    await supervisor.spawn('ws-b');

    expect(supervisor.isRunning('ws-a')).toBe(true);
    expect(supervisor.isRunning('ws-b')).toBe(true);
    expect(supervisor.runningIds().sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('stop terminates a specific workspace child', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-1');
    await supervisor.stop('ws-1');

    expect(supervisor.isRunning('ws-1')).toBe(false);
    expect(supervisor.runningIds()).toEqual([]);
  });

  it('killing one workspace-child does not affect another', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-a');
    await supervisor.spawn('ws-b');

    await supervisor.stop('ws-a');

    expect(supervisor.isRunning('ws-a')).toBe(false);
    expect(supervisor.isRunning('ws-b')).toBe(true);
  });

  it('stopAll terminates all children', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-1');
    await supervisor.spawn('ws-2');

    await supervisor.stopAll();

    expect(supervisor.runningIds()).toEqual([]);
  });

  it('spawn rejects duplicate workspace id', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-dup');

    await expect(supervisor.spawn('ws-dup')).rejects.toThrow(/already running/);
  });

  it('crash of workspace-child is detected and cleaned up', async () => {
    supervisor = createWorkspaceSupervisor();
    await supervisor.spawn('ws-crash');

    const exitPromise = new Promise<{ id: string; code: number | null }>((resolve) => {
      supervisor!.onExit((id, code) => resolve({ id, code }));
    });

    supervisor.kill('ws-crash');

    const result = await exitPromise;
    expect(result.id).toBe('ws-crash');
    expect(supervisor.isRunning('ws-crash')).toBe(false);
  });
});
