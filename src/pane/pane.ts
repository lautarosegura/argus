import { ClaudeAdapter } from './claude-adapter.js';
import type {
  Adapter,
  AdapterContext,
  AdapterEvent,
  IPty,
  LivePaneState,
} from './adapter-types.js';

export interface PaneEventNotification {
  workspaceId: string;
  paneId: string;
  event: AdapterEvent;
}

export interface Pane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly cliKind: string;
  readonly state: LivePaneState;
  readonly disposed: boolean;
  send(text: string): void;
  interrupt(): void;
  decideToolCall(id: string, decision: 'allow' | 'deny', reason?: string): void;
  decidePermission(id: string, decision: 'allow' | 'deny', reason?: string): void;
  onEvent(handler: (notification: PaneEventNotification) => void): void;
  dispose(): Promise<void>;
}

export interface CreatePaneOptions {
  pty: IPty;
  cliKind: string;
  ctx: AdapterContext;
}

function createAdapter(cliKind: string): Adapter {
  switch (cliKind) {
    case 'claude':
      return new ClaudeAdapter();
    default:
      throw new Error(`Unknown CLI kind: ${cliKind}`);
  }
}

export function createPane(opts: CreatePaneOptions): Pane {
  const { pty, cliKind, ctx } = opts;
  const adapter = createAdapter(cliKind);

  let currentState: LivePaneState = 'idle';
  let isDisposed = false;
  const eventHandlers: ((n: PaneEventNotification) => void)[] = [];

  function notify(event: AdapterEvent): void {
    const notification: PaneEventNotification = {
      workspaceId: ctx.workspaceId,
      paneId: ctx.paneId,
      event,
    };
    for (const handler of eventHandlers) {
      handler(notification);
    }
  }

  adapter.on('event', (event: AdapterEvent) => {
    if (event.kind === 'state') {
      currentState = event.state;
    }
    notify(event);
  });

  adapter.start(pty, ctx);

  return {
    get paneId() {
      return ctx.paneId;
    },
    get workspaceId() {
      return ctx.workspaceId;
    },
    get cliKind() {
      return cliKind;
    },
    get state() {
      return currentState;
    },
    get disposed() {
      return isDisposed;
    },
    send(text: string) {
      adapter.sendInput(text);
    },
    interrupt() {
      adapter.interrupt();
    },
    decideToolCall(id, decision, reason) {
      adapter.decideToolCall(id, decision, reason);
    },
    decidePermission(id, decision, reason) {
      adapter.decidePermission(id, decision, reason);
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    async dispose() {
      if (isDisposed) return;
      isDisposed = true;
      await adapter.dispose();
    },
  };
}
