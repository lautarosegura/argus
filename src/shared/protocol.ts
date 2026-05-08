import os from 'node:os';
import path from 'node:path';

export const PROTOCOL_VERSION = 1;
export const DAEMON_VERSION = '0.1.0';
export const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

export function getDefaultPipePath(): string {
  const user = os.userInfo().username;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\argus-${user}`;
  }
  return `/tmp/argus-${user}.sock`;
}

export function getPipePath(): string {
  return process.env.ARGUS_PIPE ?? getDefaultPipePath();
}

export function getStateDir(): string {
  if (process.env.ARGUS_STATE_DIR) {
    return process.env.ARGUS_STATE_DIR;
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Argus', 'state', 'workspaces');
  }
  return path.join(os.homedir(), '.local', 'share', 'argus', 'state', 'workspaces');
}

export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  WORKSPACE_NOT_FOUND: -32001,
  PANE_DEAD: -32002,
  WORKSPACE_LOCKED: -32003,
  PROTOCOL_VERSION_MISMATCH: -32004,
  SANDBOX_VIOLATION: -32005,
} as const;

export interface DaemonStatusResult {
  version: string;
  uptime: number;
  workspaceCount: number;
  protocolVersion: number;
}

export interface ShutdownParams {
  graceMs?: number;
}
