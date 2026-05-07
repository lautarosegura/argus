# Argus — Foundations Research

> Documento de research producido en sesión de grilling sobre la idea inicial.
> Captura las decisiones arquitectónicas y de producto lockeadas, el research de mercado,
> los principios fundacionales, y las preguntas que siguen abiertas.

---

## 1. Resumen ejecutivo

**Argus** es una aplicación de escritorio (Windows-first) que permite a un dev ejecutar y orquestar **múltiples agentes CLI de IA en paralelo** dentro de un mismo proyecto, sobre una **grilla de terminales** donde cada pane corre un agente en su propio **git worktree** aislado. Un pane es designado **lead** (orquestador), las otras son **workers** que reciben tareas del lead. Al finalizar, un **merge-as-agent** integra el trabajo de los workers a `main` con tests automáticos.

La promesa es **acelerar el desarrollo de software** convirtiendo una idea grande paralelizable en N piezas simultáneas, manteniendo siempre al humano en el loop de las decisiones arquitectónicas.

---

## 2. Thesis del producto

### 2.1 Problema que resuelve

El desarrollador técnico que orquesta múltiples agentes CLI hoy lo hace con **5 paneles de Windows Terminal abiertos manualmente**, sin coordinación entre sí, lidiando con:

- Idea compleja paralelizable que se vuelve difícil de coordinar.
- Conflictos de archivos / merge hell entre lo que produce cada agente.
- No saber cuándo un agente terminó vs sigue trabajando vs está bloqueado.

### 2.2 Principio rector

> **Los agentes son implementadores. El humano decide.**

Esto se aplica como guardrail en cada decisión de diseño:

- El humano define el **split de tareas** (vía propose & approve).
- El humano dispara el **merge** explícitamente.
- Los agentes pueden auto-resolver conflicts triviales y semánticos, pero el humano **ratifica post-merge** con un log de resoluciones.
- Cuando un worker se bloquea, **escala al humano** — no se intenta reasignar automáticamente.

### 2.3 Diferenciación vs alternativas

| Alternativa | Por qué no alcanza |
|---|---|
| **Windows Terminal con N panes** | Sin coordinación, sin worktrees automáticos, sin awareness de estado del agente |
| **tmux + git worktree manual** | Posible pero requiere scripting custom; sin UI, sin estado estructurado |
| **BridgeSpace** | Producto ancho (Command Room + Swarm Room + Review Room + Memory + voice + Kanban). Argus apunta a ser **angosto y brutal en terminal/dev env** |
| **Cursor / Windsurf** | IDE-first, no terminal-first; agentes individuales, no swarm con worktrees |

**Posicionamiento explícito**: first-class Windows dev tool en un mercado donde casi todo es Mac-first.

---

## 3. Research del landscape de CLIs (5/5 investigados)

### 3.1 Conclusión central

**Ningún CLI moderno de IA quiere que parsees su TTY.** Los 5 investigados ofrecen algún modo estructurado (HTTP server, NDJSON, JSONL-RPC, SDK embebido). Pero **cada uno tiene su propio dialecto** — no hay estándar universal todavía.

### 3.2 Tabla comparativa

| CLI | Modo wrapper-friendly | Protocolo | Detección de estado |
|---|---|---|---|
| **Claude Code** | `claude -p --output-format stream-json --verbose --include-partial-messages` / Agent SDK / HTTP hooks | NDJSON + SDK + HTTP hooks | `system/init`, `assistant` deltas (thinking), `tool_use`, `result` (turn done), `Stop`/`Notification` hooks |
| **OpenAI Codex** | `codex exec --json` / TS SDK (`@openai/codex-sdk`) | JSONL + OSC 9 + `notify` hook | `thread.started`, `turn.started/completed/failed`, `item.started/completed` |
| **OpenCode** | `opencode serve` + HTTP/SSE event bus | HTTP + SSE | `session.idle`, `tool.execute.before/after`, `permission.asked`, `message.part.updated` (40+ eventos tipados) |
| **Pi** (`@mariozechner/pi-coding-agent`) | `--mode rpc` JSONL bidireccional / TS SDK (`createAgentSession`) | JSONL-RPC LF-delimited + SDK | Eventos por record (tool calls, assistant chunks, completion) |
| **Microsoft Copilot CLI** | `copilot --acp` (NDJSON sobre stdio) | **ACP (Agent Client Protocol)** | `agent_message_chunk`, tool-call updates, `sessionUpdate` lifecycle |

