# Argus — Decisiones de Arquitectura (v1)

> Documento producido en sesión de grilling sobre el shape del runtime.
> Extiende y refina las decisiones #6 (stack) y #16 (workspace creation) de `foundations.md`.
> Foco: cómo se descomponen los procesos, cómo se hablan, qué binarios se distribuyen.

---

## 1. Contexto

`foundations.md` lockeó el stack (Electron + TypeScript + xterm.js + node-pty) y el espíritu "CLI-first + GUI mínima", pero dejó abiertas las preguntas operacionales: ¿la GUI es el engine o es un cliente del engine?, ¿qué pasa con los agentes cuando se cierra la ventana?, ¿cuántos procesos hay corriendo y por qué?, ¿qué se instala en disco?

Este documento responde esas preguntas. Las decisiones forman una cadena coherente — cada una refuerza las próximas.

---

## 2. Resumen ejecutivo

- **El engine es un daemon Node standalone (`argusd`)**, no una app Electron disfrazada. La GUI es un cliente Electron separado que vive sin él, no al revés.
- **Lifecycle lazy**: argusd se levanta solo cuando hace falta, se apaga solo cuando no hay nada vivo. Cero costo cuando no usás la herramienta.
- **IPC por named pipe + JSON-RPC 2.0**: una sola interface, simétrica con ACP, consumible por GUI, CLI, y futuros clientes.
- **Procesos aislados por Workspace**: argusd es supervisor; cada Workspace activo es un Node child separado (`workspace-child`). Crashes acotados, trazabilidad por workspace.
- **Adapters in-process** dentro de su workspace-child, con disciplina de interface promovible a subprocess en v0.2 si el dogfooding lo pide.
- **Un solo binario CLI** (`argus.exe` + copia `workspace.exe`) compilado con Bun, dispatching por `argv[0]`.
- **Un solo installer monolítico** en v0.1: argusd + GUI + binarios CLI en un mismo paquete.
- **Tray app y auto-updater pospuestos a v0.2.**

---

## 3. Decisiones lockeadas

| # | Decisión | Notas |
|---|---|---|
| A1 | Engine = `argusd`, daemon Node puro standalone (sin Electron en el daemon) | Permite headless install, CLI-only workflows, faceplates intercambiables |
| A2 | Lifecycle = lazy on-demand + auto-shutdown idle | Levanta al primer cliente, vive mientras haya PTYs abiertos, se apaga después de timeout (default 30 min) sin Workspaces vivos |
| A3 | IPC = named pipe + JSON-RPC 2.0 | Path default `\\.\pipe\argus-${user}`, override vía env var `ARGUS_PIPE` |
| A4 | Process model = supervisor (argusd) + child-per-Workspace (`workspace-child`) | Aislamiento de blast radius por Workspace, trazabilidad separada |
| A5 | Adapters in-process dentro del workspace-child | Con disciplina de "interface promovible": sin estado global, sin filesystem fuera del worktree, sin IPC directo al daemon |
| A6 | Merge agent = subprocess ephemeral spawneado por el workspace-child | Vive solo durante el flujo de merge, con su propia ephemeral pane en GUI |
| A7 | GUI = app Electron separada del daemon, cliente JSON-RPC del named pipe | Cerrar ventana no mata Workspaces; argusd corre sin GUI instalada |
| A8 | CLI = un solo binario Bun-compiled, distribuido como `argus.exe` + copia `workspace.exe`, dispatching por `argv[0]` | Una sola codebase, dos personalidades de uso |
| A9 | Distribución = un solo installer monolítico (`Argus-Setup.exe`) en v0.1 | Trae argusd + GUI + ambos binarios CLI; paquetes separables se evaluarán en v0.2+ |
| A10 | Tray app pospuesta a v0.2 | Status accesible vía `argus status` desde CLI |
| A11 | Auto-updater pospuesto (decidir más adelante) | No bloquea v0.1; un re-installer manual alcanza |
| A12 | Auth con CLIs = trust each CLI's own credential cache | El user corre `claude login` / `codex login` antes; argusd spawnea CLIs con env limpio + `HOME` y los binarios encuentran sus creds en `~/.claude/`, `~/.codex/`, etc. Argus NO maneja secretos en v0.1 |
| A13 | Adapter interface = vocabulario propio inspirado en ACP, Class + EventEmitter tipado, static dispatch | Cada Adapter extiende una clase abstracta que emite un único evento discriminado `AdapterEvent` (output bytes, message, toolCall.requested/completed, permissionRequest, sentinel, state, error) y acepta input bidireccional para sandbox y `send-to-pane` |
| A14 | JSON-RPC del daemon = requests con namespaces (`workspace.*`, `pane.*`, `plan.*`, `merge.*`, `daemon.*`) + notifications via subscription explícita (`workspace.attach`/`detach`) | Bytes de PTY van base64 dentro de `pane.event` notifications; `protocolVersion: 1` en el handshake; error codes JSON-RPC estándar + range custom `-32000..-32099` |
| A15 | Logging = NDJSON estructurado, multi-archivo bajo `%LOCALAPPDATA%\Argus\logs\`, rotación diaria + gzip, retention 14 días | Daemon, workspace-children, y stderr de CLI agents en archivos separados. NO se logea contenido de mensajes del agente ni bytes raw del PTY. Niveles `debug|info|warn|error` con default `info` |
| A16 | Telemetría = SQLite local en `%LOCALAPPDATA%\Argus\metrics.db`, scope per-user, sin phone-home en v0.1 | Schema con `pane_events`, `pane_summary`, `merge_runs`, `workspace_summary`. Tokens capturados solo cuando el CLI los expone (Claude sí, otros parcial). Subcommand `argus stats` para queries pre-cocidas |
| A17 | `state.json` = intent-only, schema versionado, atomic write per-workspace en `%LOCALAPPDATA%\Argus\state\workspaces\${id}.json` | Sin PIDs, sin handles. `lastKnownState` es hint para primer paint post-recovery. `userClosed: true` evita relaunch. `mergeState` permite reanudar/revertir merge interrumpido |
| A18 | Merge agent = subprocess ephemeral spawneado por workspace-child via `argusd --mode merge-agent` | Mismo binario, modo distinto. Sub-agents para conflicts semánticos son `claude`/`codex` regulares spawneados por el merge-agent y aparecen como sub-panes en GUI. `merge.cancel` → SIGTERM/SIGKILL + `git reset --hard ${preMergeTag}` |

---

## 4. Inventario de procesos en runtime

Cuando Argus está siendo usado activamente, el árbol de procesos se ve así:

```
argusd                                    (Node, daemon, vive sin GUI)
├── workspace-child: "auth-flow"          (Node, fork de argusd)
│   ├── claude-code                       (PTY child, Lead pane)
│   ├── claude-code                       (PTY child, Worker pane 1)
│   ├── codex exec                        (PTY child, Worker pane 2)
│   └── ... (hasta 9 PTYs por Workspace)
├── workspace-child: "billing-refactor"   (Node, fork de argusd)
│   └── ...
└── (eventualmente) merge-agent           (Node, ephemeral, child del workspace-child)

