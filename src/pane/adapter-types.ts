import { EventEmitter } from 'node:events';

export type LivePaneState =
  | 'idle'
  | 'thinking'
  | 'toolUse'
  | 'waitingPerm'
  | 'done'
  | 'blocked'
  | 'dead';

export type AdapterEvent =
  | { kind: 'output'; bytes: Buffer }
  | { kind: 'state'; state: LivePaneState; reason?: string }
  | { kind: 'message'; role: 'assistant'; text: string; partial: boolean }
  | { kind: 'thinking'; text: string; partial: boolean }
  | { kind: 'toolCall.requested'; id: string; tool: string; args: unknown }
  | { kind: 'toolCall.completed'; id: string; result: unknown; durationMs: number }
  | { kind: 'permissionRequest'; id: string; what: string; risk: 'low' | 'medium' | 'high' }
  | { kind: 'sentinel'; cmd: 'done' | 'blocked' | 'status'; payload: unknown }
  | { kind: 'usage'; tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { kind: 'error'; source: 'parser' | 'cli' | 'pty' | 'sandbox'; message: string };

export interface AdapterContext {
  worktreePath: string;
  paneId: string;
  workspaceId: string;
  paneRole: 'lead' | 'worker' | 'merge';
}

export interface IPty {
  readonly pid: number;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (e: { exitCode: number }) => void) => void;
  write(data: string): void;
  kill(signal?: string): void;
}

export interface AdapterEvents {
  event: [e: AdapterEvent];
  exit: [code: number | null];
}

export abstract class Adapter extends EventEmitter<AdapterEvents> {
  abstract readonly cliKind: 'claude' | 'codex';
  abstract start(pty: IPty, ctx: AdapterContext): void;
  abstract dispose(): Promise<void>;
  abstract sendInput(text: string): void;
  abstract decideToolCall(id: string, decision: 'allow' | 'deny', reason?: string): void;
  abstract decidePermission(id: string, decision: 'allow' | 'deny', reason?: string): void;
  abstract interrupt(): void;
}

export const MAX_PARSE_BUFFER_BYTES = 16 * 1024 * 1024;