### 3.3 Insight estratégico — ACP como lingua franca

**ACP (Agent Client Protocol)** está emergiendo como estándar abierto para comunicación host-agente:

- Adoptado por Copilot CLI, Zed, openclaw.
- Especificado en agentclientprotocol.com.
- Es JSON-RPC sobre stdio con tipos definidos para `sessionUpdate`, `agent_message_chunk`, tool-calls, etc.

**Analogía con LSP**: antes de Language Server Protocol, cada editor tenía integración custom para cada lenguaje (N×M). Después, N+M. ACP puede ser ese mismo cambio para wrappers de agentes.

**Decisión arquitectónica derivada (Q7)**: Argus usa ACP-style como **lingua franca interna**. Cada CLI tiene un **adapter** que normaliza sus eventos al modelo del engine. El resto de Argus (UI, lead-pane, send-to-pane, merge-agent) consume el stream normalizado. Cuando llegue un sexto CLI ACP-nativo, se enchufa sin código nuevo.

---

## 4. Decisiones arquitectónicas lockeadas

### 4.1 Resumen (16 decisiones)

| # | Decisión | Lockeada |
|---|---|---|
| 1 | Producto = scratch your own itch (replace tmux + worktrees + agent CLIs ad-hoc) | ✅ |
| 2 | Dolor central = paralelizar idea grande + merge automático | ✅ |
| 3 | Filesystem = git worktree por pane (no shared dir, no containers en v0.1) | ✅ |
| 4 | Orquestación = lead pane + workers + primitiva `send-to-pane` + merge-as-agent | ✅ |
| 5 | Moat = agent-aware terminal + worktree-native | ✅ |
| 6 | Runtime = **Electron + TypeScript**, xterm.js para render, node-pty para PTY | ✅ |
| 7 | Adapter layer normaliza events de cada CLI al engine interno | ✅ |
| 8 | MVP = (b) ambiciosa: 3x3 grid, Claude Code + Codex, persistencia, merge automático | ✅ |
| 9 | Lead = Claude Code con system prompt orquestador (no agente nuevo) | ✅ |
| 10 | Detección de "done" = sentinel command `workspace done` (binario en PATH del worktree) | ✅ |
| 11 | Bloqueo de worker → escala al humano (no reasignación auto en v0.1) | ✅ |
| 12 | Split de tareas = propose & approve (lead propone plan, user aprueba/edita), plan persiste como artefacto en `.workspace/plan.md` | ✅ |
| 13 | Permisos workers = sandbox por worktree con interceptación de tool calls peligrosas (escapes del worktree, network, secrets) | ✅ |
| 14 | Estado on-disk = `.workspace/` adentro del repo, gitignored. Worktrees en `.workspace/worktrees/agent-N/`, también gitignored | ✅ |
| 15 | Merge strategy = serial en orden definido por el plan, auto-resuelve agresivamente (incluso semánticos vía sub-agente), escala solo cuando blocked, log de resoluciones para ratificación humana, tests post-merge con auto-revert si fallan, tag `workspace-pre-merge-<ts>` como anchor | ✅ |
| 16 | Workspace creation = CLI-first (`workspace init`) + GUI mínima (sidebar de workspaces, modal con CLI editable). Agent assignment = ratio (`5xclaude,3xcodex`). | ✅ |
| 17 | Cross-platform = Windows-only en v0.1, Mac próxima, Linux después | ✅ |
| 18 | Worker-to-worker comm = (a) plan-driven serialization por default + (d) opcional `.workspace/contracts.md` cuando el user define interfaces compartidas. Cross-worktree read prohibido. Sync dinámico pospuesto a v0.2 | ✅ |

