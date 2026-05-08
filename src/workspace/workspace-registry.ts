import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  type WorkspaceState,
  type WorkspaceSummary,
  type CreateWorkspaceParams,
} from './workspace-types.js';

export interface WorkspaceRegistry {
  create(params: CreateWorkspaceParams): Promise<WorkspaceState>;
  list(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceState>;
  delete(id: string): Promise<void>;
}

function statePath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

function migrate(state: Record<string, unknown>): WorkspaceState {
  const version = (state.schemaVersion as number) ?? 0;
  if (version < CURRENT_SCHEMA_VERSION) {
    state.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  return state as unknown as WorkspaceState;
}

function readState(filePath: string): WorkspaceState {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const originalVersion = (raw.schemaVersion as number) ?? 0;
  const state = migrate(raw);
  if (originalVersion < CURRENT_SCHEMA_VERSION) {
    atomicWrite(filePath, JSON.stringify(state, null, 2));
  }
  return state;
}

export function createWorkspaceRegistry(stateDir: string): WorkspaceRegistry {
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    async create(params) {
      const filePath = statePath(stateDir, params.name);
      if (fs.existsSync(filePath)) {
        throw new Error(`Workspace "${params.name}" already exists`);
      }

      const state: WorkspaceState = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: params.name,
        name: params.name,
        createdAt: new Date().toISOString(),
        repoPath: params.repoPath,
        agentRatio: params.agentRatio,
        panes: [],
        plan: params.plan ? { path: params.plan, approvedAt: null } : null,
        mergeState: null,
      };

      atomicWrite(filePath, JSON.stringify(state, null, 2));
      return state;
    },

    async list() {
      let files: string[];
      try {
        files = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }

      return files.map((file): WorkspaceSummary => {
        const state = readState(path.join(stateDir, file));
        return {
          id: state.id,
          name: state.name,
          createdAt: state.createdAt,
          repoPath: state.repoPath,
          agentRatio: state.agentRatio,
          paneCount: state.panes.length,
        };
      });
    },

    async get(id) {
      const filePath = statePath(stateDir, id);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Workspace "${id}" not found`);
      }
      return readState(filePath);
    },

    async delete(id) {
      const filePath = statePath(stateDir, id);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Workspace "${id}" not found`);
      }
      fs.unlinkSync(filePath);
    },
  };
}
