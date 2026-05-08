import {
  Adapter,
  MAX_PARSE_BUFFER_BYTES,
  type AdapterContext,
  type AdapterEvent,
  type IPty,
  type LivePaneState,
  type SandboxFn,
} from './adapter-types.js';

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeMessage {
  id: string;
  type: string;
  role: string;
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: string | null;
  usage?: ClaudeUsage;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: ClaudeMessage;
  session_id?: string;
  tools?: string[];
  model?: string;
  error?: string;
  duration_ms?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  num_turns?: number;
}

export class ClaudeAdapter extends Adapter {
  readonly cliKind = 'claude' as const;
  private pty: IPty | null = null;
  private ctx: AdapterContext | null = null;
  private buffer = '';
  private currentState: LivePaneState | null = null;
  private disposed = false;

  constructor(private readonly sandbox?: SandboxFn) {
    super();
  }

  start(pty: IPty, ctx: AdapterContext): void {
    this.pty = pty;
    this.ctx = ctx;

    pty.onData((data: string) => {
      this.emit('event', { kind: 'output', bytes: Buffer.from(data) } satisfies AdapterEvent);

      this.buffer += data;

      if (this.buffer.length > MAX_PARSE_BUFFER_BYTES) {
        this.emit('event', {
          kind: 'error',
          source: 'parser',
          message: `Parse buffer exceeded ${MAX_PARSE_BUFFER_BYTES} bytes, killing pane`,
        } satisfies AdapterEvent);
        this.transitionState('dead', 'buffer overflow');
        pty.kill();
        return;
      }

      this.drainLines();
    });

    pty.onExit((e: { exitCode: number }) => {
      if (e.exitCode === 0) {
        this.transitionState('done');
      } else if (this.currentState !== 'dead') {
        this.transitionState('dead', `exit code ${e.exitCode}`);
      }
      this.emit('exit', e.exitCode);
    });

    this.transitionState('idle');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pty?.kill();
    this.pty = null;
    this.buffer = '';
  }

  sendInput(text: string): void {
    this.pty?.write(text);
  }

  decideToolCall(id: string, decision: 'allow' | 'deny', _reason?: string): void {
    if (!this.pty) return;
    this.pty.write(JSON.stringify({ type: 'tool_decision', id, decision }) + '\n');
  }

  decidePermission(id: string, decision: 'allow' | 'deny', _reason?: string): void {
    if (!this.pty) return;
    this.pty.write(JSON.stringify({ type: 'permission_decision', id, decision }) + '\n');
  }

  interrupt(): void {
    this.pty?.write('\x03');
  }

  private transitionState(state: LivePaneState, reason?: string): void {
    if (this.currentState === state) return;
    this.currentState = state;
    const event: AdapterEvent = reason
      ? { kind: 'state', state, reason }
      : { kind: 'state', state };
    this.emit('event', event);
  }

  private drainLines(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      this.emit('event', {
        kind: 'error',
        source: 'parser',
        message: `Failed to parse stream-json line: ${line.slice(0, 200)}`,
      } satisfies AdapterEvent);
      return;
    }

    switch (event.type) {
      case 'system':
        break;

      case 'assistant':
        this.handleAssistantMessage(event.message);
        break;

      case 'result':
        this.handleResult(event);
        break;
    }
  }

  private handleAssistantMessage(message: ClaudeMessage | undefined): void {
    if (!message?.content) return;

    for (const block of message.content) {
      switch (block.type) {
        case 'thinking':
          this.transitionState('thinking');
          this.emit('event', {
            kind: 'thinking',
            text: block.thinking ?? '',
            partial: false,
          } satisfies AdapterEvent);
          break;

        case 'text':
          this.transitionState('thinking');
          this.emit('event', {
            kind: 'message',
            role: 'assistant',
            text: block.text ?? '',
            partial: false,
          } satisfies AdapterEvent);
          break;

        case 'tool_use': {
          const toolId = block.id ?? '';
          const toolName = block.name ?? '';
          const toolArgs = block.input;
          const decision = this.sandbox && this.ctx
            ? this.sandbox({
                cli: this.cliKind,
                tool: toolName,
                args: toolArgs,
                worktreePath: this.ctx.worktreePath,
                paneRole: this.ctx.paneRole,
              })
            : undefined;

          this.transitionState('toolUse');
          this.emit('event', {
            kind: 'toolCall.requested',
            id: toolId,
            tool: toolName,
            args: toolArgs,
          } satisfies AdapterEvent);

          if (!decision) break;

          if (decision.kind === 'allow') {
            this.decideToolCall(toolId, 'allow');
            break;
          }

          if (decision.kind === 'deny') {
            this.emit('event', {
              kind: 'error',
              source: 'sandbox',
              message: decision.reason,
            } satisfies AdapterEvent);
            this.decideToolCall(toolId, 'deny', decision.reason);
            break;
          }

          this.transitionState('waitingPerm');
          this.emit('event', {
            kind: 'permissionRequest',
            id: toolId,
            what: `${toolName}: ${JSON.stringify(toolArgs)}`,
            risk: decision.risk,
          } satisfies AdapterEvent);
          break;
        }
      }
    }

    if (message.usage) {
      this.emit('event', {
        kind: 'usage',
        tokensIn: message.usage.input_tokens,
        tokensOut: message.usage.output_tokens,
      } satisfies AdapterEvent);
    }
  }

  private handleResult(event: ClaudeStreamEvent): void {
    if (event.subtype === 'error') {
      this.emit('event', {
        kind: 'error',
        source: 'cli',
        message: event.error ?? 'Unknown error',
      } satisfies AdapterEvent);
      return;
    }

    if (event.subtype === 'success') {
      this.emit('event', {
        kind: 'usage',
        tokensIn: event.input_tokens,
        tokensOut: event.output_tokens,
        costUsd: event.cost_usd,
      } satisfies AdapterEvent);
    }
  }
}
