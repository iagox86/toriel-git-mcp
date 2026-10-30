// Minimal MCP-over-stdio transport: newline-delimited JSON-RPC 2.0.
// Zero dependencies; only the methods pi's client actually uses.

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

const PROTOCOL_VERSION = "2025-06-18";

const ERR_PARSE = -32768;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

export interface ServerInfo {
  name: string;
  version: string;
}

export function handleRpcMessage(
  raw: string,
  handler: RpcHandler,
  serverInfo: ServerInfo,
): Promise<RpcResponse | null> {
  let request: RpcRequest;
  try {
    request = JSON.parse(raw) as RpcRequest;
  } catch {
    return Promise.resolve({
      jsonrpc: "2.0",
      id: null,
      error: { code: ERR_PARSE, message: "parse error" },
    });
  }
  if (typeof request !== "object" || request === null || typeof request.method !== "string") {
    return Promise.resolve({
      jsonrpc: "2.0",
      id: null,
      error: { code: ERR_PARSE, message: "not a JSON-RPC request" },
    });
  }
  const isNotification = request.id === undefined || request.id === null;
  if (isNotification) {
    return Promise.resolve(null);
  }

  return Promise.resolve()
    .then(() => dispatch(request, handler, serverInfo))
    .then((result) => ({ jsonrpc: "2.0" as const, id: request.id!, result }))
    .catch((err: unknown) => {
      if (err instanceof RpcError) {
        return {
          jsonrpc: "2.0" as const,
          id: request.id!,
          error: { code: err.code, message: err.message },
        };
      }
      return {
        jsonrpc: "2.0" as const,
        id: request.id!,
        error: { code: -32603, message: `internal error: ${String(err)}` },
      };
    });
}

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function dispatch(request: RpcRequest, handler: RpcHandler, serverInfo: ServerInfo): Promise<unknown> {
  switch (request.method) {
    case "initialize": {
      const params = (request.params ?? {}) as { protocolVersion?: unknown };
      const version =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return handler("tools/list", request.params ?? {});
    case "tools/call":
      return handler("tools/call", request.params ?? {});
    default:
      throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${request.method}`);
  }
}

export function invalidParams(message: string): RpcError {
  return new RpcError(ERR_INVALID_PARAMS, message);
}

// Reads newline-delimited requests from `input` and writes responses to
// `output`. Resolves when the input ends.
export async function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  handler: RpcHandler,
  serverInfo: ServerInfo,
): Promise<void> {
  let buffer = "";
  const pending: Promise<void>[] = [];
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const write = handleRpcMessage(line, handler, serverInfo).then((response) => {
          if (response) {
            output.write(JSON.stringify(response) + "\n");
          }
        });
        pending.push(write);
      }
      newline = buffer.indexOf("\n");
    }
  }
  await Promise.all(pending);
}
