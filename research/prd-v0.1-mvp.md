# Argus v0.1 — Engine + GUI MVP (PRD)

> Draft for publication to GitHub Issues with the `ready-for-agent` label.
> Self-contained but builds on `research/foundations.md`, `research/architecture-decisions-v1.md`, and `CONTEXT.md`.

## Problem Statement

I orchestrate multiple CLI AI agents in parallel today by manually opening five Windows Terminal panes side-by-side. The agents don't know about each other, they fight over the same files, I can't tell from a glance whether a pane is thinking, blocked, or done, and integrating their work back to `main` is a manual merge-conflict slog. When I have a parallelizable idea — say, a refactor split into eight independent slices — I cannot exploit that parallelism without paying a tax that exceeds the speedup. I need a tool that turns "8 things at once" into something I actually want to do.

## Solution

Argus is a Windows-first dev tool that orchestrates multiple **CLI agents** in parallel, each running in its own isolated **Worktree**, coordinated by a single **Lead pane** whose job is to drive the **Worker panes** through a **Plan** the human approved. A standalone daemon (**argusd**) owns the orchestration; the **Argus desktop app** is a thin GUI client over that daemon, and a **Workspace CLI** lets agents emit **Sentinel commands** from inside their worktrees. When the work is done, the **Merge agent** integrates everything back to `main` serially, auto-resolving where it can, escalating where it can't, with `git` tags as recovery anchors and tests as the final gate.

The user opens Argus, types `argus init my-feature --agents 1xclaude,4xclaude,3xcodex` (or uses the GUI), watches a 3×3 grid of agents work, approves the plan when the lead proposes one, and clicks Merge when everything is `done`. Argus survives closing the GUI window, surviving sleep/wake, and surviving a daemon crash via intent-only persisted state.

## User Stories

### Engine lifecycle and discovery

1. As a developer, I want **argusd** to start automatically the first time I run `argus init` or open the **Argus desktop app**, so that I don't have to manage a service manually.
2. As a developer, I want **argusd** to keep running after I close the **Argus desktop app**, so that my agents keep working even if I close the window by accident.
3. As a developer, I want **argusd** to shut itself down 30 minutes after the last **Workspace** has no live PTYs, so that it doesn't sit in the background consuming resources I'm not using.
4. As a developer, I want **argusd** to use a single **named pipe** (`\\.\pipe\argus-${user}` by default, overridable via `ARGUS_PIPE`), so that I can run a dev build and a stable build side-by-side without collisions.
5. As a developer, I want a **Workspace** that's mid-work when I close my laptop and reopen it later to either resume cleanly or surface a clear "merge interrupted, resume or revert?" prompt, so that nothing is silently lost.
6. As a developer, I want `argus daemon-status` to tell me whether **argusd** is running, its version, uptime, and active **Workspace** count, so that I can debug "is the brain alive?" in one command.

### Workspace creation and lifecycle

7. As a developer, I want to create a **Workspace** from the CLI with `argus init <name> --agents <ratio> [--repo <path>]`, so that I can launch a swarm without leaving the terminal.
8. As a developer, I want to create a **Workspace** from the **Argus desktop app** via a small modal with a CLI-editable command, so that GUI use and CLI use produce identical results.
9. As a developer, I want each new **Worker pane** to spawn its **CLI agent** (Claude Code or Codex in v0.1) inside its own **Worktree** at `.workspace/worktrees/agent-N/`, so that no two panes can fight over the same file.
10. As a developer, I want each **Worktree** to be on a branch named `workspace/<plan-id>/<worker-id>`, so that I can filter and bulk-clean Argus branches without accidentally touching my real work.
11. As a developer, I want the contents of `.workspace/` to be gitignored automatically, so that Argus state never leaks into a commit.
12. As a developer, I want `argus list` to show every existing **Workspace** with its current state, so that I can context-switch between several in flight.
13. As a developer, I want `argus open <name>` to focus or relaunch the GUI on a specific **Workspace**, so that a CLI gesture and a GUI gesture compose.
14. As a developer, I want `argus clean <name>` to remove a **Workspace**'s worktrees, branches, and state file in a single command (with confirmation), so that my repo doesn't accumulate stale `.workspace/worktrees/agent-N/` directories forever.

