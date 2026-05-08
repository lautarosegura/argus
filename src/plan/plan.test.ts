import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parsePlan,
  serializePlan,
  readPlanFile,
  writePlanFile,
  type PlanTask,
  type Plan,
} from './plan.js';

describe('parsePlan', () => {
  it('parses a plan with YAML frontmatter and body', () => {
    const content = `---
tasks:
  - id: task-1
    assignedTo: agent-2
    dependsOn: []
  - id: task-2
    assignedTo: agent-3
    dependsOn: [task-1]
---

# Refactoring Plan

Split the monolith into two services.
`;

    const plan = parsePlan(content);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]).toEqual({
      id: 'task-1',
      assignedTo: 'agent-2',
      dependsOn: [],
    });
    expect(plan.tasks[1]).toEqual({
      id: 'task-2',
      assignedTo: 'agent-3',
      dependsOn: ['task-1'],
    });
    expect(plan.body).toContain('# Refactoring Plan');
    expect(plan.body).toContain('Split the monolith');
  });

  it('parses a plan with no tasks', () => {
    const content = `---
tasks: []
---

Just a sketch.
`;

    const plan = parsePlan(content);
    expect(plan.tasks).toEqual([]);
    expect(plan.body).toContain('Just a sketch');
  });

  it('parses a plan with a single task having multiple dependencies', () => {
    const content = `---
tasks:
  - id: final
    assignedTo: agent-4
    dependsOn: [task-1, task-2, task-3]
---

Merge step.
`;

    const plan = parsePlan(content);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].dependsOn).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('throws on content with no frontmatter', () => {
    expect(() => parsePlan('# Just a heading\n\nNo frontmatter here.')).toThrow(
      /frontmatter/i,
    );
  });

  it('throws on frontmatter with no tasks key', () => {
    const content = `---
title: Missing tasks
---

Body.
`;
    expect(() => parsePlan(content)).toThrow(/tasks/i);
  });

  it('throws on task missing id', () => {
    const content = `---
tasks:
  - assignedTo: agent-2
    dependsOn: []
---

Body.
`;
    expect(() => parsePlan(content)).toThrow(/id/i);
  });

  it('throws on task missing assignedTo', () => {
    const content = `---
tasks:
  - id: task-1
    dependsOn: []
---

Body.
`;
    expect(() => parsePlan(content)).toThrow(/assignedTo/i);
  });

  it('parses task with dependsOn omitted as empty array', () => {
    const content = `---
tasks:
  - id: task-1
    assignedTo: agent-2
---

Body.
`;
    const plan = parsePlan(content);
    expect(plan.tasks[0].dependsOn).toEqual([]);
  });
});

describe('serializePlan', () => {
  it('round-trips through parse and serialize', () => {
    const original: Plan = {
      tasks: [
        { id: 'task-1', assignedTo: 'agent-2', dependsOn: [] },
        { id: 'task-2', assignedTo: 'agent-3', dependsOn: ['task-1'] },
      ],
      body: '# The Plan\n\nDo the thing.\n',
    };

    const serialized = serializePlan(original);
    const parsed = parsePlan(serialized);
    expect(parsed.tasks).toEqual(original.tasks);
    expect(parsed.body.trim()).toBe(original.body.trim());
  });

  it('serializes empty tasks', () => {
    const plan: Plan = { tasks: [], body: 'Notes only.\n' };
    const serialized = serializePlan(plan);
    expect(serialized).toContain('tasks: []');
    expect(serialized).toContain('Notes only.');
  });
});

describe('plan file I/O', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writePlanFile writes atomically and readPlanFile reads back', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    const content = `---
tasks:
  - id: task-1
    assignedTo: agent-2
    dependsOn: []
---

# Plan

Do stuff.
`;
    writePlanFile(planPath, content);
    expect(fs.existsSync(planPath)).toBe(true);

    const read = readPlanFile(planPath);
    expect(read).toBe(content);
  });

  it('writePlanFile creates parent directories', () => {
    const planPath = path.join(tmpDir, '.workspace', 'plan.md');
    writePlanFile(planPath, 'content');
    expect(fs.existsSync(planPath)).toBe(true);
  });

  it('readPlanFile returns null for non-existent file', () => {
    const result = readPlanFile(path.join(tmpDir, 'missing.md'));
    expect(result).toBeNull();
  });

  it('no .tmp files remain after write', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    writePlanFile(planPath, 'content');
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
