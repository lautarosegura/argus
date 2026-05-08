import { describe, it, expect } from 'vitest';
import { buildLeadPrompt, buildWorkerPrompt, type PromptContext } from './prompts.js';
import type { Plan } from './plan.js';

const BASE_CTX: PromptContext = {
  workspaceName: 'refactor-auth',
  repoPath: '/home/user/projects/myapp',
  intent: 'Split the auth module into microservices',
};

const SAMPLE_PLAN: Plan = {
  tasks: [
    { id: 'task-1', assignedTo: 'agent-2', dependsOn: [] },
    { id: 'task-2', assignedTo: 'agent-3', dependsOn: ['task-1'] },
  ],
  body: '# Auth Refactoring\n\nSplit auth into identity and session services.\n',
};

describe('buildLeadPrompt', () => {
  it('includes the workspace name', () => {
    const prompt = buildLeadPrompt(BASE_CTX);
    expect(prompt).toContain('refactor-auth');
  });

  it('includes the human intent', () => {
    const prompt = buildLeadPrompt(BASE_CTX);
    expect(prompt).toContain('Split the auth module into microservices');
  });

  it('instructs to write plan.md', () => {
    const prompt = buildLeadPrompt(BASE_CTX);
    expect(prompt).toContain('.workspace/plan.md');
  });

  it('explains the YAML frontmatter task format', () => {
    const prompt = buildLeadPrompt(BASE_CTX);
    expect(prompt).toContain('tasks:');
    expect(prompt).toContain('assignedTo');
    expect(prompt).toContain('dependsOn');
  });

  it('mentions merge order', () => {
    const prompt = buildLeadPrompt(BASE_CTX);
    expect(prompt).toMatch(/merge.*order|depend/i);
  });
});

describe('buildWorkerPrompt', () => {
  it('includes the full plan body', () => {
    const prompt = buildWorkerPrompt({
      ...BASE_CTX,
      plan: SAMPLE_PLAN,
      taskId: 'task-1',
      paneId: 'agent-2',
    });
    expect(prompt).toContain('Auth Refactoring');
    expect(prompt).toContain('Split auth into identity and session services');
  });

  it('includes the assigned task id', () => {
    const prompt = buildWorkerPrompt({
      ...BASE_CTX,
      plan: SAMPLE_PLAN,
      taskId: 'task-1',
      paneId: 'agent-2',
    });
    expect(prompt).toContain('task-1');
  });

  it('includes dependency information', () => {
    const prompt = buildWorkerPrompt({
      ...BASE_CTX,
      plan: SAMPLE_PLAN,
      taskId: 'task-2',
      paneId: 'agent-3',
    });
    expect(prompt).toContain('task-1');
    expect(prompt).toMatch(/depends|depend/i);
  });

  it('includes workspace name and repo path', () => {
    const prompt = buildWorkerPrompt({
      ...BASE_CTX,
      plan: SAMPLE_PLAN,
      taskId: 'task-1',
      paneId: 'agent-2',
    });
    expect(prompt).toContain('refactor-auth');
  });

  it('includes all tasks for full plan context', () => {
    const prompt = buildWorkerPrompt({
      ...BASE_CTX,
      plan: SAMPLE_PLAN,
      taskId: 'task-1',
      paneId: 'agent-2',
    });
    expect(prompt).toContain('task-2');
  });
});