# Procesos separados, NO descendientes de argusd:
Argus.exe                                 (Electron, cliente JSON-RPC del pipe)
workspace.exe                             (Bun bin, invocaciones efímeras desde adentro de un Worktree)
argus.exe                                 (Bun bin, invocaciones efímeras del usuario)
```

### Ownership de PTYs
- `node-pty` handles viven en el **workspace-child**.
- Los bytes crudos viajan: PTY → workspace-child → argusd → named pipe → Electron main → renderer → xterm.js. 5 hops, todos localhost, todos byte streams. Latencia agregada <1ms.

### Aislamiento
- Crash de un workspace-child no afecta a los otros, ni al daemon.
- Crash de un PTY (agente CLI muerto) emite `exit`, el adapter lo capta, la pane queda marcada `dead`. No tira al workspace-child.
- Crash de argusd mata todos los workspace-children y sus PTYs. Recovery vía `state.json` en disco — re-leer intent y relanzar.

---

## 5. Inventario de binarios distribuidos

### Lo que se instala (v0.1)

| Archivo | Origen | Dónde vive |
|---|---|---|
| `argusd.exe` | binario Node bundled (pkg / nexe / bun --compile) | `C:\Program Files\Argus\` |
| `Argus.exe` | Electron app | `C:\Program Files\Argus\` |
| `argus.exe` | Bun-compiled binary unificado | `C:\Program Files\Argus\bin\` (en PATH del user) |
| `workspace.exe` | copia de `argus.exe` | `C:\Program Files\Argus\bin\` (en PATH del user) |

### Lo que NO se instala (decisiones explícitas)

- **PTY helper**: ConPTY built-in en Windows 10+, node-pty lo usa directo.
- **Git helper**: argusd y workspace-children invocan `git` directo via `child_process`.
- **Lock / coordination service**: argusd serializa operaciones en memoria.
- **Sandbox runtime helper**: en v0.1 el sandbox es software-level (adapter intercepta tool calls). Job Objects / AppContainer son v0.2+.
- **Remote relay** (acceso por SSH al daemon): v0.2+.
- **Tray app**: v0.2+.
- **Auto-updater**: TBD.

### Personalidades del binario unificado

`argus.exe` y `workspace.exe` son **el mismo archivo** con dispatching por `argv[0]`:

| Como `argus` (PATH global del user) | Como `workspace` (PATH del Worktree) |
|---|---|
| Admin CLI: `init`, `list`, `stop`, `open`, `status`, `doctor`, `clean` | Sentinel CLI: `done`, `blocked`, `status` |
| Lo invoca el humano | Lo invoca el agente desde adentro de su Worktree |
| Cualquier subcomando admin | Solo subcomandos sentinel; otros devuelven error claro |

Razón del split: refleja la distinción semántica que ya está en `CONTEXT.md` entre **Workspace CLI** (sentinels desde adentro) y admin CLI (gestión desde afuera). Que compartan binario es implementación; que tengan nombres distintos es UX.

---

## 6. IPC: el named pipe en detalle

### Path
- Default: `\\.\pipe\argus-${user}` — single-instance por user account.
- Override: env var `ARGUS_PIPE` para multi-instance (dev build vs stable, dos checkouts, tests).
- Discovery desde un Worker: argusd inyecta `ARGUS_PIPE` en el env de cada PTY al spawnearlo. El binario `workspace` lee esa env var primero, cae al default si no existe.

### Protocolo
- JSON-RPC 2.0 sobre el pipe.
- Notifications server→client para eventos de PTYs y estado (`pane.output`, `pane.state`, `worker.done`, `worker.blocked`, etc.).
- Requests client→server para acciones (`workspace.create`, `pane.send`, `merge.start`, etc.).
- Schema concreto a definir cuando empiece la implementación; está bien dejarlo emergente.

### Race en el arranque
Cuando GUI y `workspace done` arrancan simultáneamente y argusd no estaba vivo:
1. Cada cliente intenta `connect()` al pipe.
2. Si falla con `ENOENT`/`ERROR_FILE_NOT_FOUND`, intenta `bind()` (creación del server).
3. Si `bind()` falla con `EADDRINUSE`/`ERROR_PIPE_BUSY`, alguien ganó la carrera — re-intenta `connect()`.
4. El primero que bindea exitosamente es el que ganó: arranca argusd, sigue como server. Los demás conectan como clientes.

Sin file locks. Sin spin wait. Patrón estándar de daemons Unix, funciona idéntico en Windows con named pipes.

---

## 7. Lifecycle del daemon en detalle

### "Workspace vivo" definido estrictamente
Un Workspace está **vivo** si tiene **al menos un PTY abierto cuya child process sigue ejecutándose**, sin importar el estado del agente (idle, thinking, done, blocked).

Razón: una pane en estado `done` o `idle` sigue siendo una sesión a la que el user puede volver y tipear. Matar PTYs por idle del agente rompe la confianza ("dejé esto abierto, volví, y se cerró sola"). Lo que cuenta como "muerto" es: el user cerró la pane explícitamente (vía GUI o `workspace clean`).

### Auto-shutdown
- Si no hay Workspaces vivos por **30 minutos consecutivos**, argusd hace graceful shutdown.
- Próxima invocación de `argus`/`workspace`/GUI lo levanta de nuevo (lazy spawn).
- Timeout configurable vía `argus config set daemon.idle-shutdown-minutes 60`.

### Edge cases reconocidos en v0.1

| Caso | Comportamiento | Documentado para el user |
|---|---|---|
| User cierra sesión de Windows (logout) | argusd muere (es proceso user-mode), Workspaces se pierden de runtime, intent persiste en `state.json` | "Argus no sobrevive al logout en v0.1. Cerrá tus Workspaces antes de cerrar sesión, o dejá la sesión abierta." |
| Sleep / hibernate | PTYs típicamente sobreviven, pero los agentes pueden timeoutear conexiones de red — adapter debe manejar reconexión/error | "Sleep prolongado puede dejar agentes en estado de error de red. Reabrí la pane si pasa." |
| Crash de argusd con PTYs vivos | PTYs huérfanos mueren con su workspace-child padre. Recovery: leer `state.json` y relanzar agentes en panes frescas | Reportado por la GUI cuando se reabre |
| Crash de un workspace-child | argusd lo nota, marca el Workspace como `crashed`, ofrece relanzarlo via `state.json` | Surfaceado en GUI con botón "relaunch" |

### `state.json`: intent-only, sin handles

Lo que sí guarda: `workspace-id`, ratio de agentes, branches asignadas, plan aprobado, estado de panes (`done` / `blocked` / `working` — no PIDs).
Lo que NO guarda: PIDs, PTY handles, sockets, paths runtime que mueren con el proceso.

Esto hace que recovery (post-crash, post-reboot, post-logout) sea **el mismo path** que first-launch del Workspace: leer intent, lanzar agentes desde cero. Una sola lógica, no dos.

---

## 8. La crítica que rechazamos: Electron Utility Processes

Una alternativa considerada y descartada: usar Electron Utility Processes para los workspace-children, con argusd siendo la app Electron misma corriendo headless cuando no hay ventanas.

**Por qué se descartó:**

1. **Acopla daemon a Electron.** Adiós a headless install (VM, WSL sin display, dev box remoto). Traiciona la decisión #16 ("CLI-first") y rompe la posibilidad de faceplates intercambiables.
2. **~150MB de RAM baseline** del runtime Chromium aun sin ventanas.
3. **Lifecycle ambiguo**: hace falta `app.on('window-all-closed')` no-op para que el "app" no muera, lo cual es un Electron app pretendiendo ser daemon. Honestidad arquitectónica perdida.
4. **El argumento a favor era "Electron handles process lifecycle for you"**, pero la lifecycle real del daemon (lazy spawn, idle shutdown, race-on-bind) la tenemos que escribir igual — Electron no la regala.

La separación correcta: `argusd` es Node puro, `Argus.exe` es Electron, son **dos artefactos** que se comunican por el named pipe. Una decisión cuesta más en distribución (dos binarios en el installer en vez de uno) pero compra: faceplates intercambiables, headless install, separación clean engine/UI.

---

## 9. Cuestiones pospuestas

| Tema | A dónde |
|---|---|
| Auto-updater | Decisión pospuesta |
| Tray app / status indicator | v0.2 |
| Paquetes separables (engine standalone + GUI opcional) | v0.2 evaluación |
| Cross-platform (Mac, Linux) | v0.2+ — los path del pipe (`\\.\pipe\` vs Unix domain socket) cambian, pero la abstracción JSON-RPC es portable |
| Multi-instance simultáneo (dev y stable corriendo a la vez) | v0.2 — el override de `ARGUS_PIPE` ya lo permite, falta UX en CLI |
| Multi-account dentro de un workspace (pane 1 con cuenta A, pane 2 con cuenta B) | v0.2 — requiere abandonar A12 puro y agregar credential injection per-pane |
| API key support en lugar de login-based auth | v0.2 — útil para CI-style setups; argusd leería de un keystore propio |
| Phone-home telemetry / opt-in metrics al equipo de Argus | v0.2+ — granular, opt-in explícito, scope mínimo |

---

## 10. Cómo encaja con `foundations.md`

Este documento **extiende** las siguientes decisiones de foundations sin contradecirlas:

- **#6 (stack Electron+TS)** → refinada: el daemon NO es Electron, solo la GUI lo es.
- **#16 (CLI-first + GUI mínima)** → instanciada: el "CLI" es el binario unificado `argus`/`workspace` (Bun-compiled).
- **#7 (adapter layer ACP-style)** → ubicada: los adapters viven in-process en el workspace-child.
- **#15 (merge strategy)** → ubicada: el merge-agent es subprocess ephemeral del workspace-child, no in-process.
- **#10 (sentinel commands)** → instanciada: el binario `workspace` es la implementación del sentinel; conecta al daemon vía el pipe que `ARGUS_PIPE` señala.

Las decisiones nuevas que NO estaban en foundations:
- A1 (daemon standalone, no Electron-embedded)
- A2 (lazy lifecycle)
- A3 (named pipe + JSON-RPC)
- A4 (supervisor + workspace-child)
- A5 (adapters in-process)
- A8 (binario unificado con `argv[0]` dispatch)
- A9 (installer monolítico)
- A12 (auth = trust each CLI's own credential cache)
- A13 (Adapter interface concreto con `AdapterEvent` discriminado)
- A14 (JSON-RPC schema con namespaces + subscription model)
- A15 (logging NDJSON + rotación)
- A16 (telemetría SQLite local, sin phone-home)
- A17 (`state.json` shape versionado e intent-only)
- A18 (merge agent shape concreto)

---

## 11. Open questions que NO resolvimos en esta sesión

- **Naming oficial del producto** — sigue siendo "Argus" tentativo (foundations §7).
- **Distribución / pricing / licensing** — no tocado.

Items resueltos en sesiones de grilling subsiguientes (A12–A18) ahora viven en las secciones 12–17 abajo.

---

## 12. Auth con los CLIs (A12)

### Modelo

Cada CLI maneja su propia auth de la manera estándar de la herramienta. Argus no maneja secretos en v0.1.

**Spawn env de los PTY children** — limpio, sin keys de Argus:
```ts
const cleanEnv = {
  PATH: appendWorktreeBin(process.env.PATH),
  HOME: process.env.HOME ?? process.env.USERPROFILE,
  USERPROFILE: process.env.USERPROFILE,
  TEMP: process.env.TEMP, TMP: process.env.TMP,
  ARGUS_PIPE: argusPipe,                             // discovery del daemon para `workspace done`
  ARGUS_WORKSPACE_ID: workspaceId,
  ARGUS_PANE_ID: paneId,
  // NO ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
};
pty.spawn(cliBinary, args, { cwd: worktreePath, env: cleanEnv });
```

### Por qué

1. Argus no debería estar en el negocio de gestionar secretos. Cada CLI ya tiene su flujo maduro (`claude login`, `codex login`, `gh auth login`).
2. Aislamiento correcto: `~/.claude/credentials.json` es leído por el binario `claude` durante su startup, **antes** de que el adapter intercepte tool calls. Por contraste, el sandbox bloquea tool calls del agente que intenten leer `~/.aws/`, `~/.ssh/`, etc. Layering temporal: auth → adapter activo.
3. Inheritance del shell env (alternativa rechazada) es frágil en Windows porque argusd lazy-spawneado desde Start Menu no carga `.zshrc`.
4. Argus-managed credential store (alternativa rechazada) explota en escope: UI de gestión, rotación, multi-account, encrypted-at-rest. Producto adentro del producto.

### `argus doctor`

Subcommand obligatorio en v0.1. Verifica:
- Cada CLI configurado en el ratio del workspace está en PATH.
- Cada CLI puede ejecutar un comando trivial sin error de auth (e.g., `claude --version`, `codex --version`).
- Worktrees del workspace existen y están en el branch esperado.
- Conexión al named pipe del daemon funciona.
- Versión del daemon, GUI, y CLI binary coinciden.

Output: una línea verde/roja por check, con remediation hint cuando falla.

### Onboarding doc

> "Antes de usar Argus, asegurate de tener instalados y autenticados los CLIs que pensás usar (`claude login`, `codex login`, etc.). Argus no maneja credenciales — cada CLI maneja las suyas. Corré `argus doctor` para verificar."

---

## 13. Adapter interface (A13)

### Vocabulario interno

Inspirado en ACP semánticamente, pero **propio** — no nos atamos a un spec en preview que sigue cambiando.

```ts
type PaneState =
  | 'idle'           // CLI vivo, esperando input
  | 'thinking'       // agente generando respuesta
  | 'toolUse'        // agente ejecutando tool
  | 'waitingPerm'    // esperando permission decision del workspace-child o user
  | 'done'           // emitió `workspace done`
  | 'blocked'        // emitió `workspace blocked`
  | 'dead';          // PTY muerto

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
```

### Base class

```ts
abstract class Adapter extends TypedEmitter<{
  event: (e: AdapterEvent) => void;
  exit: (code: number | null) => void;
}> {
  abstract readonly cliKind: 'claude' | 'codex' | 'opencode' | 'pi' | 'copilot';

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
  // Deliberadamente NO: socket del daemon, otras panes, estado global.
}
```

### Por qué este shape

- **Vocabulario propio (β) en lugar de ACP estricto**: ACP es uno de los 5 dialectos que adaptamos, no superset. Cuando aparezca el sexto CLI ACP-nativo, escribimos `AcpAdapter` que es 80% identidad. Vale el costo vs. atarse a un spec en preview.
- **Single discriminated event** en lugar de N event names: switches exhaustivos a nivel TypeScript, fácil de loggear, persistir, replicar por IPC.
- **`output: Buffer` separado del mensaje semántico**: xterm.js necesita los bytes byte-perfect (escape sequences, ANSI). Adapter expone ambos.
- **`sentinel` como evento del adapter** aunque viene del binario `workspace`: el workspace-child no tiene que saber dos rutas (PTY stdout vs. ARGUS_PIPE callback), el adapter normaliza la fuente.
- **`AdapterContext` minimalista**: la disciplina de "interface promovible" (A5) puesta en código. Si v0.2 mueve el adapter a subprocess separado, lo único que hay que serializar son 3 strings.
- **EventEmitter (I) vs async iterator (II)**: necesitamos fan-out (workspace-child + GUI streamers + logger + metrics collector). EventEmitter es trivial; async iterators requieren un broker.

### Interceptación bidireccional

Cada adapter mapea su CLI a las primitivas comunes:

| Primitiva | Claude Code | Codex | OpenCode | Pi | Copilot |
|---|---|---|---|---|---|
| Tool decision | `PreToolUse` hook | `notify` hook | `tool.execute.before` | RPC bidi | ACP `permission.request` |
| Send input | stdin del PTY | stdin del PTY | HTTP POST | RPC | stdin |
| Interrupt | SIGINT / Esc | SIGINT | HTTP POST | RPC | SIGINT |

---

## 14. Schema JSON-RPC del daemon (A14)

### Requests (client → daemon)

Namespaced. v0.1:

| Method | Params | Returns | Quién lo usa |
|---|---|---|---|
| `daemon.status` | `{}` | `{version, uptime, workspaceCount, protocolVersion}` | doctor, GUI handshake |
| `daemon.shutdown` | `{graceMs?}` | `{}` | admin CLI |
| `workspace.create` | `{name, agentRatio, repoPath, plan?}` | `{workspaceId}` | GUI, `argus init` |
| `workspace.list` | `{}` | `{workspaces: WorkspaceSummary[]}` | GUI sidebar, `argus list` |
| `workspace.get` | `{id}` | `{workspace: WorkspaceFull}` | GUI on attach |
| `workspace.attach` | `{id, since?}` | `{}` | GUI cuando muestra el grid |
| `workspace.detach` | `{id}` | `{}` | GUI al cerrar tab |
| `workspace.delete` | `{id, cleanWorktrees}` | `{}` | `argus clean`, GUI |
| `pane.send` | `{paneId, text}` | `{}` | lead pane (`send-to-pane`), GUI |
| `pane.interrupt` | `{paneId}` | `{}` | GUI Esc, lead pane |
| `pane.decideTool` | `{paneId, callId, decision, reason?}` | `{}` | sandbox UI |
| `pane.decidePermission` | `{paneId, requestId, decision, reason?}` | `{}` | permission UI |
| `plan.approve` | `{workspaceId}` | `{}` | GUI, `argus open` flow |
| `plan.update` | `{workspaceId, content}` | `{}` | GUI plan editor |
| `merge.start` | `{workspaceId}` | `{mergeRunId}` | GUI merge button |
| `merge.cancel` | `{workspaceId}` | `{}` | GUI |
| `sentinel.report` | `{workspaceId, paneId, cmd, payload}` | `{}` | binario `workspace` (interno) |

### Notifications (daemon → client) — solo después de `workspace.attach`

| Method | Params | Cuándo |
|---|---|---|
| `pane.event` | `{workspaceId, paneId, event: AdapterEvent}` (bytes en base64 si `kind === 'output'`) | cualquier evento del adapter |
| `workspace.stateChanged` | `{workspaceId, state}` | cambios high-level (planning, working, merging, complete) |
| `merge.progress` | `{workspaceId, mergeRunId, phase, detail?}` | durante merge |
| `daemon.shuttingDown` | `{graceMs}` | argusd va a apagarse |

### Convenciones

- **Subscription explícita**: `workspace.attach` registra al cliente. Sin attach no hay notifications. Ahorra IPC cuando hay 3 workspaces abiertos pero solo uno visible.
- **PTY bytes en base64** dentro de `pane.event` con `kind: 'output'`. Overhead 33%, simple, suficiente para localhost.
- **`protocolVersion: 1`** en `daemon.status` y handshake. Mismatch → error claro.
- **Errores**: códigos JSON-RPC estándar (`-32600..-32603`, `-32700`) + range custom `-32000..-32099`:
  - `-32001 WorkspaceNotFound`
  - `-32002 PaneDead`
  - `-32003 WorkspaceLocked` (otra operación en curso)
  - `-32004 ProtocolVersionMismatch`
  - `-32005 SandboxViolation`

---

## 15. Logging (A15)

### Layout en disco

```
%LOCALAPPDATA%\Argus\logs\
├── daemon\
│   ├── 2026-05-08.log          (current, NDJSON)
│   └── 2026-05-07.log.gz       (rotated + gzipped)
├── workspace-${id}\
│   └── 2026-05-08.log
└── pane-stderr\
    └── ${workspace}-${pane}-2026-05-08.log
