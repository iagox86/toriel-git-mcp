// Hardening tests: a fixture repository whose .git/config points
// diff.external, a diff.<driver>.textconv, and gpg.program at a script that
// creates a marker file. The core assertion is that the marker is NEVER
// created when these commands run through the read-class execution path
// (runGit with gitClass "read" - the same path server.ts uses). The same
// fixture proves the holes are real: plain git (no flags) creates the marker.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildGitEnv, runGit } from "../src/git.ts";

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

let dir: string;
let repo: string;
let clean: string;
let marker: string;

function expectMarkerAbsent(): void {
  assert.equal(fs.existsSync(marker), false, "marker file was created - a helper ran");
}

function clearMarker(): void {
  fs.rmSync(marker, { force: true });
}

function readExec(args: string[]) {
  return runGit(repo, args, { gitClass: "read" });
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-git-mcp-hardening-"));
  repo = path.join(dir, "repo");
  clean = path.join(dir, "clean");
  marker = path.join(dir, "marker");
  fs.mkdirSync(repo);
  fs.mkdirSync(clean);

  // The hostile helper: any invocation leaves the marker behind.
  const evil = path.join(dir, "evil.sh");
  fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(evil, 0o755);

  for (const target of [repo, clean]) {
    git(target, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(target, "f.txt"), "one\n");
    git(target, ["add", "f.txt"]);
    git(target, ["commit", "-qm", "one"]);
    fs.writeFileSync(path.join(target, "f.txt"), "two\n");
    git(target, ["add", "f.txt"]);
    git(target, ["commit", "-qm", "two"]);
    fs.writeFileSync(path.join(target, "g.txt"), "g\n");
    git(target, ["add", "g.txt"]);
    git(target, ["commit", "-qm", "three"]);
  }

  // Fake-signed commit: a gpgsig header makes git actually attempt signature
  // verification, which is what runs gpg.program.
  const tree = execFileSync("git", ["-C", repo, "write-tree"], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
  const parent = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
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
  const signed = execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], {
    env: GIT_ENV,
    encoding: "utf8",
    input: object,
  }).trim();
  git(repo, ["update-ref", "refs/heads/main", signed]);

  // Hostile repo-local config: diff.external, a textconv driver wired to
  // f.txt through .gitattributes, gpg.program, and an ext:: transport.
  git(repo, ["config", "diff.external", evil]);
  git(repo, ["config", "diff.evil.textconv", evil]);
  git(repo, ["config", "gpg.program", evil]);
  git(repo, ["config", "core.fsmonitor", evil]);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "f.txt diff=evil\n");
  git(repo, ["add", ".gitattributes"]);
  git(repo, ["commit", "-qm", "attr"]);
  git(repo, ["remote", "add", "origin", `ext::sh -c touch ${marker}`]);

  // Legit regression repo: plain fixture, nothing hostile.
  git(clean, ["config", "user.name", "t"]);
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("precondition: plain git status fires the core.fsmonitor hook from fixture config", async () => {
  // Sanity: with plain git (no server -c injection) the fsmonitor hook runs
  // from a plain read command, which is why runGit pins core.fsmonitor=false
  // for the read class.
  clearMarker();
  const plain = spawnSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
  });
  assert.equal(plain.status, 0, `plain status exited ${plain.status}: ${plain.stderr}`);
  assert.equal(fs.existsSync(marker), true, "fixture core.fsmonitor never fired - the precondition is broken");
});

test("read class pins core.fsmonitor=false: status and diff never run the hook", async () => {
  clearMarker();
  const status = await readExec(["status", "--porcelain"]);
  assert.equal(status.error, undefined, `status spawn error`);
  assert.equal(status.code, 0, `status exited ${status.code}: ${status.stderr}`);
  expectMarkerAbsent();

  clearMarker();
  const diff = await readExec(["diff", "HEAD~1"]);
  assert.equal(diff.code, 0, `diff exited ${diff.code}: ${diff.stderr}`);
  expectMarkerAbsent();

  clearMarker();
  const log = await readExec(["log", "--oneline", "-3"]);
  assert.equal(log.code, 0, `log exited ${log.code}: ${log.stderr}`);
  expectMarkerAbsent();
});

test("precondition: plain git fires diff.external and textconv from the fixture config", async () => {
  clearMarker();
  execFileSync("git", ["-C", repo, "diff", "HEAD~1"], { env: GIT_ENV, stdio: "ignore" });
  assert.equal(fs.existsSync(marker), true, "fixture must be able to fire the external diff");
  // blame does not use diff.external, so a marker here proves the
  // .gitattributes diff=evil textconv driver fires on its own.
  clearMarker();
  execFileSync("git", ["-C", repo, "blame", "f.txt"], { env: GIT_ENV, stdio: "ignore" });
  assert.equal(fs.existsSync(marker), true, "fixture must be able to fire the textconv driver");
  clearMarker();
  execFileSync("git", ["-C", repo, "log", "--show-signature", "-3"], {
    env: GIT_ENV,
    stdio: "ignore",
  });
  assert.equal(fs.existsSync(marker), true, "fixture must be able to run gpg.program");
  clearMarker();
});

