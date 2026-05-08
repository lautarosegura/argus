import type { IPty, AdapterContext } from './adapter-types.js';
import { createPane, type Pane } from './pane.js';
import { encodeMessage, makeNotification } from '../shared/json-rpc.js';
import type net from 'node:net';

export interface SentinelReport {
  workspaceId: string;
  paneId: string;
  cmd: 'done' | 'blocked' | 'status';
  payload: unknown;
}

export interface PaneManager {
  createPane(pty: IPty, cliKind: string, ctx: AdapterContext): Pane;
  getPane(paneId: string): Pane | undefined;
  listPanes(workspaceId: string): Pane[];
  removePane(paneId: string): void;
  attach(workspaceId: string, socket: net.Socket): void;
  detach(workspaceId: string, socket: net.Socket): void;
  broadcastNotification(workspaceId: string, method: string, params: Record<string, unknown>): void;
  reportSentinel(report: SentinelReport): void;
}

export function createPaneManager(): PaneManager {
  const panes = new Map<string, Pane>();
  const subscriptions = new Map<string, Set<net.Socket>>();

  function broadcast(workspaceId: string, paneId: string, event: Record<string, unknown>): void {
    const subs = subscriptions.get(workspaceId);
    if (!subs) return;
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'pane.event',
      params: { workspaceId, paneId, event },
    }) + '\n';
    for (const socket of subs) {
      socket.write(msg);
    }
  }

  return {
    createPane(pty, cliKind, ctx) {
      const pane = createPane({ pty, cliKind, ctx });

      pane.onEvent((notification) => {
        const event = { ...notification.event } as Record<string, unknown>;
        if (notification.event.kind === 'output') {
          event.bytes = notification.event.bytes.toString('base64');
        }
        broadcast(notification.workspaceId, notification.paneId, event);
      });

      panes.set(ctx.paneId, pane);
      return pane;
    },

    getPane(paneId) {
      return panes.get(paneId);
    },

    listPanes(workspaceId) {
      return Array.from(panes.values()).filter((p) => p.workspaceId === workspaceId);
    },

    removePane(paneId) {
      const pane = panes.get(paneId);
      if (pane) {
        void pane.dispose();
        panes.delete(paneId);
      }
    },

    attach(workspaceId, socket) {
      const subs = subscriptions.get(workspaceId) ?? new Set<net.Socket>();
      if (!subscriptions.has(workspaceId)) {
        subscriptions.set(workspaceId, subs);
      }
      subs.add(socket);

      socket.on('close', () => {
        subs.delete(socket);
        if (subs.size === 0) {
          subscriptions.delete(workspaceId);
        }
      });
    },

    detach(workspaceId, socket) {
      const subs = subscriptions.get(workspaceId);
      if (!subs) return;
      subs.delete(socket);
      if (subs.size === 0) {
        subscriptions.delete(workspaceId);
      }
    },

    broadcastNotification(workspaceId, method, params) {
      const subs = subscriptions.get(workspaceId);
      if (!subs) return;
      const msg = encodeMessage(makeNotification(method, params));
      for (const socket of subs) {
        socket.write(msg);
      }
    },

    reportSentinel(report) {
      broadcast(report.workspaceId, report.paneId, {
        kind: 'sentinel',
        cmd: report.cmd,
        payload: report.payload,
      });

      if (report.cmd === 'done' || report.cmd === 'blocked') {
        broadcast(report.workspaceId, report.paneId, {
          kind: 'state',
          state: report.cmd,
        });
      }
    },
  };
}
