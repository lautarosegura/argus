import type { AdapterEvent, IPty, AdapterContext } from './adapter-types.js';
import { createPane, type Pane, type PaneEventNotification } from './pane.js';
import type net from 'node:net';

export interface PaneManager {
  createPane(pty: IPty, cliKind: string, ctx: AdapterContext): Pane;
  getPane(paneId: string): Pane | undefined;
  listPanes(workspaceId: string): Pane[];
  removePane(paneId: string): void;
  attach(workspaceId: string, socket: net.Socket): void;
  detach(workspaceId: string, socket: net.Socket): void;
  formatNotification(n: PaneEventNotification): object;
}

export function createPaneManager(): PaneManager {
  const panes = new Map<string, Pane>();
  const subscriptions = new Map<string, Set<net.Socket>>();

  return {
    createPane(pty, cliKind, ctx) {
      const pane = createPane({ pty, cliKind, ctx });

      pane.onEvent((notification) => {
        const subs = subscriptions.get(notification.workspaceId);
        if (!subs) return;

        const msg = this.formatNotification(notification);
        const encoded = JSON.stringify(msg) + '\n';
        for (const socket of subs) {
          socket.write(encoded);
        }
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
      let subs = subscriptions.get(workspaceId);
      if (!subs) {
        subs = new Set();
        subscriptions.set(workspaceId, subs);
      }
      subs.add(socket);

      socket.on('close', () => {
        subs!.delete(socket);
        if (subs!.size === 0) {
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

    formatNotification(n) {
      const event = { ...n.event } as Record<string, unknown>;
      if (n.event.kind === 'output') {
        event.bytes = (n.event as { bytes: Buffer }).bytes.toString('base64');
      }
      return {
        jsonrpc: '2.0',
        method: 'pane.event',
        params: {
          workspaceId: n.workspaceId,
          paneId: n.paneId,
          event,
        },
      };
    },
  };
}
