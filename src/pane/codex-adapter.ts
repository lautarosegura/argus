import {
  Adapter,
  MAX_PARSE_BUFFER_BYTES,
  type AdapterContext,
  type AdapterEvent,
  type IPty,
  type LivePaneState,
} from './adapter-types.js';

interface CodexContentPart {
  type: string;
  text?: string;
}

interface CodexStreamEvent {
  type: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  id?: string;
  call_id?: string;
  role?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: CodexContentPart[];
  summary?: CodexContentPart[];
  status?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  cost_usd?: number;
}

export class CodexAdapter extends Adapter {
  readonly cliKind = 'codex' as const;
  private pty: IPty | null = null;
  private buffer = '';
  private currentState: LivePaneState | null = null;
  private disposed = false;

  start(pty: IPty, _ctx: AdapterContext): void {
    this.pty = pty;

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
    this.pty.write(JSON.stringify({ type: 'tool_decision', call_id: id, decision }) + '\n');
  }

  decidePermission(id: string, decision: 'allow' | 'deny', _reason?: string): void {
    if (!this.pty) return;
    this.pty.write(JSON.stringify({ type: 'permission_decision', call_id: id, decision }) + '\n');
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
    let event: CodexStreamEvent;
    try {
      event = JSON.parse(line) as CodexStreamEvent;
    } catch {
      this.emit('event', {
        kind: 'error',
        source: 'parser',
        message: `Failed to parse Codex stream line: ${line.slice(0, 200)}`,
      } satisfies AdapterEvent);
      return;
    }

    switch (event.type) {
      case 'session.start':
        break;

      case 'reasoning':
        this.handleReasoning(event);
        break;

      case 'message':
        this.handleMessage(event);
        break;

      case 'function_call':
        this.handleFunctionCall(event);
        break;

      case 'function_call_output':
        break;

      case 'session.complete':
        this.handleSessionComplete(event);
        break;
    }
  }

  private handleReasoning(event: CodexStreamEvent): void {
    this.transitionState('thinking');
    const text = event.summary
      ?.filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('') ?? '';
    this.emit('event', {
      kind: 'thinking',
      text,
      partial: false,
    } satisfies AdapterEvent);
  }

  private handleMessage(event: CodexStreamEvent): void {
    if (!event.content) return;

    this.transitionState('thinking');

    for (const part of event.content) {
      if (part.type === 'output_text') {
        this.emit('event', {
          kind: 'message',
          role: 'assistant',
          text: part.text ?? '',
          partial: false,
        } satisfies AdapterEvent);
      }
    }
  }

  private handleFunctionCall(event: CodexStreamEvent): void {
    this.transitionState('toolUse');

    let args: unknown;
    try {
      args = event.arguments ? JSON.parse(event.arguments) : {};
    } catch {
      args = event.arguments;
    }

    this.emit('event', {
      kind: 'toolCall.requested',
      id: event.call_id ?? '',
      tool: event.name ?? '',
      args,
    } satisfies AdapterEvent);
  }

  private handleSessionComplete(event: CodexStreamEvent): void {
    if (event.status === 'error') {
      this.emit('event', {
        kind: 'error',
        source: 'cli',
        message: event.error ?? 'Unknown error',
      } satisfies AdapterEvent);
      return;
    }

    if (event.status === 'completed' && event.usage) {
      this.emit('event', {
        kind: 'usage',
        tokensIn: event.usage.input_tokens,
        tokensOut: event.usage.output_tokens,
        costUsd: event.cost_usd,
      } satisfies AdapterEvent);
    }
  }
}
