import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  callVerb(name: string, params: Record<string, unknown>): ReturnType<typeof makeCallVerb>;
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

function makeCallVerb(client: Client) {
  return (name: string, params: Record<string, unknown>) => {
    return client.request("tools/call", { name, arguments: params }).then((response) => {
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
  client.callVerb = makeCallVerb(client);
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
let hostile: string;
let hostileDir: string;
let marker: string;
let pinned: Client;
let unpinned: Client;
let hostileClient: Client;

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-git-mcp-test-"));
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hi\n");
  git(repo, ["add", "hello.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  worktree = repo + "-wt";
  git(repo, ["worktree", "add", "-b", "wt-branch", worktree]);

  // Hostile fixture (mirrors test/git.test.ts): a repository whose local
  // config points diff.external, a textconv driver, gpg.program, and
  // core.fsmonitor at a script that creates a marker file, plus a
  // fake-signed commit and an ext:: remote. Every verb call through the real
  // server path must exit 0 and NEVER create the marker.
  hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-git-mcp-verbs-hostile-"));
  hostile = path.join(hostileDir, "repo");
  marker = path.join(hostileDir, "marker");
  fs.mkdirSync(hostile);
  git(hostile, ["init", "-q", "-b", "main"]);
  const evil = path.join(hostileDir, "evil.sh");
  fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(evil, 0o755);
  fs.writeFileSync(path.join(hostile, "f.txt"), "one\n");
  git(hostile, ["add", "f.txt"]);
  git(hostile, ["commit", "-qm", "one"]);
  fs.writeFileSync(path.join(hostile, "f.txt"), "two\n");
  git(hostile, ["add", "f.txt"]);
  git(hostile, ["commit", "-qm", "two"]);
  fs.writeFileSync(path.join(hostile, "g.txt"), "g\n");
  git(hostile, ["add", "g.txt"]);
  git(hostile, ["commit", "-qm", "three"]);
  // Fake-signed commit: a gpgsig header makes git attempt signature
  // verification, which is what runs gpg.program.
  const tree = execFileSync("git", ["-C", hostile, "write-tree"], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
  const parent = execFileSync("git", ["-C", hostile, "rev-parse", "HEAD"], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author t <t@t> 1 +0000",
    "committer t <t@t> 1 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    "  test",
    " -----END PGP SIGNATURE-----",
    "",
    "signed",
    "",
  ].join("\n");
  const signed = execFileSync("git", [
    "-C",
    hostile,
    "hash-object",
    "-t",
    "commit",
    "-w",
    "--stdin",
  ], {
    env: GIT_ENV,
    encoding: "utf8",
    input: object,
  }).trim();
  git(hostile, ["update-ref", "refs/heads/main", signed]);
  git(hostile, ["config", "diff.external", evil]);
  git(hostile, ["config", "diff.evil.textconv", evil]);
  git(hostile, ["config", "gpg.program", evil]);
  git(hostile, ["config", "core.fsmonitor", evil]);
  fs.writeFileSync(path.join(hostile, ".gitattributes"), "f.txt diff=evil\n");
  git(hostile, ["add", ".gitattributes"]);
  git(hostile, ["commit", "-qm", "attr"]);
  git(hostile, ["remote", "add", "origin", `ext::sh -c touch ${marker}`]);

  pinned = await connect(["--repository", repo]);
  unpinned = await connect([]);
  hostileClient = await connect(["--repository", hostile]);
});

after(() => {
  for (const client of [pinned, unpinned, hostileClient]) {
    client.close();
  }
  for (const dir of [repo, worktree, hostileDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned server lists the three facades plus the six structured verbs", async () => {
  const response = await pinned.request("tools/list");
  const tools = response.result.tools as Array<{ name: string }>;
  assert.deepEqual(tools.map((t) => t.name), [
    "git_read",
    "git_write",
    "git_net",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_blame",
    "git_grep",
  ]);
});

test("each tool lists its own input schema", async () => {
  const response = await pinned.request("tools/list");
  const tools = response.result.tools as Array<{
    name: string;
    inputSchema: { type: string; properties: Record<string, unknown>; additionalProperties?: unknown };
  }>;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // the facades keep the shared args schema
  assert.deepEqual(Object.keys(byName.get("git_read")!.inputSchema.properties).sort(), [
    "args",
    "repo",
  ]);
  // the verbs carry their own typed schemas
  assert.deepEqual(Object.keys(byName.get("git_status")!.inputSchema.properties).sort(), [
    "paths",
    "repo",
  ]);
  assert.deepEqual(Object.keys(byName.get("git_diff")!.inputSchema.properties).sort(), [
    "from",
    "paths",
    "repo",
    "to",
  ]);
  assert.deepEqual(Object.keys(byName.get("git_grep")!.inputSchema.properties).sort(), [
    "fixedStrings",
    "ignoreCase",
    "paths",
    "pattern",
    "repo",
  ]);
  for (const verb of ["git_status", "git_diff", "git_log", "git_show", "git_blame", "git_grep"]) {
    assert.equal(byName.get(verb)!.inputSchema.additionalProperties, false, verb);
  }
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

function expectMarkerAbsent(): void {
  assert.equal(fs.existsSync(marker), false, "marker file was created - a helper ran");
}

function clearMarker(): void {
  fs.rmSync(marker, { force: true });
}

// Runs after the world.txt staging above, so the clean fixture's status
// shows the staged file.
test("every verb runs exit-0 with sane output on the clean fixture", async () => {
  await pinned.expectResult(pinned.callVerb("git_status", {}), /world\.txt/);
  await pinned.expectResult(pinned.callVerb("git_diff", { from: "HEAD", to: "HEAD" }), /no output/);
  await pinned.expectResult(pinned.callVerb("git_log", {}), /initial/);
  await pinned.expectResult(pinned.callVerb("git_log", { rev: "HEAD", maxCount: 5 }), /initial/);
  await pinned.expectResult(pinned.callVerb("git_show", { rev: "HEAD" }), /initial/);
  await pinned.expectResult(pinned.callVerb("git_blame", { path: "hello.txt" }), /hi/);
  await pinned.expectResult(pinned.callVerb("git_blame", { path: "hello.txt", rev: "HEAD" }), /hi/);
  await pinned.expectResult(pinned.callVerb("git_grep", { pattern: "hi" }), /hello\.txt:1:hi/);
  await pinned.expectResult(
    pinned.callVerb("git_grep", { pattern: "HI", ignoreCase: true }),
    /hello\.txt:1:hi/,
  );
  await pinned.expectResult(
    pinned.callVerb("git_grep", { pattern: "hi", fixedStrings: true, paths: ["hello.txt"] }),
    /hello\.txt:1:hi/,
  );
});

test("verbs honor the repo pin and expansion like the facades", async () => {
  await unpinned.expectError(unpinned.callVerb("git_status", {}), /repo is required/);
  await unpinned.expectResult(unpinned.callVerb("git_status", { repo }), /world\.txt/);
  await unpinned.expectResult(unpinned.callVerb("git_log", { repo: worktree }), /initial/);
  await pinned.expectError(pinned.callVerb("git_status", { repo }), /pinned/);
  await pinned.expectError(pinned.callVerb("git_status", []), /parameters must be an object/);
  await pinned.expectError(pinned.callVerb("git_show", { rev: "HEAD", args: ["status"] }), /unknown parameter: args/);
});

test("a malicious rev is refused by the validator, never reaching classify", async () => {
  const result = await pinned.callVerb("git_show", { rev: "-cfoo=bar" });
  assert.equal(result.isError, true, `wanted refusal, got: ${result.content[0].text}`);
  // The validator's own message proves the call was stopped before
  // classify/floor ran (those would say "not permitted"/"rejected").
  assert.match(result.content[0].text, /rev must not start with/);
  clearMarker();
  const logResult = await hostileClient.callVerb("git_log", { rev: "-c foo=bar" });
  assert.equal(logResult.isError, true, `wanted refusal, got: ${logResult.content[0].text}`);
  assert.match(logResult.content[0].text, /rev must not start with/);
  expectMarkerAbsent();
});

test("every verb on the hostile repo exits 0 without running any configured helper", async () => {
  clearMarker();
  await hostileClient.expectResult(hostileClient.callVerb("git_status", {}), /no output/);
  expectMarkerAbsent();

  clearMarker();
  await hostileClient.expectResult(
    hostileClient.callVerb("git_diff", { from: "HEAD~1", to: "HEAD" }),
    /gitattributes/,
  );
  expectMarkerAbsent();

  clearMarker();
  await hostileClient.expectResult(hostileClient.callVerb("git_log", { rev: "HEAD", maxCount: 5 }), /three/);
  expectMarkerAbsent();

  clearMarker();
  await hostileClient.expectResult(hostileClient.callVerb("git_show", { rev: "HEAD~1" }), /signed/);
  expectMarkerAbsent();

  clearMarker();
  await hostileClient.expectResult(hostileClient.callVerb("git_blame", { path: "f.txt" }), /two/);
  expectMarkerAbsent();

  clearMarker();
  await hostileClient.expectResult(
    hostileClient.callVerb("git_grep", { pattern: "two", paths: ["f.txt"] }),
    /f\.txt:1:two/,
  );
  expectMarkerAbsent();
});

test("git_diff with two outside paths cannot read host files (implicit --no-index)", async () => {
  // Found by review: with exactly two positional args and no trailing --,
  // git falls into implicit --no-index mode and PRINTS the files' contents.
  // The verb's argv always ends with -- so the outside paths become bad
  // revisions; the facade additionally screens path-shaped positionals.
  const outside1 = path.join(hostileDir, "secret1.txt");
  const outside2 = path.join(hostileDir, "secret2.txt");
  fs.writeFileSync(outside1, "SECRET-ONE");
  fs.writeFileSync(outside2, "SECRET-TWO");
  clearMarker();
  const verb = await hostileClient.callVerb("git_diff", { from: outside1, to: outside2 });
  assert.equal(verb.isError, true, `wanted failure, got: ${verb.content[0].text}`);
  assert.doesNotMatch(verb.content[0].text, /SECRET/);
  expectMarkerAbsent();

  const facade = await hostileClient.callTool("git_read", ["diff", outside1, outside2]);
  assert.equal(facade.isError, true, "the facade path-shaped screen must refuse it too");
  assert.doesNotMatch(facade.content[0].text, /SECRET/);
  expectMarkerAbsent();
});

test("verbs accept omitted arguments (every git_status/git_log param is optional)", async () => {
  const response = await pinned.request("tools/call", { name: "git_status" });
  const result = response.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, false, `omitted arguments failed: ${result.content[0].text}`);
  assert.match(result.content[0].text, /hello\.txt|world\.txt|\.git/);
});

test("git_blame is pinned to HEAD so clean filters cannot run (status residual documented)", async () => {
  // Separate fixture: repo-local clean filter wired through .gitattributes.
  // Preconditions prove the two plain-git firing conditions: rev-less blame
  // on a content-dirty file, and status on a STAT-dirty file (unchanged
  // content, new mtime - git runs the filter to confirm no change). The
  // verb's HEAD pin is what keeps git_blame out of both.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-git-mcp-filter-"));
  try {
    const repo = path.join(dir, "repo");
    const marker = path.join(dir, "marker");
    fs.mkdirSync(repo);
    const evil = path.join(dir, "evil.sh");
    fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\ncat\n`);
    fs.chmodSync(evil, 0o755);
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-qm", "one"]);
    git(repo, ["config", "filter.evil.clean", evil]);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
    git(repo, ["add", ".gitattributes"]);
    git(repo, ["commit", "-qm", "attr"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "dirty\n");

    fs.rmSync(marker, { force: true });
    const plainBlame = spawnSync("git", ["-C", repo, "blame", "f.txt"], { encoding: "utf8" });
    assert.equal(plainBlame.status, 0, `plain blame exited ${plainBlame.status}`);
    assert.equal(
      fs.existsSync(marker),
      true,
      "precondition broken: rev-less blame did not run the clean filter",
    );

    // Clear THIS fixture's marker: the module-level clearMarker/expectMarker
    // helpers target the hostile fixture's marker and would leak the
    // precondition's marker into the assertion below.
    fs.rmSync(marker, { force: true });
    const result = await unpinned.callVerb("git_blame", { path: "f.txt", repo });
    assert.equal(result.isError, false, `blame failed: ${result.content[0].text}`);
    assert.match(result.content[0].text, /one/);
    assert.equal(fs.existsSync(marker), false, "HEAD-pinned blame ran the clean filter");

    // Status residual: restore the committed content so the file is
    // STAT-dirty only, then assert plain status runs the filter (git runs
    // clean to confirm no change; there is no disable flag).
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
    fs.rmSync(marker, { force: true });
    const status = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.equal(
      fs.existsSync(marker),
      true,
      "status clean-filter residual no longer fires - update the README claim",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
