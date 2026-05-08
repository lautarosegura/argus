import net from 'node:net';
import {
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
  LineBuffer,
  encodeMessage,
  makeRequest,
} from '../shared/json-rpc.js';

export interface PipeClient {
  connect(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  destroy(): void;
}

export function createPipeClient(pipePath: string): PipeClient {
  let socket: net.Socket | null = null;
  let nextId = 1;
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  const buf = new LineBuffer();

  function handleMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && msg.id !== undefined && msg.id !== null) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      const resp = msg as JsonRpcResponse;
      if ('error' in resp) {
        entry.reject(new Error(resp.error.message));
      } else {
        entry.resolve(resp.result);
      }
    } else if ('method' in msg) {
      for (const handler of notificationHandlers) {
        handler(msg.method, (msg as JsonRpcNotification).params);
      }
    }
  }

  return {
    connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        socket = net.createConnection(pipePath, () => {
          resolve();
        });
        socket.on('data', (chunk) => {
          const messages = buf.append(chunk.toString());
          for (const msg of messages) {
            handleMessage(msg);
          }
        });
        socket.on('error', (err) => {
          reject(err);
          for (const [, entry] of pending) {
            entry.reject(err as Error);
          }
          pending.clear();
        });
      });
    },

    request(method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!socket || socket.destroyed) {
          reject(new Error('Not connected'));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.write(encodeMessage(makeRequest(id, method, params)));
      });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },

    destroy() {
      if (socket) {
        socket.destroy();
        socket = null;
      }
      for (const [, entry] of pending) {
        entry.reject(new Error('Client destroyed'));
      }
      pending.clear();
    },
  };
}