test("diff family read commands never run the configured helpers", async () => {
  // The fixture history (oldest first) is: one, two, three, signed (fake
  // gpgsig), attr (.gitattributes). HEAD~1 is the fake-signed commit.
  const calls: Array<[string, string[], (result: { code: number | null; stdout: string; error?: string }) => void]> = [
    ["diff", ["HEAD~1"], (r) => assert.match(r.stdout, /\.gitattributes/)],
    // `--` in the caller's args: the hardening flags go BEFORE it, so they
    // are still parsed as flags rather than swallowed as pathspecs. (f.txt
    // is clean at this fixture state, so empty output is the sane result;
    // the loop's exit-0 and marker-absent assertions carry the check.)
    ["diff", ["--", "f.txt"], (r) => assert.equal(typeof r.stdout, "string", "diff ran")],
    ["log", ["-p", "--oneline", "-5"], (r) => assert.match(r.stdout, /two/)],
    ["show", ["HEAD~1"], (r) => assert.match(r.stdout, /signed/)],
    ["blame", ["f.txt"], (r) => assert.match(r.stdout, /two/)],
    ["diff-tree", ["HEAD~1", "HEAD"], (r) => assert.match(r.stdout, /gitattributes/i)],
    ["merge-base", ["HEAD~1", "HEAD"], (r) => assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/)],
  ];
  for (const [cmd, args, check] of calls) {
    clearMarker();
    const result = await readExec([cmd, ...args]);
    assert.equal(result.error, undefined, `${cmd}: spawn error`);
    assert.equal(result.code, 0, `${cmd} exited ${result.code}: ${result.stdout} ${result.stderr}`);
    check(result);
    expectMarkerAbsent();
  }
});

test("caller re-enable flags are refused by classify, not by flag order", () => {
  // runGit is policy-agnostic: with the hardening flags injected FIRST, a
  // caller-supplied --show-signature would be the last (winning) flag at
  // this layer. The gate is classify() refusing these flags on read screens
  // (policy.test.ts) and the server passing that class through - proven
  // end-to-end below, where the real server refuses the call.
});

test("ext:: transport from a read-class run fails without executing", async () => {
  clearMarker();
  const result = await readExec(["remote", "show", "origin"]);
  // GIT_ALLOW_PROTOCOL=file makes the ext:: transport refuse to start,
  // instead of running sh; the marker must not exist either way.
  assert.notEqual(result.code, 0, "ext:: transport unexpectedly succeeded");
  expectMarkerAbsent();
});

test("legit fixture repo still works for every read command", async () => {
  const calls: Array<[string, string[], RegExp]> = [
    ["status", ["--porcelain"], /^$/],
    ["log", ["--oneline"], /one/],
    ["log", ["-p", "--oneline"], /one/],
    ["diff", ["HEAD~1"], /g\.txt/],
    ["show", ["HEAD~1"], /two/],
    ["blame", ["f.txt"], /two/],
    ["shortlog", ["--stat", "HEAD"], /three/],
    ["config", ["--get", "user.name"], /t/],
    ["remote", ["-v"], /^$/],
  ];
  for (const [cmd, args, pattern] of calls) {
    const result = await runGit(clean, [cmd, ...args], { gitClass: "read" });
    assert.equal(result.code, 0, `${cmd} ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, pattern, `${cmd} ${args.join(" ")} output: ${result.stdout}`);
  }
});

test("the real MCP server hardens read calls against the hostile repo", async () => {
  // End-to-end: proves the server handler actually passes the class through
  // to runGit (the unit tests above would not catch server.ts forgetting to).
  const child = spawn(process.execPath, [SERVER_SCRIPT, "--repository", repo], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const byId = new Map<number, string>();
  const responseFor = (id: number) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const line = byId.get(id);
        if (line !== undefined) {
          clearInterval(timer);
          resolve(line);
        }
      };
      const timer = setInterval(check, 25);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`timed out waiting for response ${id}`));
      }, 10_000).unref();
      check();
    });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line) {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") {
          byId.set(message.id, line);
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await responseFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  clearMarker();
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "git_read", arguments: { args: ["log", "-p", "--show-signature", "-5"] } },
  });
  const refusal = JSON.parse(await responseFor(2)) as {
    result?: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(refusal.result?.isError, true, "--show-signature must be refused on reads");
  expectMarkerAbsent();

  clearMarker();
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "git_read", arguments: { args: ["log", "-p", "--oneline", "-5"] } },
  });
  const message = JSON.parse(await responseFor(3)) as {
    result?: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(message.result?.isError, false, message.result?.content[0]?.text);
  assert.match(message.result!.content[0].text, /two/);
  expectMarkerAbsent();
  child.kill();
  child.stdin.end();
});

test("read-class environment pins GIT_ALLOW_PROTOCOL=file", () => {
  const base = { ...process.env, GIT_ALLOW_PROTOCOL: "ext::evil" } as NodeJS.ProcessEnv;
  const read = buildGitEnv("read", base);
  assert.equal(read.GIT_ALLOW_PROTOCOL, "file");
  assert.equal(read.GIT_TERMINAL_PROMPT, "0");
});

test("write, net, and unclassified environments keep the sanitized defaults", () => {
  for (const gitClass of ["write", "net", undefined] as const) {
    const env = buildGitEnv(gitClass);
    assert.equal(env.GIT_ALLOW_PROTOCOL, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  }
});
