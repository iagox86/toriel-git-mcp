import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleRpcMessage, type RpcHandler } from "../src/protocol.ts";
import { createHandler, expandRepoPath } from "../src/server.ts";

const SERVER_INFO = { name: "toriel-git-mcp-test", version: "0.0.0" };

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function call(raw: string) {
  return handleRpcMessage(raw, () => ({}), SERVER_INFO);
}

test("initialize echoes the client protocol version", async () => {
  const response = await call(rpc(1, "initialize", { protocolVersion: "2099-01-01" }));
  assert.equal(response?.result.protocolVersion, "2099-01-01");
  assert.deepEqual(response?.result.serverInfo, SERVER_INFO);
});

test("initialize falls back when no version is given", async () => {
  const response = await call(rpc(1, "initialize", {}));
  assert.equal(typeof response?.result.protocolVersion, "string");
});

test("notifications produce no response", async () => {
  const response = await call(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(response, null);
});

test("unknown methods return method-not-found", async () => {
  const response = await call(rpc(2, "resources/list"));
  assert.equal(response?.error?.code, -32601);
});

test("malformed json returns a parse error with null id", async () => {
  const response = await call("{not json");
  assert.equal(response?.error?.code, -32768);
  assert.equal(response?.id, null);
});

const fakeHandler: RpcHandler = createHandler("/tmp");
const unpinHandler: RpcHandler = createHandler();

test("tools/list exposes exactly the three scoped tools with annotations", async () => {
  const response = await handleRpcMessage(rpc(3, "tools/list"), fakeHandler, SERVER_INFO);
  const tools = response?.result.tools as Array<{ name: string; annotations: Record<string, unknown> }>;
  assert.deepEqual(tools.map((t) => t.name), ["git_read", "git_write", "git_net"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.destructiveHint, true);
  assert.equal(tools[2].annotations.destructiveHint, true);
});

async function callTool(id: number, name: string, args: unknown) {
  const response = await handleRpcMessage(
    rpc(id, "tools/call", { name, arguments: args }),
    fakeHandler,
    SERVER_INFO,
  );
  return response?.result as { content: Array<{ text: string }>; isError: boolean };
}

async function callRaw(id: number, name: string, args: unknown) {
  return handleRpcMessage(rpc(id, "tools/call", { name, arguments: args }), fakeHandler, SERVER_INFO);
}

test("tools/call rejects unknown tools", async () => {
  const result = await callTool(4, "git_shell", { args: ["status"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown tool/);
});

test("tools/call returns invalid-params for a malformed args shape", async () => {
  for (const args of [[], "status", undefined]) {
    const response = await callRaw(5, "git_read", { args });
    assert.equal(response?.error?.code, -32602);
    assert.match(String(response?.error?.message), /non-empty array/);
  }
  const missing = await callRaw(6, "git_read", undefined);
  assert.equal(missing?.error?.code, -32602);
});

test("read tool refuses write commands and points at the right tool", async () => {
  const result = await callTool(8, "git_read", { args: ["add", "."] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /git_write/);
});

test("write tool refuses read commands", async () => {
  const result = await callTool(9, "git_write", { args: ["status"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /git_read/);
});

test("any tool refuses net commands except git_net", async () => {
  const read = await callTool(10, "git_read", { args: ["push"] });
  assert.match(read.content[0].text, /git_net/);
  const write = await callTool(11, "git_write", { args: ["fetch"] });
  assert.match(write.content[0].text, /git_net/);
});

test("floor violations are refused before running git", async () => {
  const result = await callTool(12, "git_write", { args: ["status", "-C", "/etc"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rejected/);
});

test("options-before-subcommand is refused", async () => {
  const result = await callTool(13, "git_read", { args: ["--no-pager", "status"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /subcommand/);
});

async function callUnpinned(id: number, args: unknown) {
  const response = await handleRpcMessage(
    rpc(id, "tools/call", { name: "git_read", arguments: args }),
    unpinHandler,
    SERVER_INFO,
  );
  return response?.result as { content: Array<{ text: string }>; isError: boolean };
}

test("unpinned handler demands a repo path", async () => {
  const result = await callUnpinned(14, { args: ["status"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /repo is required/);
});

test("expandRepoPath handles ~ and relative paths", () => {
  assert.equal(expandRepoPath("~"), os.homedir());
  assert.equal(expandRepoPath("~/x/y"), path.join(os.homedir(), "x/y"));
  assert.equal(expandRepoPath("/abs"), "/abs");
  assert.match(expandRepoPath("rel"), /^\//);
});