### 4.2 Notas de implementación clave

**Comando `workspace` (binario en PATH)**:
- `workspace done [--summary X] [--needs-review]` → escribe a Unix socket / named pipe / archivo JSON watcheable. Engine emite evento `worker.done` al lead.
- `workspace blocked <reason>` → emite `worker.blocked`, escala al humano.
- `workspace status <text>` → progreso intermedio opcional.

**Branches naming**: `workspace/<plan-id>/<worker-id>` (ej: `workspace/auth-flow/worker-1`). Prefijo `workspace/` permite filtros y cleanup en bulk.

**Plan artifact** (`.workspace/plan.md`): contiene tareas numeradas con dependencias y orden de merge. Editado por el user durante el approve. Cada worker recibe SU tarea y el plan completo vía system prompt directo (no leyendo el archivo, porque cada worktree tiene su propio `.workspace/` que puede estar desincronizado).

**Merge flow lockeado**:
1. `git tag workspace-pre-merge-<timestamp>` en main.
2. Serial merge en orden del plan aprobado.
3. Trivial conflicts → auto. Semánticos → sub-agente intenta. Sub-agente blocked → escala con detalle.
4. Cada decisión auto del sub-agente queda en `.workspace/merge-log.md`.
5. Post-merge: corre `verify_command` (default `npm test`).
6. Pasa → reporta success + muestra merge-log para ratificación.
7. Falla → `git reset --hard <pre-merge-tag>`, reporte detallado.

**Sandbox de workers (v0.1, software-level)**:
- Process cwd = su worktree.
- Adapter intercepta tool calls. Bloqueado: `git push`, `curl`, `wget`, `npm publish`, `gh`, `aws`, lecturas a `~/.ssh`, `.env`, `.aws`.
- Permitido adentro del worktree: `rm`, force-push de la branch del worker (porque blast radius = branch descartable).
- Lead: lectura de otros worktrees permitida (para inspección), no escritura.
- Merge-as-agent ephemeral pane: única autorizada a tocar `main`.

---

## 5. MVP — alcance v0.1 (escenario "b ambiciosa")

### 5.1 Incluido

- Grid 3x3 configurable (1 lead + 8 workers).
- 2 agentes soportados: **Claude Code** y **OpenAI Codex** (con sus adapters al engine interno).
- Adapter layer ACP-style.
- Worktrees automáticos al crear workspace.
- Badges de estado por pane (idle / thinking / tool-calling / waiting / done / blocked).
- Comando `send <n> "<msg>"` desde el lead.
- Sentinel commands `workspace done | blocked | status`.
- Propose & approve para split de tareas + plan como artefacto editable.
- Merge-as-agent con auto-resolve agresivo + tests post-merge + log de ratificación.
- Persistencia: cerrar y reabrir un workspace recupera grid, branches, estado de workers.
- CLI `workspace init` + GUI mínima con sidebar de workspaces.
- Windows-only.

### 5.2 Pospuesto a v0.2+

- Mac, Linux.
- Soporte para OpenCode, Pi, Copilot CLI (los adapters ya están investigados).
- Sync points dinámicos worker-to-worker.
- Sandbox a nivel OS (Job Objects / AppContainer).
- `workspace export` para portabilidad entre devs.
- UI premium / wizard de creación full-GUI.
- Multi-workspace simultáneo en una sola ventana.
- Auto-cleanup de worktrees post-merge (en v0.1 = manual via `workspace clean`).

### 5.3 Criterio brutal de validación

**Después de 2 semanas de dogfooding solo:**
- Si Lautaro abre Argus todos los días → invertir en v0.2.
- Si abre Windows Terminal en su lugar → matar o pivotear.