```

### Formato

NDJSON, una línea por evento:
```json
{"ts":"2026-05-08T14:23:01.234Z","level":"info","source":"workspace-child","workspaceId":"auth-flow","paneId":"pane-3","msg":"sandbox: blocked tool call","tool":"git_push","reason":"escapes worktree"}
```

### Política

- **Niveles**: `debug | info | warn | error`. Default `info`. Override `argus config set log.level debug` o env `ARGUS_LOG=debug`.
- **Qué se logea**: lifecycle (workspace/pane/merge), sandbox decisions (allowed y blocked, para auditoría), errores del adapter, errores del IPC, comandos de cliente al daemon, `argus doctor` runs.
- **Qué NO se logea**: contenido de mensajes del agente (privacy + ruido enorme), bytes raw del PTY (van a xterm.js).
- **Rotación**: diaria + gzip, retention 14 días, configurable.
- **Stderr de los CLI agents**: archivo separado per-pane. Captura panics del CLI, errores de red — útil para debugging del CLI mismo, no de Argus.
- **Subcommand**: `argus logs --follow [--workspace X] [--level debug]` (tail), `argus logs export` (zip de los últimos N días para reportar bugs).

---

## 16. Telemetría / métricas (A16)

### Storage

`%LOCALAPPDATA%\Argus\metrics.db` — SQLite. Schema:

```sql
CREATE TABLE pane_events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  duration_ms INTEGER,
  payload_json TEXT
);

