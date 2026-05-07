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
| Schema concreto de eventos JSON-RPC (qué notifications, qué requests, qué tipos) | A definirse cuando empiece la implementación, emergente |
| Forma exacta de `state.json` (campos, versionado, migration) | Idem |
| Cómo se enchufa cada Adapter concretamente (interface TS, contract de events) | A grillar en sesión separada — es el corazón del producto |
| Detalles del flujo del Merge agent (subprocess de quién, qué API expone, cómo se cancela) | Idem |
| Auto-updater | Decisión pospuesta |
| Tray app / status indicator | v0.2 |
| Paquetes separables (engine standalone + GUI opcional) | v0.2 evaluación |
| Cross-platform (Mac, Linux) | v0.2+ — los path del pipe (`\\.\pipe\` vs Unix domain socket) cambian, pero la abstracción JSON-RPC es portable |
| Multi-instance simultáneo (dev y stable corriendo a la vez) | v0.2 — el override de `ARGUS_PIPE` ya lo permite, falta UX en CLI |

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

---

## 11. Open questions que NO resolvimos en esta sesión

- **Naming oficial del producto** — sigue siendo "Argus" tentativo (foundations §7).
- **Distribución / pricing / licensing** — no tocado.
- **Telemetría / observabilidad** del daemon — no tocado, importante para dogfooding.
- **Auth con los CLIs** — los `claude` / `codex` que argusd spawnea ¿asumen que el user ya hizo login en su terminal global?, ¿hay setup wizard?, ¿se hereda el env?
- **Logging del daemon y workspace-children** — dónde van los logs (`%LOCALAPPDATA%\Argus\logs\`), rotación, niveles.

Algunas de estas son urgencia v0.1, otras v0.2+. Worth tener una sesión específica antes de cerrar el shape de la app.