---

## 6. Insights / aprendizajes notables

### 6.1 ACP como apuesta estratégica

El timing de ACP es interesante: público preview enero 2026, ya con 3 implementadores serios (Copilot, Zed, openclaw). Argus puede ser **uno de los primeros wrappers ACP-native serios** y posicionarse como referencia cuando el estándar madure.

### 6.2 Detección de estado ≠ detección de "done"

`session.idle` y `turn.completed` no son señal suficiente para disparar merge automático. Idle puede significar "terminó", "atascado", "esperando aclaración", o simplemente "pausa entre tool calls". La solución (sentinel command `workspace done`) es **superior a inferencia por LLM** porque:
- Cross-CLI (mismo patrón en Claude, Codex, OpenCode, Pi, Copilot).
- Determinística y debuggeable.
- Los modelos son mejores ejecutando tools que escribiendo strings mágicos. Un Claude Code con tool `bash` cumple "ejecutá `workspace done`" 99% de las veces; "escribí `<<<TASK_COMPLETE>>>`" lo cumple 80%.

### 6.3 Reversibilidad como criterio de permisos

La línea correcta para permisos de workers no es "tool peligrosa vs segura" sino **"efecto reversible vs irreversible"**. `bash` puede ser ambas cosas. La heurística clave: **¿el efecto sale del worktree?** Si no, librepensamiento (la branch es descartable). Si sí, escalar.

### 6.4 La trampa de auto-split

Auto-split de tareas (lead decide arquitectura sin intervención humana) es atractivo pero **viola la thesis y suele producir splits malos** que generan overlap → merge conflicts → cascada de fallas. **Propose & approve** preserva la decisión arquitectónica donde tiene que estar (humano) sin overhead significativo.

### 6.5 Tauri vs Electron — tradeoff resuelto a favor de dev velocity

Tauri tendría ventajas en perf y bundle size, pero **Electron/TypeScript end-to-end** baja drásticamente la barrera de iteración para un solo dev. PTY + HTTP/SSE + NDJSON parsing son todos casos donde Node está al nivel de Rust en conveniencia. La elección prioriza time-to-MVP sobre perf teórica.

---

## 7. Preguntas abiertas (no grilladas todavía)

- **Naming oficial**: el repo se llama `argus`, pero el branding del producto está sin definir.
- **Distribución / pricing**: OSS? Closed source? Paid? Free? Decisión post-MVP.
- **Estrategia de update / auto-update** del cliente.
- **Telemetría / observabilidad** del producto (qué medir en dogfooding).
- **Mecanismo de auth** para que Argus invoque los CLIs (ya autenticados localmente vs requiere setup).
- **Licencia OSS si aplica** (MIT? Apache? source-available?).

---

## 8. Referencias

### CLIs investigados

- Claude Code — https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/hooks, https://platform.claude.com/docs/en/agent-sdk/overview
- OpenAI Codex — https://developers.openai.com/codex/noninteractive, https://developers.openai.com/codex/cli/reference, https://developers.openai.com/codex/sdk
- OpenCode — https://opencode.ai/docs/server/, https://opencode.ai/docs/sdk/, https://opencode.ai/docs/plugins/
- Pi — https://github.com/badlogic/pi-mono, https://www.npmjs.com/package/@mariozechner/pi-coding-agent
- Copilot CLI — https://github.com/github/copilot-cli, https://docs.github.com/copilot/concepts/agents/about-copilot-cli, https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server

### Estándares / referencia técnica

- Agent Client Protocol — https://agentclientprotocol.com/protocol/overview
- Producto referencia (competidor ancho) — https://www.bridgemind.ai/products/bridgespace

### Stack técnico

- Electron — https://www.electronjs.org/
- xterm.js — https://xtermjs.org/
- node-pty — https://github.com/microsoft/node-pty
- Git worktrees — https://git-scm.com/docs/git-worktree
