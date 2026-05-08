import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  LineBuffer,
  encodeMessage,
  isRequest,
  makeResponse,
  makeError,
  makeNotification,
  toErrorMessage,
} from '../shared/json-rpc.js';
import {
  PROTOCOL_VERSION,
  DAEMON_VERSION,
  RpcErrorCode,
  type DaemonStatusResult,
} from '../shared/protocol.js';
import { createWorkspaceRegistry, type WorkspaceRegistry } from '../workspace/workspace-registry.js';
import type { CreateWorkspaceParams } from '../workspace/workspace-types.js';
import { provisionWorkspace, cleanWorkspace } from '../workspace/worktree-manager.js';
import { createPaneManager } from '../pane/pane-manager.js';
import { parsePlan, readPlanFile, writePlanFile } from '../plan/plan.js';
import { buildWorkerPrompt } from '../plan/prompts.js';
import { createMergeRun, type MergeRun } from '../merge/merge-runner.js';
import { createSubAgentResolver } from '../merge/sub-agent.js';
import path from 'node:path';

export interface DaemonOptions {
  pipePath: string;
  idleShutdownMs: number;
  stateDir?: string;
}

export interface Daemon extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'stopped', listener: () => void): this;
}

export function createDaemon(opts: DaemonOptions): Daemon {
  const emitter = new EventEmitter() as Daemon;
  const startedAt = Date.now();
  let server: net.Server | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const clients = new Set<net.Socket>();

  const registry: WorkspaceRegistry | null = opts.stateDir
    ? createWorkspaceRegistry(opts.stateDir)
    : null;

  const paneManager = createPaneManager();
  const activeMergeRuns = new Map<string, MergeRun>();

  async function handleRequest(req: JsonRpcRequest, socket: net.Socket): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;

    if (params.protocolVersion !== undefined && params.protocolVersion !== PROTOCOL_VERSION) {
      socket.write(
        encodeMessage(
          makeError(req.id, RpcErrorCode.PROTOCOL_VERSION_MISMATCH, 'ProtocolVersionMismatch', {
            expected: PROTOCOL_VERSION,
            got: params.protocolVersion,
          }),
        ),
      );
      return;
    }

    switch (req.method) {
      case 'daemon.status': {
        let workspaceCount = 0;
        if (registry) {
          const list = await registry.list();
          workspaceCount = list.length;
        }
        const result: DaemonStatusResult = {
          version: DAEMON_VERSION,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          workspaceCount,
          protocolVersion: PROTOCOL_VERSION,
        };
        socket.write(encodeMessage(makeResponse(req.id, result)));
        break;
      }

      case 'daemon.shutdown': {
        const graceMs = typeof params.graceMs === 'number' ? params.graceMs : 0;
        for (const client of clients) {
          client.write(encodeMessage(makeNotification('daemon.shuttingDown', { graceMs })));
        }
        socket.write(encodeMessage(makeResponse(req.id, {})));
        setTimeout(() => {
          void stopServer();
        }, graceMs);
        break;
      }

      case 'workspace.create': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const createParams = params as unknown as CreateWorkspaceParams;
          const state = await registry.create(createParams);
          const panes = await provisionWorkspace(
            state.repoPath,
            state.name,
            state.agentRatio,
          );
          state.panes = panes;
          await registry.update(state);
          socket.write(encodeMessage(makeResponse(req.id, { workspaceId: state.id })));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, toErrorMessage(err))));
        }
        break;
      }

      case 'workspace.list': {
        if (!registry) {
          socket.write(encodeMessage(makeResponse(req.id, { workspaces: [] })));
          break;
        }
        const workspaces = await registry.list();
        socket.write(encodeMessage(makeResponse(req.id, { workspaces })));
        break;
      }

      case 'workspace.get': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, 'No state directory configured')));
          break;
        }
        try {
          const workspace = await registry.get(params.id as string);
          socket.write(encodeMessage(makeResponse(req.id, { workspace })));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'workspace.delete': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, 'No state directory configured')));
          break;
        }
        try {
          if (params.cleanWorktrees) {
            const state = await registry.get(params.id as string);
            await cleanWorkspace(state.repoPath, state.panes);
          }
          await registry.delete(params.id as string);
          socket.write(encodeMessage(makeResponse(req.id, {})));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'workspace.attach': {
        const workspaceId = params.id as string;
        paneManager.attach(workspaceId, socket);
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'workspace.detach': {
        const workspaceId = params.id as string;
        paneManager.detach(workspaceId, socket);
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'pane.send': {
        const pane = paneManager.getPane(params.paneId as string);
        if (!pane) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.PANE_DEAD, `Pane not found: ${params.paneId}`)));
          break;
        }
        pane.send(params.text as string);
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'pane.interrupt': {
        const pane = paneManager.getPane(params.paneId as string);
        if (!pane) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.PANE_DEAD, `Pane not found: ${params.paneId}`)));
          break;
        }
        pane.interrupt();
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'sentinel.report': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        const workspaceId = params.workspaceId as string;
        const paneId = params.paneId as string;
        const cmd = params.cmd as 'done' | 'blocked' | 'status';
        const payload = params.payload;

        try {
          const state = await registry.get(workspaceId);
          const paneState = state.panes.find((p) => p.paneId === paneId);
          if (!paneState) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.PANE_DEAD, `Pane not found: ${paneId}`)));
            break;
          }

          paneManager.reportSentinel({ workspaceId, paneId, cmd, payload });

          if (cmd === 'done' || cmd === 'blocked') {
            paneState.lastKnownState = cmd;
            await registry.update(state);
          }

          socket.write(encodeMessage(makeResponse(req.id, {})));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'pane.decideTool': {
        const pane = paneManager.getPane(params.paneId as string);
        if (!pane) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.PANE_DEAD, `Pane not found: ${params.paneId}`)));
          break;
        }
        pane.decideToolCall(
          params.toolId as string,
          params.decision as 'allow' | 'deny',
          params.reason as string | undefined,
        );
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'pane.decidePermission': {
        const pane = paneManager.getPane(params.paneId as string);
        if (!pane) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.PANE_DEAD, `Pane not found: ${params.paneId}`)));
          break;
        }
        pane.decidePermission(
          params.permissionId as string,
          params.decision as 'allow' | 'deny',
          params.reason as string | undefined,
        );
        socket.write(encodeMessage(makeResponse(req.id, {})));
        break;
      }

      case 'plan.update': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const state = await registry.get(params.workspaceId as string);
          if (!state.plan) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'Plan not configured for this workspace')));
            break;
          }
          if (state.plan.approvedAt) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'Plan already approved — cannot update')));
            break;
          }
          const planPath = path.join(state.repoPath, state.plan.path);
          writePlanFile(planPath, params.content as string);
          socket.write(encodeMessage(makeResponse(req.id, {})));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'plan.get': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const state = await registry.get(params.workspaceId as string);
          if (!state.plan) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'Plan not configured for this workspace')));
            break;
          }
          const planPath = path.join(state.repoPath, state.plan.path);
          const content = readPlanFile(planPath);
          socket.write(encodeMessage(makeResponse(req.id, {
            content,
            approvedAt: state.plan.approvedAt,
          })));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'plan.approve': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const state = await registry.get(params.workspaceId as string);
          if (!state.plan) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'Plan not configured for this workspace')));
            break;
          }
          if (state.plan.approvedAt) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'Plan already approved')));
            break;
          }
          const planPath = path.join(state.repoPath, state.plan.path);
          const content = readPlanFile(planPath);
          if (!content) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'No plan content — write the plan before approving')));
            break;
          }
          const plan = parsePlan(content);
          const approvedAt = new Date().toISOString();
          state.plan.approvedAt = approvedAt;
          await registry.update(state);

          const workerAssignments: Array<{ paneId: string; taskId: string; systemPrompt: string }> = [];
          for (const task of plan.tasks) {
            const paneState = state.panes.find(
              (p) => p.paneId === task.assignedTo && p.role === 'worker',
            );
            if (!paneState) continue;
            const systemPrompt = buildWorkerPrompt({
              workspaceName: state.name,
              repoPath: state.repoPath,
              intent: state.intent,
              plan,
              taskId: task.id,
              paneId: paneState.paneId,
            });
            workerAssignments.push({
              paneId: paneState.paneId,
              taskId: task.id,
              systemPrompt,
            });
          }

          paneManager.broadcastNotification(state.id, 'plan.approved', {
            workspaceId: state.id,
            workerAssignments: workerAssignments.map(({ paneId, taskId }) => ({ paneId, taskId })),
          });

          socket.write(encodeMessage(makeResponse(req.id, {
            approvedAt,
            tasks: plan.tasks,
            workerAssignments,
          })));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'merge.start': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const state = await registry.get(params.workspaceId as string);

          if (activeMergeRuns.has(state.id)) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.MERGE_IN_PROGRESS, 'Merge already in progress')));
            break;
          }

          const workers = state.panes.filter((p) => p.role === 'worker');
          const notDone = workers.filter((p) => p.lastKnownState !== 'done');
          if (notDone.length > 0) {
            socket.write(encodeMessage(makeError(
              req.id,
              RpcErrorCode.MERGE_NOT_READY,
              `Workers not done: ${notDone.map((p) => p.paneId).join(', ')}`,
            )));
            break;
          }

          let branchOrder = workers.map((p) => p.branchName);
          if (state.plan?.approvedAt) {
            const planPath = path.join(state.repoPath, state.plan.path);
            const content = readPlanFile(planPath);
            if (content) {
              const plan = parsePlan(content);
              branchOrder = plan.tasks
                .map((t) => state.panes.find((p) => p.paneId === t.assignedTo))
                .filter((p): p is NonNullable<typeof p> => p !== undefined)
                .map((p) => p.branchName);
            }
          }

          const verifyCommand = typeof params.verifyCommand === 'string'
            ? params.verifyCommand
            : 'npm test';
          const mergeLogPath = path.join(state.repoPath, '.workspace', 'merge-log.md');

          const preferredCli = state.agentRatio[0]?.cli === 'codex' ? 'codex' : 'claude';

          let mergeRunId = '';
          const run = createMergeRun({
            repoPath: state.repoPath,
            branchOrder,
            verifyCommand,
            mergeLogPath,
            onProgress: (phase, detail) => {
              paneManager.broadcastNotification(state.id, 'merge.progress', {
                workspaceId: state.id,
                mergeRunId,
                phase,
                ...(detail !== undefined && { detail }),
              });
            },
            subAgentResolver: createSubAgentResolver({ cli: preferredCli }),
            subAgentTimeoutMs: typeof params.subAgentTimeoutMs === 'number'
              ? params.subAgentTimeoutMs
              : 300_000,
          });
          mergeRunId = run.state.mergeRunId;

          state.mergeState = run.state;
          await registry.update(state);

          activeMergeRuns.set(state.id, run);

          run.promise.then(async (finalState) => {
            activeMergeRuns.delete(state.id);
            try {
              const current = await registry!.get(state.id);
              current.mergeState = finalState;
              await registry!.update(current);
            } catch {}
          }).catch(() => {
            activeMergeRuns.delete(state.id);
          });

          socket.write(encodeMessage(makeResponse(req.id, {
            mergeRunId: run.state.mergeRunId,
          })));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.WORKSPACE_NOT_FOUND, toErrorMessage(err))));
        }
        break;
      }

      case 'merge.cancel': {
        if (!registry) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, 'No state directory configured')));
          break;
        }
        try {
          const workspaceId = params.workspaceId as string;
          const run = activeMergeRuns.get(workspaceId);
          if (!run) {
            socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INVALID_PARAMS, 'No active merge to cancel')));
            break;
          }
          run.cancel();
          socket.write(encodeMessage(makeResponse(req.id, {})));
        } catch (err) {
          socket.write(encodeMessage(makeError(req.id, RpcErrorCode.INTERNAL_ERROR, toErrorMessage(err))));
        }
        break;
      }

      default:
        socket.write(
          encodeMessage(
            makeError(req.id, RpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${req.method}`),
          ),
        );
    }
  }

  function handleMessage(msg: JsonRpcMessage, socket: net.Socket): void {
    if (isRequest(msg)) {
      void handleRequest(msg, socket);
    }
  }

  function startIdleTimer(): void {
    if (opts.idleShutdownMs <= 0) return;
    idleTimer = setTimeout(() => {
      void stopServer();
    }, opts.idleShutdownMs);
  }

  async function stopServer(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const client of clients) {
      client.destroy();
    }
    clients.clear();
    return new Promise<void>((resolve) => {
      if (!server) {
        emitter.emit('stopped');
        resolve();
        return;
      }
      server.close(() => {
        cleanupSocketFile();
        emitter.emit('stopped');
        resolve();
      });
    });
  }

  function cleanupSocketFile(): void {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(opts.pipePath);
      } catch {}
    }
  }

  function createServer(): net.Server {
    return net.createServer((socket) => {
      clients.add(socket);
      const buf = new LineBuffer();
      socket.on('data', (chunk) => {
        const messages = buf.append(chunk.toString());
        for (const msg of messages) {
          handleMessage(msg, socket);
        }
      });
      socket.on('close', () => {
        clients.delete(socket);
      });
      socket.on('error', () => {
        clients.delete(socket);
      });
    });
  }

  function tryListen(srv: net.Server, pipePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      srv.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });
      srv.listen(pipePath, resolve);
    });
  }

  function isSocketLive(pipePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.createConnection(pipePath, () => {
        probe.end();
        resolve(true);
      });
      probe.on('error', () => {
        resolve(false);
      });
    });
  }

  emitter.start = async (): Promise<void> => {
    server = createServer();
    try {
      await tryListen(server, opts.pipePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EADDRINUSE') throw err;
      if (process.platform === 'win32') {
        throw new Error(`Pipe already in use: ${opts.pipePath}`);
      }
      const live = await isSocketLive(opts.pipePath);
      if (live) {
        throw new Error(`Pipe already in use: ${opts.pipePath}`);
      }
      fs.unlinkSync(opts.pipePath);
      server = createServer();
      await tryListen(server, opts.pipePath);
    }
    startIdleTimer();
  };

  emitter.stop = stopServer;

  return emitter;
}
