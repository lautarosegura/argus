import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHILD_MODULE = path.join(__dirname, 'workspace-child.js');

export interface WorkspaceSupervisorOptions {
  childModule?: string;
}

export interface WorkspaceSupervisor {
  spawn(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  kill(id: string): void;
  isRunning(id: string): boolean;
  runningIds(): string[];
  onExit(handler: (id: string, code: number | null) => void): void;
}

export function createWorkspaceSupervisor(opts?: WorkspaceSupervisorOptions): WorkspaceSupervisor {
  const childModule = opts?.childModule ?? DEFAULT_CHILD_MODULE;
  const children = new Map<string, ChildProcess>();
  const exitHandlers: ((id: string, code: number | null) => void)[] = [];

  function attachExitListener(id: string, child: ChildProcess): void {
    child.on('exit', (code) => {
      children.delete(id);
      for (const handler of exitHandlers) {
        handler(id, code);
      }
    });
  }

  return {
    spawn(id) {
      if (children.has(id)) {
        return Promise.reject(new Error(`Workspace "${id}" already running`));
      }

      return new Promise<void>((resolve, reject) => {
        const child = fork(childModule, [], {
          env: { ...process.env, ARGUS_WORKSPACE_ID: id },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });

        const onReady = (msg: unknown) => {
          const m = msg as { type: string };
          if (m.type === 'ready') {
            child.removeListener('message', onReady);
            child.removeListener('error', onError);
            children.set(id, child);
            attachExitListener(id, child);
            resolve();
          }
        };

        const onError = (err: Error) => {
          child.removeListener('message', onReady);
          reject(err);
        };

        child.on('message', onReady);
        child.on('error', onError);
      });
    },

    stop(id) {
      const child = children.get(id);
      if (!child) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
      });
    },

    async stopAll() {
      const stops = Array.from(children.keys()).map((id) => this.stop(id));
      await Promise.all(stops);
    },

    kill(id) {
      const child = children.get(id);
      if (child) {
        child.kill('SIGKILL');
      }
    },

    isRunning(id) {
      return children.has(id);
    },

    runningIds() {
      return Array.from(children.keys());
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },
  };
}