### Plan flow

15. As a developer, I want the **Lead pane** to propose a **Plan** based on my high-level intent, written to `.workspace/plan.md`, so that I have a tangible artifact to edit before any work begins.
16. As a developer, I want to edit the **Plan** in the GUI (or in my editor of choice — it's just a markdown file) before approving it, so that the architectural decisions stay with me.
17. As a developer, I want to click "Approve Plan" and have each **Worker pane** receive its assigned task plus the full plan via the CLI's system prompt, so that workers don't need cross-worktree filesystem access to coordinate.
18. As a developer, I want the **Plan** to express dependencies and a merge order, so that workers that conflict semantically run in the right sequence and the **Merge agent** integrates them in the right order.

### Pane state and observability

19. As a developer, I want each pane to display a clear badge (`idle | thinking | toolUse | waitingPerm | done | blocked | dead`), so that at a glance I know which panes need my attention.
20. As a developer, I want raw **CLI agent** output to render in the pane via xterm.js byte-perfect (escape sequences, ANSI colors), so that the agent's output looks identical to running it in my terminal.
21. As a developer, I want the **Lead pane** to be visually distinguished from **Worker panes**, so that I never confuse the orchestrator with a worker.
22. As a developer, I want a single notification stream from **argusd** (`pane.event`) that wraps every `AdapterEvent`, so that any client (GUI, future TUI, future plugin) consumes the same vocabulary.

### Sentinel commands

23. As an agent inside a **Worktree**, I want `workspace done [--summary X] [--needs-review]` available in my PATH, so that I can definitively signal completion without relying on my prose being parsed.
24. As an agent inside a **Worktree**, I want `workspace blocked <reason>` to escalate to the human cleanly, so that I don't get auto-reassigned and I don't silently spin forever.
25. As an agent inside a **Worktree**, I want `workspace status <text>` to emit progress updates that show in the **Lead pane**, so that the orchestrator (and the human) can see what I'm working on.
26. As a developer, I want the **Workspace CLI** binary to discover **argusd** via `ARGUS_PIPE` env var first and fall back to the default pipe, so that one Argus install can run the daemon and a dev build of Argus can spawn agents that report to a different daemon.

### Sandbox

27. As a developer, I want **argusd** to intercept dangerous tool calls from any **Worker pane** (`git push`, `curl`, `wget`, `npm publish`, `gh`, `aws`, reads of `~/.ssh`, `.env`, `~/.aws`), so that I can trust an agent without it accidentally pushing branches to origin or exfiltrating credentials.
28. As a developer, I want intra-worktree operations (`rm`, force-push of the worker's own branch) to be allowed without interception, so that the agent can iterate freely on its disposable workspace.
29. As a developer, I want every sandbox decision (allow or block) logged in NDJSON for later audit, so that I can trace why an agent failed to do something or what it tried.
30. As a developer, I want the **Lead pane** to be allowed to read other worktrees but not write to them, so that it can inspect progress without contaminating workers.

### Merge flow

31. As a developer, I want a `workspace-pre-merge-<timestamp>` git tag created on `main` before any merge attempt, so that I have a clean revert anchor.
32. As a developer, I want each **Worker pane**'s branch merged serially in the order specified by the **Plan**, so that semantic dependencies surface in a predictable sequence.
33. As a developer, I want trivial git conflicts auto-resolved and semantic conflicts attempted via a sub-agent with constrained context, so that I'm not the bottleneck for routine integrations.
34. As a developer, I want every auto-resolution decision recorded in `.workspace/merge-log.md`, so that I can ratify them after the fact rather than approve each one in real time.
35. As a developer, I want `npm test` (or a configured `verify_command`) to run after the full merge, with auto-revert to the pre-merge tag if it fails, so that a green main is preserved by construction.
36. As a developer, I want the **Merge agent** to appear as its own ephemeral pane in the GUI with phase indicators (`tagging | merging | resolving | testing | complete | reverted`), so that I can see what it's doing in real time.
37. As a developer, I want to cancel an in-flight merge via `merge.cancel` (GUI button or CLI), with automatic revert, so that I'm never trapped in a merge gone wrong.
38. As a developer, I want a merge interrupted by a daemon crash to surface a "resume or revert" prompt at the next launch, so that recovery is explicit rather than silent.

### Recovery

39. As a developer, I want **argusd** to persist intent-only state per **Workspace** (`schemaVersion`, agent ratio, pane assignments, plan reference, merge state — but no PIDs or handles), so that recovery after a crash is a deterministic relaunch rather than a guess.
40. As a developer, I want a pane I explicitly closed (`userClosed: true`) to stay closed across restarts, so that recovery doesn't fight my decisions.
41. As a developer, I want `lastKnownState` in `state.json` used only as a hint for first paint, so that the authoritative state always comes from a fresh **Adapter** run.

### Auth and prerequisites

42. As a developer, I want Argus to assume each **CLI agent** is already authenticated the standard way (`claude login`, `codex login`, etc.), so that Argus is not in the secret-management business.
43. As a developer, I want **argusd** to spawn each **CLI agent** with a clean env (no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` injected by Argus, only the env that lets the CLI find its own credential cache), so that agents can't see secrets I didn't intend.
44. As a developer, I want `argus doctor` to verify each configured CLI is in PATH, can report a version without auth error, and the daemon pipe is reachable, so that "why can't I start a workspace?" has a one-command answer.

### Logs and metrics

45. As a developer, I want NDJSON logs at `%LOCALAPPDATA%\Argus\logs\` split per process (daemon, per-workspace-child, per-pane stderr), with daily rotation and 14-day retention, so that I can investigate a problem without drowning in noise.
46. As a developer, I want `argus logs --follow [--workspace X] [--level debug]` to tail the right file, so that I don't have to remember the directory structure.
47. As a developer, I want metrics persisted to a SQLite database (`%LOCALAPPDATA%\Argus\metrics.db`) covering pane events, summaries, merge runs, and workspace summaries, so that I can ask retrospectively "how much did this workspace cost me in tokens?".
48. As a developer, I want `argus stats workspace <id> --cost` to surface per-CLI token and cost totals when the CLI exposes them (Claude does, others partial), so that I have honest visibility without inventing numbers.

### Out-of-band CLI usage

49. As a developer, I want `argus` and `workspace` to be a single binary distributed with two filenames, dispatching by `argv[0]`, so that the codebase has one CLI implementation and the install layout is two thin copies.
50. As a developer, I want a single monolithic installer (`Argus-Setup.exe`) that drops `argusd`, `Argus.exe`, `argus.exe`, and `workspace.exe` in place and adds `argus.exe` and `workspace.exe` to PATH, so that first-run is one click.

## Implementation Decisions

The architecture is fully captured in `research/architecture-decisions-v1.md` (decisions A1–A18). The PRD-relevant subset:

### Process and IPC shape

- **Engine** = standalone Node daemon `argusd` (A1). Not Electron-embedded; lazy-launched (A2); auto-shutdown after 30 min idle. Survives GUI closing.
- **Process model** = supervisor (`argusd`) + child-per-Workspace (`workspace-child`) via `child_process.fork` (A4). One workspace-child crash does not affect another.
- **IPC** = named pipe (`\\.\pipe\argus-${user}`, override via `ARGUS_PIPE` env var) carrying JSON-RPC 2.0 (A3, A14). Atomic socket-bind race resolution; no lock files. Subscription via explicit `workspace.attach`/`detach` (A14).
- **GUI** = separate Electron app, JSON-RPC client over the named pipe (A7). PTY bytes flow PTY → workspace-child → argusd → pipe → Electron main → renderer → xterm.js, base64 inside `pane.event` notifications.
- **Adapters** = in-process inside their workspace-child (A5), with a "promotable interface" discipline (no global state, no filesystem outside the worktree, no daemon-socket access).

### CLI binary

- One Bun-compiled binary (A8) distributed twice (`argus.exe` + `workspace.exe`) with `argv[0]`-style dispatch. Personalities:
  - As `argus`: `init`, `list`, `open`, `stop`, `status`, `doctor`, `clean`, `logs`, `stats`, `config`.
  - As `workspace`: `done`, `blocked`, `status` only — anything else returns a clear error pointing at `argus`.
- Distribution = single monolithic installer in v0.1 (A9). Tray app, auto-updater, separable packages all v0.2+ (A10/A11).

### Auth (A12)

- Trust each CLI's own credential cache. The user runs `claude login` / `codex login` outside Argus before first use. argusd spawns CLIs with a clean env containing only `PATH`, `HOME`/`USERPROFILE`, `TEMP`, `TMP`, and Argus-injected `ARGUS_PIPE` / `ARGUS_WORKSPACE_ID` / `ARGUS_PANE_ID`. **No** API key env vars are passed.
- `argus doctor` verifies each configured CLI's PATH presence and a no-op success run.
- Multi-account and API-key-based auth deferred to v0.2.

### Adapter (A13)

The internal lingua franca is **vocabulary-of-our-own**, inspired by ACP semantics but not bound to spec versions (A13). Each Adapter extends an abstract base and emits a single discriminated event:

```ts
type PaneState =
  | 'idle' | 'thinking' | 'toolUse' | 'waitingPerm'
  | 'done' | 'blocked' | 'dead';

type AdapterEvent =
  | { kind: 'output'; bytes: Buffer }
  | { kind: 'state'; state: PaneState; reason?: string }
  | { kind: 'message'; role: 'assistant'; text: string; partial: boolean }
  | { kind: 'thinking'; text: string; partial: boolean }
  | { kind: 'toolCall.requested'; id: string; tool: string; args: unknown }
  | { kind: 'toolCall.completed'; id: string; result: unknown; durationMs: number }
  | { kind: 'permissionRequest'; id: string; what: string; risk: 'low'|'medium'|'high' }
  | { kind: 'sentinel'; cmd: 'done'|'blocked'|'status'; payload: unknown }
  | { kind: 'usage'; tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { kind: 'error'; source: 'parser'|'cli'|'pty'; message: string };

abstract class Adapter extends TypedEmitter<{
  event: (e: AdapterEvent) => void;
  exit: (code: number | null) => void;
}> {
  abstract readonly cliKind: 'claude' | 'codex';   // v0.1 surface
  abstract start(pty: IPty, ctx: AdapterContext): void;
  abstract dispose(): Promise<void>;
  abstract sendInput(text: string): void;
  abstract decideToolCall(id: string, decision: 'allow'|'deny', reason?: string): void;
  abstract decidePermission(id: string, decision: 'allow'|'deny', reason?: string): void;
  abstract interrupt(): void;
}

interface AdapterContext {
  worktreePath: string;
  paneId: string;
  workspaceId: string;
}
```

- Static dispatch: pane creation specifies `cliKind`, the right adapter is constructed.
- Bidirectional: every adapter must implement tool-call interception via the underlying CLI's mechanism (Claude Code `PreToolUse` hook, Codex `notify` hook).
- Buffer growth guard: if a pane's adapter accumulates more than 16 MB of pending parse buffer, the adapter logs an error and the pane is killed.

### JSON-RPC schema (A14)

**Requests** (client → daemon):

| Method | Params | Returns |
|---|---|---|
| `daemon.status` | `{}` | `{ version, uptime, workspaceCount, protocolVersion }` |
| `daemon.shutdown` | `{ graceMs? }` | `{}` |
| `workspace.create` | `{ name, agentRatio, repoPath, plan? }` | `{ workspaceId }` |
| `workspace.list` | `{}` | `{ workspaces: WorkspaceSummary[] }` |
| `workspace.get` | `{ id }` | `{ workspace: WorkspaceFull }` |
| `workspace.attach` | `{ id, since? }` | `{}` |
| `workspace.detach` | `{ id }` | `{}` |
| `workspace.delete` | `{ id, cleanWorktrees }` | `{}` |
| `pane.send` | `{ paneId, text }` | `{}` |
| `pane.interrupt` | `{ paneId }` | `{}` |
| `pane.decideTool` | `{ paneId, callId, decision, reason? }` | `{}` |
| `pane.decidePermission` | `{ paneId, requestId, decision, reason? }` | `{}` |
| `plan.approve` | `{ workspaceId }` | `{}` |
| `plan.update` | `{ workspaceId, content }` | `{}` |
| `merge.start` | `{ workspaceId }` | `{ mergeRunId }` |
| `merge.cancel` | `{ workspaceId }` | `{}` |
| `sentinel.report` | `{ workspaceId, paneId, cmd, payload }` | `{}` |

**Notifications** (daemon → client, only after `workspace.attach`):

- `pane.event`: `{ workspaceId, paneId, event: AdapterEvent }`. `kind: 'output'` carries `bytes` as base64.
- `workspace.stateChanged`: `{ workspaceId, state }`.
- `merge.progress`: `{ workspaceId, mergeRunId, phase, detail? }`.
- `daemon.shuttingDown`: `{ graceMs }`.

**Errors**: JSON-RPC standard codes plus custom range `-32000..-32099`:
- `-32001 WorkspaceNotFound`, `-32002 PaneDead`, `-32003 WorkspaceLocked`, `-32004 ProtocolVersionMismatch`, `-32005 SandboxViolation`.

**Versioning**: every `daemon.status` response carries `protocolVersion: 1`. Mismatched clients receive a clear error.

### Sandbox (A part of #13 in foundations, refined)

Pure function shape:
```ts
type SandboxDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; risk: 'low' | 'medium' | 'high' };

function decide(input: {
  cli: 'claude' | 'codex';
  tool: string;
  args: unknown;
  worktreePath: string;
  paneRole: 'lead' | 'worker' | 'merge';
}): SandboxDecision;
```

Default policy v0.1 (deny list, all else allow):
- Deny: `git push`, `git remote add/set-url`, `npm publish`, `gh` (unless explicitly read-only), `curl`, `wget`, `aws`.
- Deny: filesystem reads to `~/.ssh/`, `~/.aws/`, `~/.config/gh/`, any `.env*` file outside the worktree.
- Deny: writes outside the worktree (lead included for writes).
- Allow: anything inside the worktree, including destructive ops (the branch is disposable).
- Lead-only: read access to other worktrees within the same Workspace.
- Merge agent: bypass — operates on `main`, audits to `merge-log.md`.

### State persistence (A17)

`%LOCALAPPDATA%\Argus\state\workspaces\${id}.json`. Atomic write (`tmp + fsync + rename`). Schema versioned via `schemaVersion`. Intent-only fields:

```json
{
  "schemaVersion": 1,
  "id": "auth-flow",
  "createdAt": "2026-05-08T10:00:00Z",
  "repoPath": "C:\\Users\\lauta\\projects\\some-repo",
  "agentRatio": [{"cli": "claude", "count": 5}, {"cli": "codex", "count": 3}],
  "panes": [
    {
      "paneId": "pane-1",
      "role": "lead",
      "cli": "claude",
      "worktreeRelPath": ".workspace/worktrees/agent-1",
      "branchName": "workspace/auth-flow/lead",
      "userClosed": false,
      "lastKnownState": "thinking"
    }
  ],
  "plan": { "path": ".workspace/plan.md", "approvedAt": "2026-05-08T10:15:00Z" },
  "mergeState": null
}
```

### Logging (A15)

NDJSON, multi-file at `%LOCALAPPDATA%\Argus\logs\` split into `daemon/`, `workspace-${id}/`, and `pane-stderr/`. Daily rotation with gzip; 14-day retention. Levels `debug | info | warn | error`, default `info`, override via `argus config set log.level debug` or `ARGUS_LOG=debug`.

What is logged: lifecycle, sandbox decisions (allowed and blocked, for audit), adapter errors, IPC errors, doctor runs.
What is NOT logged: agent message contents (privacy + noise), raw PTY bytes (would dwarf logs).

### Metrics (A16)

SQLite at `%LOCALAPPDATA%\Argus\metrics.db`, schema:
- `pane_events (id, ts, workspace_id, pane_id, event_kind, duration_ms, payload_json)`
- `pane_summary (workspace_id, pane_id, cli, started_at, ended_at, total_thinking_ms, total_tool_use_ms, tokens_in, tokens_out, cost_usd, tool_calls_total, tool_calls_blocked, terminal_state)`
- `merge_runs (id, workspace_id, started_at, ended_at, conflicts_auto, conflicts_human, tests_passed, reverted)`
- `workspace_summary (id, created_at, closed_at, panes_total, merges_total)`

Tokens and cost recorded only when the CLI exposes them. Phone-home telemetry is **explicitly out of scope** for v0.1 — all data stays local.

### Merge agent (A18)

Subprocess of the workspace-child, spawned via `argusd --mode merge-agent --workspace ${id} --pre-merge-tag ${tag}` (same binary, mode dispatch). State machine over phases. Sub-agents for semantic conflicts are real `claude` / `codex` instances spawned by the merge agent with constrained context, surfaced in the GUI as sub-panes of the merge pane. Cancel = SIGTERM → 5s grace → SIGKILL → `git reset --hard ${preMergeTag}`. Recovery on daemon restart prompts user to resume or revert.

### Modules to build

Engine (in `argusd` and `workspace-child`):
- `pipe-server` — JSON-RPC 2.0 server over named pipe; subscription model.
- `workspace-registry` — CRUD on `state.json` files with atomic write and migrations.
- `workspace-supervisor` — `child_process.fork` of workspace-children; lifecycle and idle-shutdown of the daemon.
- `pane` — Pair of (PTY + Adapter) with a state machine.
- `sandbox` — Pure decision function.
- `adapter` (base + `ClaudeAdapter` + `CodexAdapter`).
- `worktree-manager` — wrapper over `git worktree add/list/remove`.
- `merge-runner` — state machine for the merge flow.
- `metrics-store` — SQLite wrapper.
- `logger` — NDJSON file writer with rotation.

CLI (in the Bun-compiled binary):
- `pipe-client` — JSON-RPC client + daemon discovery + auto-spawn.
- `cli-router` — `argv[0]` and subcommand dispatch.
- `doctor` — health-check function returning a structured report.

GUI (in the Electron app):
- `gui-pipe-bridge` — main-process JSON-RPC client + IPC forwarding to renderer.
- `gui-grid` — renderer-side grid layout + xterm.js per pane.
- `gui-workspace-form` — workspace creation modal + plan editor.

## Testing Decisions

### What makes a good test here

External-behavior tests. We test that, given an input the module would receive in production (a recorded PTY stream, a synthetic JSON-RPC frame, a tmpdir filesystem state), the output the module produces (an event sequence, a state file, a database row) matches an expected shape. We do **not** test internal helpers, private methods, or implementation details that would be replaced in a refactor.

Specifically:
- Replays of recorded `claude --output-format stream-json` output → expected `AdapterEvent[]` sequence. No mocking of the parser internals.
- Synthetic JSON-RPC requests over an in-memory pipe pair → expected responses and notifications.
- A real `git` subprocess on a tmpdir-cloned repo → expected branch / worktree / merge state. No mocking of git.
- A real SQLite file → expected query results. No mocking of the SQL layer.

### Modules with required tests in v0.1

- **`sandbox`** — security-sensitive. Test matrix of `(cli, tool, args, worktreePath, paneRole) → SandboxDecision`. Every deny-list entry has explicit positive and negative cases. Pure function; no mocking needed.
- **`workspace-registry`** — atomic write under crash injection (kill mid-write, expect either old or new state, never partial). Schema-version round-trip. Recovery on a `state.json` written by an older schema.
- **`pipe-server`** + **`pipe-client`** — round-trip of every request/notification in §JSON-RPC schema. Subscription correctness: notifications only after `attach`, none after `detach`. Race condition: two clients attempting bind simultaneously; one wins.
- **`adapter`** — `ClaudeAdapter` and `CodexAdapter` each with at least 5 recorded sessions (idle, single-message turn, tool-using turn, blocked permission, error). Replay → assert event sequence. Bidirectional: `decideToolCall('allow')` produces the expected stdin write to the PTY.
- **`worktree-manager`** — idempotency (`add` twice on same name = no error, no duplicate state). Cleanup of stale worktrees. Branch-collision behavior (existing branch with same name → fail clearly, not corrupt).
- **`merge-runner`** — state machine: every phase reachable, every error path produces a revert, cancel mid-flight produces a revert, sub-agent timeout produces an escalation. `git` and `verify_command` are real subprocesses against tmpdirs.

### Modules with optional tests in v0.1

- `metrics-store` — basic insertion + summary query test. Migration test if schema bumps.
- `workspace-supervisor` — covered primarily by daemon smoke tests (start daemon, open workspace, kill workspace-child, expect supervisor to mark it crashed).
- `doctor` — each individual check tested in isolation against synthetic env.

### Modules not unit-tested in v0.1

- `cli-router`, `logger`, `gui-pipe-bridge`, `gui-grid`, `gui-workspace-form`. These are glue or UI; ROI of unit tests is low. Cover via end-to-end smoke tests (open the app, create a workspace, watch a worker emit `workspace done`, merge, expect green).

### Prior art in the codebase

This is a greenfield repo — no prior tests exist. The conventions to follow:
- TypeScript end-to-end (per A6 / decision #6 of foundations).
- Test runner: choose between `vitest` (faster, ESM-first, less ceremony) and `bun test` (already in stack since A8 uses Bun for the CLI binary). Recommend `vitest` for Node-runtime modules and `bun test` for the CLI binary build.
- Test files colocated as `*.test.ts` next to the module.
- Recorded fixtures (CLI streams, JSON-RPC frames, plan files) live under `<module>/__fixtures__/`.

## Out of Scope

Explicitly **not** in v0.1:

- macOS and Linux support (decision #17 of foundations). Pipe paths and signal handling change; deferred to v0.2+.
- Adapters beyond Claude Code and Codex (decision #8). OpenCode, Pi, Copilot CLI all have their adapter shape researched in foundations §3 but no implementation in v0.1.
- Worker-to-worker dynamic synchronization (decision #18). Plan-driven serialization only; `.workspace/contracts.md` opt-in.
- OS-level sandbox (Job Objects / Windows AppContainer). v0.1 is software-level interception via the adapter only.
- `workspace export` for portability between devs (foundations §5.2).
- Premium GUI / full-GUI creation wizard. v0.1 GUI is functional, not pretty.
- Multi-workspace simultaneously visible in one window. v0.1 = one workspace per window.
- Auto-cleanup of worktrees post-merge. v0.1 = manual via `argus clean`.
- Auto-updater (A11). Manual reinstall in v0.1.
- Tray app / status indicator (A10). v0.2.
- Separable packages (engine standalone vs GUI). v0.1 ships one monolithic installer.
- Multi-account auth within a Workspace (e.g., pane 1 with account A, pane 2 with account B). Deferred per A12.
- API-key-based auth as an alternative to login-based credentials. Deferred per A12.
- Phone-home telemetry to the Argus team. v0.1 metrics are strictly local-user-only per A16.
- Cross-platform pipe abstraction (Unix domain socket support). v0.1 = Windows named pipe only.

## Further Notes

### Validation criterion (from foundations §5.3)

Two weeks of solo dogfooding by Lautaro. If he opens Argus daily during that period → invest in v0.2. If he opens Windows Terminal instead → kill or pivot. The metrics in `metrics.db` and the doctor command should give honest signal about whether the tool is being used or being abandoned.

### Things that look like scope creep but aren't

- `argus doctor` is treated as a first-class v0.1 feature (not an afterthought) because A12's auth-trust-the-CLI model means "why isn't my workspace starting?" is the highest-frequency support question and `doctor` is the only answer to it.
- Logging and SQLite metrics look like ops infrastructure but they're in v0.1 specifically because we cannot evaluate dogfooding without them. Their absence would force `console.log`-based debugging and impressionistic "did I use it this week?" judgments.
- The `Merge agent` is genuinely complex (state machine, sub-agents, recovery) but it's the moat. Without a working merge agent, Argus is a fancy tmux. With it, Argus is a parallel-development tool.

### Things that should remain non-load-bearing in v0.1

- The exact field set of `pane_summary` will evolve; treat it as additive-only in this version. Migration tooling exists for a reason.
- The shape of `AdapterEvent` is stable in v0.1 but may grow new variants in v0.2 (e.g., `usage.delta` for streaming token counts). Keep consumers using exhaustive switches so additions are caught at compile time.
- Sub-agent context for semantic merge conflicts is whatever fits; the spec says "constrained" but the exact shape (just the file? file plus diff? file plus diff plus plan task?) is left to implementation-time judgment.

### Reference docs

- `CONTEXT.md` — domain glossary; use this vocabulary in code identifiers, log messages, and UI strings.
- `research/foundations.md` — original product thesis and CLI landscape research.
- `research/architecture-decisions-v1.md` — full architectural rationale for A1–A18 (this PRD is the buildable subset).
