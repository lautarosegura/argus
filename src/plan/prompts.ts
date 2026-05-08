import type { Plan, PlanTask } from './plan.js';

export interface PromptContext {
  workspaceName: string;
  repoPath: string;
  intent: string;
}

export interface WorkerPromptContext extends PromptContext {
  plan: Plan;
  taskId: string;
  paneId: string;
}

function formatTaskTable(tasks: PlanTask[]): string {
  if (tasks.length === 0) return '(no tasks defined)';
  return tasks.map((t) => {
    const deps = t.dependsOn.length > 0 ? t.dependsOn.join(', ') : 'none';
    return `- ${t.id} → ${t.assignedTo} (depends on: ${deps})`;
  }).join('\n');
}

export function buildLeadPrompt(ctx: PromptContext): string {
  return `You are the Lead orchestrator for workspace "${ctx.workspaceName}".

## Your Goal

The human wants: ${ctx.intent}

Repository: ${ctx.repoPath}

## Your Job

Analyze the codebase and produce a plan that breaks this goal into parallel tasks for Worker agents. Write the plan to \`.workspace/plan.md\`.

## Plan Format

The plan file uses markdown with a YAML frontmatter block. The frontmatter declares tasks with their dependencies and merge order:

\`\`\`
---
tasks:
  - id: task-1
    assignedTo: agent-2
    dependsOn: []
  - id: task-2
    assignedTo: agent-3
    dependsOn: [task-1]
---

# Plan Title

Free-form description of the approach, rationale, and any notes for workers.
Each task should be described in detail in the body so workers understand their scope.
\`\`\`

## Rules

1. Each task \`id\` must be unique.
2. \`assignedTo\` must reference a valid worker pane (agent-2, agent-3, etc.).
3. \`dependsOn\` expresses merge order — tasks that depend on others will be merged after their dependencies. Use this to prevent semantic conflicts.
4. Keep tasks as independent as possible to maximize parallelism.
5. The body should describe each task in enough detail that a worker can execute without further clarification.
6. After writing the plan, signal done with \`workspace done --summary "Plan proposed"\`.
`;
}

export function buildWorkerPrompt(ctx: WorkerPromptContext): string {
  const task = ctx.plan.tasks.find((t) => t.id === ctx.taskId);
  const deps = task?.dependsOn ?? [];
  const depsNote = deps.length > 0
    ? `This task depends on: ${deps.join(', ')}. Those tasks must complete and merge before yours.`
    : 'This task has no dependencies — you can start immediately.';

  return `You are a Worker agent (${ctx.paneId}) in workspace "${ctx.workspaceName}".

## Your Assigned Task

Task ID: ${ctx.taskId}
${depsNote}

## Full Plan

All tasks in this workspace:
${formatTaskTable(ctx.plan.tasks)}

---

${ctx.plan.body}

## Rules

1. Only work on your assigned task (${ctx.taskId}).
2. Work within your worktree branch — do not modify files outside your worktree.
3. When done, signal completion with \`workspace done --summary "<what you did>"\`.
4. If blocked, signal with \`workspace blocked <reason>\`.
`;
}
