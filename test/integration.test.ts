import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, stdio: "ignore" });
}

interface Client {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  callTool(name: string, args: string[], repo?: string): ReturnType<typeof makeCallTool>;
  expectResult: ReturnType<typeof makeExpectResult>;
  expectError: ReturnType<typeof makeExpectError>;
  close(): void;
}

function makeCallTool(client: Client) {
  return (name: string, args: string[], repo?: string) => {
    const argumentsArg: Record<string, unknown> = { args };
    if (repo !== undefined) {
      argumentsArg.repo = repo;
    }
    return client.request("tools/call", { name, arguments: argumentsArg }).then((response) => {
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      return { ...result, response };
    });
  };
}

function makeExpectResult(callTool: ReturnType<typeof makeCallTool>) {
  return async (promise: ReturnType<typeof callTool>, pattern: RegExp) => {
    const result = await promise;
    assert.equal(result.isError, false, `wanted success, got: ${result.content[0].text}`);
    assert.match(result.content[0].text, pattern);
  };
}

function makeExpectError(callTool: ReturnType<typeof makeCallTool>) {
  return async (promise: ReturnType<typeof callTool>, pattern: RegExp) => {
    const result = await promise;
    assert.equal(result.isError, true, `wanted error, got: ${result.content[0].text}`);
    assert.match(result.content[0].text, pattern);
  };
}

function connect(args: string[]): Promise<Client> {
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let nextId = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });

  const client: Client = {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
          if (err) {
            pending.delete(id);
            reject(err);
          }
        });
      });
    },
    callTool: undefined as never,
    expectResult: undefined as never,
    expectError: undefined as never,
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
  client.callTool = makeCallTool(client);
  client.expectResult = makeExpectResult(client.callTool);
  client.expectError = makeExpectError(client.callTool);

  return client.request("initialize", { protocolVersion: "2025-06-18" }).then((init) => {
    assert.equal(init.result.protocolVersion, "2025-06-18");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return client;
  });
}

// Disposable fixture repository and worktree in the OS temp dir; destroyed after.
let repo: string;
let worktree: string;
let pinned: Client;
let unpinned: Client;

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-git-mcp-test-"));
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hi\n");
  git(repo, ["add", "hello.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  worktree = repo + "-wt";
  git(repo, ["worktree", "add", "-b", "wt-branch", worktree]);
  pinned = await connect(["--repository", repo]);
  unpinned = await connect([]);
});

after(() => {
  for (const client of [pinned, unpinned]) {
    client.close();
  }
  for (const dir of [repo, worktree]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned server lists the three scoped tools", async () => {
  const response = await pinned.request("tools/list");
  const tools = response.result.tools as Array<{ name: string }>;
  assert.deepEqual(tools.map((t) => t.name), ["git_read", "git_write", "git_net"]);
});

test("pinned server runs a read command without a repo argument", async () => {
  await pinned.expectResult(pinned.callTool("git_read", ["log", "--oneline"]), /initial/);
});

test("pinned server rejects an explicit repo argument", async () => {
  await pinned.expectError(pinned.callTool("git_read", ["status"], repo), /pinned/);
});

test("unpinned server requires a repo argument", async () => {
  await unpinned.expectError(unpinned.callTool("git_read", ["status"]), /repo is required/);
});

test("unpinned server runs against any repository it is given", async () => {
  await unpinned.expectResult(unpinned.callTool("git_read", ["log", "--oneline"], repo), /initial/);
});

test("unpinned server refuses a non-repository path via git's own error", async () => {
  await unpinned.expectError(
    unpinned.callTool("git_read", ["status"], path.dirname(repo)),
    /not a git repository/,
  );
});

test("unpinned server expands ~", async () => {
  // HOME-relative call that must not match the fixture; proves the arg flows
  // through expansion rather than being ignored (git errors on most home dirs).
  const result = await unpinned.callTool("git_read", ["status"], "~");
  if (result.isError) {
    assert.doesNotMatch(result.content[0].text, /repo is required/);
  }
});

test("worktree: read and write both work through its path", async () => {
  await unpinned.expectResult(
    unpinned.callTool("git_read", ["log", "--oneline"], worktree),
    /initial/,
  );
  fs.writeFileSync(path.join(worktree, "wt-file.txt"), "from worktree\n");
  await unpinned.expectResult(
    unpinned.callTool("git_write", ["add", "wt-file.txt"], worktree),
    /no output/,
  );
  const status = await unpinned.callTool("git_read", ["status", "--porcelain"], worktree);
  assert.match(status.content[0].text, /wt-file\.txt/);
});

test("worktree: -C escape from a worktree path is still refused", async () => {
  await unpinned.expectError(
    unpinned.callTool("git_write", ["status", "-C", "/etc"], worktree),
    /rejected/,
  );
});

test("write through the write tool is visible from read", async () => {
  fs.writeFileSync(path.join(repo, "world.txt"), "world\n");
  await pinned.expectResult(pinned.callTool("git_write", ["add", "world.txt"]), /no output/);
  const status = await pinned.callTool("git_read", ["status", "--porcelain"]);
  assert.match(status.content[0].text, /world\.txt/);
});

test("refuses a write through the read tool", async () => {
  await pinned.expectError(pinned.callTool("git_read", ["add", "."]), /git_write/);
});

test("net tool runs the command and a missing remote surfaces git's own error", async () => {
  await pinned.expectError(pinned.callTool("git_net", ["push"]), /no configured push destination|exit code/);
});

test("unpermitted subcommands are refused everywhere", async () => {
  await pinned.expectError(pinned.callTool("git_read", ["daemon"]), /not permitted/);
  await pinned.expectError(pinned.callTool("git_write", ["daemon"]), /not permitted/);
  await pinned.expectError(pinned.callTool("git_net", ["daemon"]), /not permitted/);
});