CREATE TABLE pane_summary (
  workspace_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_thinking_ms INTEGER DEFAULT 0,
  total_tool_use_ms INTEGER DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  tool_calls_total INTEGER DEFAULT 0,
  tool_calls_blocked INTEGER DEFAULT 0,
  terminal_state TEXT,
  PRIMARY KEY (workspace_id, pane_id)
);

CREATE TABLE merge_runs (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  conflicts_auto INTEGER DEFAULT 0,
  conflicts_human INTEGER DEFAULT 0,
  tests_passed INTEGER,
  reverted INTEGER DEFAULT 0
);

CREATE TABLE workspace_summary (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  panes_total INTEGER DEFAULT 0,
  merges_total INTEGER DEFAULT 0
);
```

### Política

- **Por qué SQLite**: zero-config, single file, atomic writes, queryable con SQL. Vs. JSON files (sin queries decentes), vs. timeseries DB (overkill v0.1).
- **Tokens**: capturados solo cuando el CLI los expone (Claude sí completo, Codex parcial, Pi sí, OpenCode sí, Copilot CLI parcial). Cuando no, `null`. **No** estimamos por longitud de mensaje — engaña.
- **Costos**: derivados de tokens × precio por modelo en una tabla de pricing en código (actualizable por config). Gap honesto cuando el CLI no expone tokens.
- **Phone-home: NO en v0.1**. Todo local. Si en v0.2 agregamos opt-in a Argus team, será granular y consentido explícito.
- **`argus stats`**: queries pre-cocidas:
  - `argus stats today`
  - `argus stats workspace ${id}`
  - `argus stats workspace ${id} --cost`
  - `argus stats by-cli` (uso/costo agregado por tipo de CLI)
- **GUI charts**: v0.2.

---

## 17. `state.json` shape (A17)

### Path

`%LOCALAPPDATA%\Argus\state\workspaces\${id}.json` — un archivo per Workspace.

### Schema

```json
{
  "schemaVersion": 1,
  "id": "auth-flow",
  "createdAt": "2026-05-08T10:00:00Z",
  "repoPath": "C:\\Users\\lauta\\projects\\argus",
  "agentRatio": [
    {"cli": "claude", "count": 5},
    {"cli": "codex", "count": 3}
  ],
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
  "plan": {
    "path": ".workspace/plan.md",
    "approvedAt": "2026-05-08T10:15:00Z"
  },
  "mergeState": null
}
```

### Reglas

- **Atomic write**: `${id}.json.tmp` + `fsync` + `rename`. Una escritura por cambio.
- **Versionado**: `schemaVersion` entero. Migrations en código al leer.
- **Intent-only**: sin PIDs, sin handles, sin sockets, sin paths runtime.
- **`lastKnownState` es hint**, no source of truth. Solo afecta primer paint post-recovery.
- **`userClosed: true`** indica que el user cerró la pane explícitamente — recovery NO la relanza. Diferencia clave con `lastKnownState: 'dead'`.
- **`mergeState`**: `null` o `{phase, preMergeTag, startedAt, currentWorker?}`. Si argusd crashea durante un merge, recovery sabe que hay que ofrecer al user reanudar o revertir.

---

## 18. Merge agent (A18)

### Spawn

El workspace-child invoca:
```
argusd --mode merge-agent --workspace ${id} --pre-merge-tag ${tag}
```

Mismo binario, modo distinto via `argv[0]`-style dispatch (consistente con A8). Hereda `ARGUS_PIPE` para reportar al daemon.

### API

El merge-agent expone su propio `paneId` ephemeral (`pane-merge-${ts}`) y emite los `AdapterEvent` regulares más eventos extra:

```ts
type MergeEvent =
  | { kind: 'merge.phase'; phase: 'tagging'|'merging'|'resolving'|'testing'|'complete'|'reverted'; workerIdx?: number }
  | { kind: 'merge.conflict.semantic'; file: string; subAgentId: string }
  | { kind: 'merge.conflict.escalate'; file: string; reason: string }
  | { kind: 'merge.testResult'; passed: boolean; output: string };
