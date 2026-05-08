export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: number | string;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: unknown;
  id: number | string;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function encodeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    (msg as JsonRpcRequest).jsonrpc === '2.0' &&
    'method' in msg &&
    'id' in msg
  );
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    (msg as JsonRpcNotification).jsonrpc === '2.0' &&
    'method' in msg &&
    !('id' in msg)
  );
}

export function makeResponse(id: number | string, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', result, id };
}

export function makeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', error: { code, message, ...(data !== undefined && { data }) }, id };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
}

export function makeRequest(id: number | string, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }), id };
}

export class LineBuffer {
  private buffer = '';

  append(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // Malformed line — skip
      }
    }
    return messages;
  }
}
