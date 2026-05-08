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
} from '../shared/json-rpc.js';
import {
  PROTOCOL_VERSION,
  DAEMON_VERSION,
  RpcErrorCode,
  type DaemonStatusResult,
} from '../shared/protocol.js';

export interface DaemonOptions {
  pipePath: string;
  idleShutdownMs: number;
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

  function handleRequest(req: JsonRpcRequest, socket: net.Socket): void {
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
        const result: DaemonStatusResult = {
          version: DAEMON_VERSION,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          workspaceCount: 0,
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
      handleRequest(msg, socket);
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