```

### Mecánica

- **Sub-agents para conflicts semánticos**: `claude`/`codex` regulares spawneados por el merge-agent con context constrained (archivo en conflicto + diff de los workers involucrados). Aparecen en GUI como **sub-panes** del pane-merge, no como panes regulares del workspace.
- **`merge.cancel`**: el daemon manda SIGTERM al merge-agent, espera 5s, después SIGKILL. Acto seguido `git reset --hard ${preMergeTag}` y emite `merge.phase: reverted`.
- **El merge-agent NO está sandboxed**: es el único proceso autorizado a tocar `main`. Auditoría va al `merge-log.md` per-merge.
- **Tests post-merge**: corre `verify_command` (default `npm test`, configurable per-workspace en `.workspace/config.json`). Timeout default 5 min. Fail → revert automático.
- **Idempotencia**: si argusd crashea durante el merge, `mergeState` en `state.json` permite recovery — al boot, daemon ofrece al user "merge interrumpido en fase X. ¿reanudar o revertir?".

---

## 19. Test runner split: vitest + bun test (A19)

### Decisión

Dos test runners, divididos por runtime de producción:

- **vitest** para todos los módulos que corren bajo Node en prod: `argusd`, `workspace-child`, adapters, sandbox, worktree-manager, merge-runner, metrics-store, logger, pipe-server, GUI logic (renderer + main process).
- **bun test** para el paquete del CLI binary (`cli/`) que se compila con `bun build --compile` (A8) y corre bajo Bun runtime en prod: pipe-client, cli-router, doctor, sentinel commands.

### Reglas

- **Línea divisoria**: directorio, no nombre de archivo. Tests bajo `cli/` corren con bun test; el resto con vitest.
- **Convención de archivos**: `*.test.ts` colocado al lado del módulo (per PRD §Testing Decisions).
- **Fixtures**: `<module>/__fixtures__/` (per PRD).
- **TypeScript end-to-end** (consistente con A6): ambos runners corren TS sin transpile step manual.
- **CI**: dos pasos secuenciales — `npm test` (vitest) y `bun test cli/`. Ambos deben pasar para mergear.
- **Tests external-behavior only**: no mocking de parsers, git, SQL, ni helpers internos (per PRD §What makes a good test here).

### Por qué split y no un solo runner

- argusd y workspace-child usan named pipes Win32, `child_process.fork`, y fsync semantics que son Node-nativos. Testearlos bajo Bun puede esconder bugs runtime-específicos.
- El CLI binary se distribuye como ejecutable Bun-compilado. Sus dependencies (named pipe client, argv dispatch) deben verificarse en el runtime que el usuario va a ejecutar.
- "Pasa en CI con runner X, falla en prod con runtime Y" es exactamente el bug que el split previene.

### Costo aceptado

- Dos configs (`vitest.config.ts` + `bunfig.toml`).
- Dos pasos en CI.
- Disciplina sobre dónde vive cada test (resuelta por la regla del directorio).

---

## 20. Installer toolchain y postura de signing (A20)

### Decisión

- **Toolchain**: Inno Setup (script `installer/argus.iss`).
- **Signing**: sin firma en v0.1.
- **Ubicación**: per-user en `%LOCALAPPDATA%\Programs\Argus` (`{userpf}\Argus` en Inno).
- **PATH**: el instalador agrega `%LOCALAPPDATA%\Programs\Argus\bin` al `PATH` del usuario (vía `HKCU\Environment`). Tanto `argus.exe` como `workspace.exe` viven en ese subdirectorio.
- **Shortcuts**: solo Start menu, apuntando a `Argus.exe`.
- **Uninstaller**: limpia el directorio de instalación y la entrada del `PATH`. **No** toca `%LOCALAPPDATA%\Argus\` (state, logs, metrics) — esos datos persisten cross-reinstall, consistente con A17.
- **Distribución**: artefacto `Argus-Setup.exe` producido por GitHub Actions (`.github/workflows/release.yml`) cuando se pushea un tag `v*`.

### Por qué Inno Setup

- Script declarativo de ~80 líneas, un único `.exe` autocontenido como salida.
- Soporte nativo para PATH manipulation, Start menu shortcuts, y per-user install sin UAC.
- Maduro (1997+), gratis, sin lock-in: si v0.2 quiere migrar a Squirrel para auto-updates, los assets producidos por la build pipeline (daemon + Electron app + CLIs) son agnósticos al toolchain.
- Alternativas descartadas:
  - **Squirrel.Windows**: auto-updater built-in pero asume layout Electron-único; meter `argusd` y dos CLIs requiere hooks custom. Reevaluar en v0.2 cuando A11 (auto-updater) entre en scope.
  - **WiX**: sobreingeniería para el caso (XML verboso, MSI necesario solo para distribución corporativa).
  - **NSIS**: capacidad equivalente a Inno con peor lenguaje de scripting; sin razón sobre Inno.

### Por qué sin firma en v0.1

- v0.1 es para dogfooding personal del autor (foundations §5.3, dos semanas). El warning de SmartScreen es bypassable con "More info → Run anyway" y el costo de un cert OV/EV (USD 200-600/año) no se justifica sobre una sola máquina.
- Self-signing produce **el mismo** warning que sin firmar (Windows no confía en CAs que no están en su store), entonces ejercitar el pipeline de signing temprano da poco valor.
- En v0.2, si la app sale al público, se compra cert OV (reputación SmartScreen gana con descargas) o EV (reputación inmediata, requiere token físico).

### Per-user vs machine-wide

- `%LOCALAPPDATA%\Programs\Argus` evita UAC en install y uninstall.
- Coincide con la ubicación de state/logs/metrics (`%LOCALAPPDATA%\Argus\`), manteniendo el footprint del usuario en un solo árbol.
- Sigue la convención moderna (VS Code, Discord, Slack). Microsoft está empujando per-user install para apps modernas.
- Single-user es asunción válida en v0.1 (foundations §5.1).

### Lo que la build pipeline tiene que producir antes del instalador

El `.iss` asume que estos artefactos ya existen en `dist/` cuando se invoca `ISCC.exe`:

- `dist/daemon/argusd.exe` — daemon Node compilado (TODO: definir herramienta de compilación; candidatos: `pkg`, `node --experimental-sea-config`, o Bun como segundo runtime).
- `dist/gui/Argus.exe` + recursos — Electron app empaquetada (candidato: `electron-builder` con `target: dir`).
- `dist/cli/argus.exe` — Bun-compiled CLI (per A8).
- `dist/cli/workspace.exe` — copia bit-for-bit de `argus.exe` con nombre distinto (per A8, dispatch por `argv[0]`).

Estos pasos quedan como TODO explícito en el workflow. La compilación real y el smoke test en VM limpia (acceptance criterion del issue #17) se hacen manualmente la primera vez para validar el pipeline antes de marcarlo automatizado.

### Costo aceptado

- Un script `.iss` extra que mantener cuando cambien los binarios distribuidos.
- Un workflow que solo corre en push de tag (no en cada PR), para no gastar minutos de CI compilando un instalador que nadie va a usar.
- Cert signing pendiente para v0.2 — usuarios externos van a ver SmartScreen warnings hasta entonces.
