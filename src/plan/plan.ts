import fs from 'node:fs';
import path from 'node:path';

export interface PlanTask {
  id: string;
  assignedTo: string;
  dependsOn: string[];
}

export interface Plan {
  tasks: PlanTask[];
  body: string;
}

function extractFrontmatter(content: string): { yaml: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('Plan must contain YAML frontmatter delimited by ---');
  }
  return { yaml: match[1], body: match[2] };
}

function parseYamlArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  const inner = trimmed.slice(1, -1);
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

function assignProp(target: Partial<PlanTask>, key: string, value: string): void {
  if (key === 'dependsOn') {
    target.dependsOn = parseYamlArray(value);
  } else if (key === 'id') {
    target.id = value;
  } else if (key === 'assignedTo') {
    target.assignedTo = value;
  }
}

function parseTasksFromYaml(yaml: string): PlanTask[] {
  const lines = yaml.split('\n');
  let foundTasks = false;
  let tasksIsEmpty = false;

  const tasks: PlanTask[] = [];
  let current: Partial<PlanTask> | null = null;

  for (const line of lines) {
    if (line.match(/^tasks:\s*\[\]\s*$/)) {
      foundTasks = true;
      tasksIsEmpty = true;
      break;
    }
    if (line.match(/^tasks:\s*$/)) {
      foundTasks = true;
      continue;
    }
    if (!foundTasks) continue;

    const itemMatch = line.match(/^\s+-\s+(\w+):\s*(.*)$/);
    const propMatch = line.match(/^\s+(\w+):\s*(.*)$/);

    if (itemMatch) {
      if (current) {
        tasks.push(validateTask(current));
      }
      current = {};
      assignProp(current, itemMatch[1], itemMatch[2]);
    } else if (propMatch && current) {
      assignProp(current, propMatch[1], propMatch[2]);
    }
  }

  if (!foundTasks) {
    throw new Error('Plan frontmatter must contain a "tasks" key');
  }

  if (current) {
    tasks.push(validateTask(current));
  }

  return tasks;
}

function validateTask(partial: Partial<PlanTask>): PlanTask {
  if (!partial.id) {
    throw new Error('Each plan task must have an "id" field');
  }
  if (!partial.assignedTo) {
    throw new Error('Each plan task must have an "assignedTo" field');
  }
  return {
    id: partial.id,
    assignedTo: partial.assignedTo,
    dependsOn: (partial.dependsOn as unknown as string[] | undefined) ?? [],
  };
}

export function parsePlan(content: string): Plan {
  const { yaml, body } = extractFrontmatter(content);
  const tasks = parseTasksFromYaml(yaml);
  return { tasks, body };
}

export function serializePlan(plan: Plan): string {
  let yaml = '';
  if (plan.tasks.length === 0) {
    yaml = 'tasks: []';
  } else {
    yaml = 'tasks:';
    for (const task of plan.tasks) {
      const deps = task.dependsOn.length === 0
        ? '[]'
        : `[${task.dependsOn.join(', ')}]`;
      yaml += `\n  - id: ${task.id}\n    assignedTo: ${task.assignedTo}\n    dependsOn: ${deps}`;
    }
  }
  return `---\n${yaml}\n---\n\n${plan.body}`;
}

export function writePlanFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

export function readPlanFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
