# Argus

Argus is a Windows-first dev tool that orchestrates multiple CLI AI agents in parallel inside a single project, each running in its own isolated git worktree. A standalone daemon owns the orchestration; CLI and GUI are thin clients on top of it.

## Language

### Engine

**argusd**:
The standalone Node daemon that owns all PTYs, adapters, plans, and merge state. The brain of Argus, lazy-launched and surviving the GUI's lifecycle.
_Avoid_: server, service, backend

**Workspace**:
A single orchestrated effort: one plan, a grid of panes, and the worktrees they live in. The user's unit of work.
_Avoid_: project, session, run

**Workspace-child**:
The Node subprocess `argusd` forks per active **Workspace**, owning its PTYs, adapters, and in-memory state. Crashing one does not affect others.
_Avoid_: worker (collides with **Worker pane**), runner

**Argus desktop app**:
The Electron GUI. A thin client of **argusd**; closing it does not kill any **Workspace**. Renders the grid via xterm.js.
_Avoid_: Argus app, the GUI (only colloquially)

**Workspace CLI**:
The `workspace` binary present in every **Worktree**'s PATH. A thin client of **argusd** used by agents from inside their worktree to emit **Sentinel commands**.
_Avoid_: argus-cli, workspace-cmd

### Grid and panes

**Pane**:
One cell in the grid of a **Workspace**. Owns one PTY to one CLI agent process running in one **Worktree**.
_Avoid_: tile, cell, terminal

**Lead pane**:
The single **Pane** that orchestrates the others. Runs Claude Code with an orchestrator system prompt. Talks to **Worker panes** via the `send-to-pane` primitive.
_Avoid_: orchestrator pane, master pane

**Worker pane**:
A non-lead **Pane** assigned a single task from the **Plan**. Escalates to the human (not auto-reassigned) when blocked.
_Avoid_: child pane, agent pane

### Filesystem

**Worktree**:
A git worktree at `.workspace/worktrees/agent-N/`, exclusively owned by one **Pane**. The unit of filesystem isolation between agents.
_Avoid_: workdir, sandbox, copy

**Plan**:
The approved task split, persisted at `.workspace/plan.md`. Authored by the **Lead pane** via propose-and-approve and edited by the human before execution.
_Avoid_: tasks, blueprint, spec

**Merge log**:
The record of auto-resolutions made by the **Merge agent**, persisted at `.workspace/merge-log.md`. Used for human ratification post-merge.
_Avoid_: resolution log, merge report

### Protocol

**Adapter**:
The per-CLI module that normalizes a specific agent's output (Claude Code, Codex, etc.) into the engine's internal event vocabulary. Lives in-process inside its **Workspace-child**.
_Avoid_: parser, plugin, driver

**ACP** (Agent Client Protocol):
The emerging open standard Argus uses as its internal lingua franca. Each **Adapter** translates its CLI's dialect to ACP-style events.
_Avoid_: protocol, schema

**Sentinel command**:
A command an agent issues from inside its **Worktree** to signal lifecycle events to the **Lead pane** via **argusd**. The three sentinels are `workspace done`, `workspace blocked`, and `workspace status`.
_Avoid_: signal, hook, callback

**Merge agent**:
An ephemeral process spawned at merge time that performs serial integration of **Worker pane** branches into `main`, with auto-resolve, post-merge tests, and auto-revert on failure. Has its own ephemeral pane in the GUI.
_Avoid_: merge bot, integrator

## Relationships

- An **argusd** instance owns zero or more **Workspaces**, one **Workspace-child** per active **Workspace**.
- A **Workspace** has exactly one **Plan**, one **Lead pane**, and zero or more **Worker panes**.
- Each **Pane** owns exactly one **Worktree** and exactly one CLI agent process.
- Each **Pane** is read by exactly one **Adapter** matching its CLI type.
- Each **Worktree** has the **Workspace CLI** in its PATH.
- The **Argus desktop app** and the **Workspace CLI** are both clients of **argusd**; neither owns state.
- A **Merge agent** is spawned by a **Workspace-child** when the human approves the merge; it dies when merge completes or is reverted.

## Example dialogue

> **Dev:** "If the user closes the Argus desktop app while a worker is mid-task, what happens?"
> **Designer:** "Nothing happens to the work. The **Argus desktop app** is just a client — it dies, but **argusd** keeps running, the **Workspace-child** keeps running, the **Worker pane**'s PTY stays open, and the agent keeps working. When the user opens Argus again, the GUI re-attaches and re-paints the grid from argusd's state."
>
> **Dev:** "And what's the difference between a Worker pane and a Workspace-child? They both sound like 'a worker'."
> **Designer:** "A **Worker pane** is a product concept — one tile in the grid, one agent doing one task. A **Workspace-child** is a process — `argusd` forks one per active **Workspace**, and that one process owns all 9 panes (1 lead + 8 workers) of that workspace. So 3 open workspaces means 3 workspace-children, each containing 9 panes."

## Flagged ambiguities

- **"worker"** is overloaded. Resolved: **Worker pane** for the product concept (a non-lead tile in the grid), **Workspace-child** for the per-workspace Node subprocess. Never use bare "worker" in code or docs.
- **"agent"** is overloaded between (a) the CLI process Argus spawns (`claude`, `codex`), (b) the AI model inside it, and (c) the **Merge agent**. Resolved: prefer **CLI agent** for (a), let context disambiguate (b), and always use the full **Merge agent** for (c).
- **"workspace"** can mean the abstract concept or the on-disk directory. Resolved: capital-W **Workspace** for the concept, lowercase `.workspace/` for the directory.
