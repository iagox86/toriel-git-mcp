import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, floorViolation, hardenReadArgs } from "../src/policy.ts";

test("pure read commands classify as read", () => {
  for (const cmd of ["status", "log", "diff", "show", "blame", "rev-parse", "grep"]) {
    assert.equal(classify(cmd, []), "read", cmd);
  }
});

test("write commands classify as write", () => {
  for (const cmd of ["add", "commit", "reset", "rebase", "checkout", "restore"]) {
    assert.equal(classify(cmd, []), "write", cmd);
  }
});

test("network commands classify as net", () => {
  for (const cmd of ["push", "pull", "fetch", "clone", "ls-remote", "submodule"]) {
    assert.equal(classify(cmd, []), "net", cmd);
  }
});

test("unknown subcommands are rejected", () => {
  assert.equal(classify("daemon", []), null);
  assert.equal(classify("upload-archive", []), null);
});

test("version and help are read", () => {
  for (const cmd of ["version", "--version", "help", "-h", "--help"]) {
    assert.equal(classify(cmd, []), "read", cmd);
  }
});

test("branch mutation flags move the call to write", () => {
  assert.equal(classify("branch", []), "read");
  assert.equal(classify("branch", ["-a"]), "read");
  assert.equal(classify("branch", ["--show-current"]), "read");
  assert.equal(classify("branch", ["-D", "main"]), "write");
  assert.equal(classify("branch", ["--delete", "main"]), "write");
  assert.equal(classify("branch", ["-m", "a", "b"]), "write");
  assert.equal(classify("branch", ["-f", "main"]), "write");
  assert.equal(classify("branch", ["--edit-description"]), "write");
});

test("tag only reads in list forms", () => {
  assert.equal(classify("tag", []), "read");
  assert.equal(classify("tag", ["-l", "v*"]), "read");
  assert.equal(classify("tag", ["--list"]), "read");
  assert.equal(classify("tag", ["-n", "5"]), "read");
  assert.equal(classify("tag", ["v1.0"]), "write");
  assert.equal(classify("tag", ["-d", "v1.0"]), "write");
  assert.equal(classify("tag", ["-a", "v1.0", "-m", "x"]), "write");
});

test("stash reads only list and show", () => {
  assert.equal(classify("stash", ["list"]), "read");
  assert.equal(classify("stash", ["show"]), "read");
  assert.equal(classify("stash", []), "write");
  assert.equal(classify("stash", ["push"]), "write");
  assert.equal(classify("stash", ["pop"]), "write");
  assert.equal(classify("stash", ["drop"]), "write");
});

test("worktree reads only list", () => {
  assert.equal(classify("worktree", ["list"]), "read");
  assert.equal(classify("worktree", ["add", "../x"]), "write");
  assert.equal(classify("worktree", ["remove", "x"]), "write");
});

test("config reads only getters", () => {
  assert.equal(classify("config", ["--list"]), "read");
  assert.equal(classify("config", ["--get", "user.name"]), "read");
  assert.equal(classify("config", ["--get-all", "user.name"]), "read");
  assert.equal(classify("config", ["user.name", "Ron"]), "write");
  assert.equal(classify("config", ["--unset", "user.name"]), "write");
});

test("remote reads only listing forms", () => {
  assert.equal(classify("remote", []), "read");
  assert.equal(classify("remote", ["-v"]), "read");
  assert.equal(classify("remote", ["get-url", "origin"]), "read");
  assert.equal(classify("remote", ["add", "origin", "url"]), "write");
  assert.equal(classify("remote", ["set-url", "origin", "url"]), "write");
  assert.equal(classify("remote", ["prune", "origin"]), "write");
});

test("verify-commit and verify-tag are not permitted at all", () => {
  // They run gpg.program, which repo-local .git/config can point anywhere.
  assert.equal(classify("verify-commit", []), null);
  assert.equal(classify("verify-commit", ["HEAD"]), null);
  assert.equal(classify("verify-tag", []), null);
  assert.equal(classify("verify-tag", ["refs/tags/v1.0"]), null);
});

test("remote show classifies as write", () => {
  // It contacts the remote and honors remote.<name>.url transports (ext::).
  assert.equal(classify("remote", ["show"]), "write");
  assert.equal(classify("remote", ["show", "origin"]), "write");
});

test("hardenReadArgs puts no-helper flags before user args (a trailing `--` must not swallow them)", () => {
  assert.deepEqual(hardenReadArgs("diff", []), ["--no-ext-diff", "--no-textconv"]);
  assert.deepEqual(hardenReadArgs("diff", ["HEAD~1"]), ["--no-ext-diff", "--no-textconv", "HEAD~1"]);
  assert.deepEqual(hardenReadArgs("diff", ["--", "f.txt"]), [
    "--no-ext-diff",
    "--no-textconv",
    "--",
    "f.txt",
  ]);
  assert.deepEqual(hardenReadArgs("diff-tree", ["HEAD~1"]), [
    "--no-ext-diff",
    "--no-textconv",
    "HEAD~1",
  ]);
  assert.deepEqual(hardenReadArgs("log", []), [
    "--no-ext-diff",
    "--no-textconv",
    "--no-show-signature",
  ]);
  assert.deepEqual(hardenReadArgs("log", ["--oneline", "-5"]), [
    "--no-ext-diff",
    "--no-textconv",
    "--no-show-signature",
    "--oneline",
    "-5",
  ]);
  assert.deepEqual(hardenReadArgs("show", ["HEAD~1"]), [
    "--no-ext-diff",
    "--no-textconv",
    "--no-show-signature",
    "HEAD~1",
  ]);
  assert.deepEqual(hardenReadArgs("blame", ["f.txt"]), ["--no-ext-diff", "--no-textconv", "f.txt"]);
});

test("read screens refuse caller re-enable flags (last-flag-wins defeats injected --no-*)", () => {
  assert.equal(classify("log", ["--show-signature"]), "write");
  assert.equal(classify("log", ["-p", "--show-signature"]), "write");
  assert.equal(classify("show", ["--show-signature", "HEAD"]), "write");
  assert.equal(classify("diff", ["--ext-diff"]), "write");
  assert.equal(classify("diff", ["--textconv"]), "write");
  assert.equal(classify("diff-tree", ["--ext-diff", "HEAD~1", "HEAD"]), "write");
  assert.equal(classify("blame", ["--textconv", "f.txt"]), "write");
  assert.equal(classify("log", ["--no-show-signature"]), "read");
});

test("grep cannot open matches in a pager program (-O runs whatever it is given)", () => {
  assert.equal(classify("grep", ["-O/tmp/evil.sh", "pattern"]), "write");
  assert.equal(classify("grep", ["--open-files-in-pager=/tmp/evil.sh", "pattern"]), "write");
  assert.equal(classify("grep", ["--open-files-in-pager"]), "write");
  assert.equal(classify("grep", ["--open"]), "write", "abbreviation of --open-files-in-pager");
  assert.equal(classify("grep", ["-nO/tmp/evil.sh", "pattern"]), "write", "bundled short: -nOcmd");
  assert.equal(classify("grep", ["-inOcmd"]), "write", "bundled short in the middle");
  assert.equal(classify("grep", ["-i", "pattern"]), "read");
  assert.equal(classify("grep", ["-c", "pattern"]), "read");
});

test("tag uses a positive list-mode allowlist (abbreviations defeat denylists)", () => {
  assert.equal(classify("tag", ["-i", "--dele", "v1"]), "write", "--dele abbreviates --delete");
  assert.equal(classify("tag", ["-l", "v1", "-d"]), "write");
  assert.equal(classify("tag", ["--dele", "v1"]), "write");
  assert.equal(classify("tag", ["v1.0"]), "write", "bare tag creates");
  assert.equal(classify("tag", ["-l", "-n5"]), "read");
  assert.equal(classify("tag", ["-n1"]), "read");
  assert.equal(classify("tag", ["--contains", "abc"]), "read");
  assert.equal(classify("tag", []), "read");
});

test("hardenReadArgs leaves every other command unchanged", () => {
  for (const cmd of [
    "status",
    "shortlog",
    "describe",
    "rev-parse",
    "rev-list",
    "ls-files",
    "ls-tree",
    "cat-file",
    "grep",
    "reflog",
    "branch",
    "tag",
    "stash",
    "worktree",
    "config",
    "remote",
    "merge-base",
    "for-each-ref",
    "show-branch",
    "count-objects",
    "version",
  ]) {
    const args = ["--porcelain"];
    assert.deepEqual(hardenReadArgs(cmd, args), args, cmd);
  }
  // merge-base rejects both no-helper flags (verified in test/git.test.ts).
  assert.deepEqual(hardenReadArgs("merge-base", ["HEAD~1", "HEAD"]), ["HEAD~1", "HEAD"]);
  assert.deepEqual(hardenReadArgs("unknown", ["x"]), ["x"]);
});

test("hardenReadArgs never mutates or aliases its input", () => {
  const args = ["HEAD~1"];
  const out = hardenReadArgs("diff", args);
  assert.equal(out.length, 3);
  assert.equal(args.length, 1);
  assert.notEqual(out, args);
  const unchanged = hardenReadArgs("status", args);
  assert.notEqual(unchanged, args);
});

test("reflog expires and deletes are writes", () => {
  assert.equal(classify("reflog", []), "read");
  assert.equal(classify("reflog", ["show"]), "read");
  assert.equal(classify("reflog", ["expire", "--all"]), "write");
  assert.equal(classify("reflog", ["delete", "HEAD@{1}"]), "write");
});

test("read commands cannot write output files", () => {
  assert.equal(classify("diff", ["--output", "/tmp/x"]), "write");
  assert.equal(classify("log", ["--output=/tmp/x"]), "write");
  assert.equal(classify("diff", ["--output-indicator-new=>"]), "read");
});

test("floor rejects repo escape, config injection, and transport helpers", () => {
  assert.equal(floorViolation(["-C", "/etc"]), "-C");
  assert.equal(floorViolation(["-C/etc"]), "-C/etc");
  assert.equal(floorViolation(["--git-dir=/etc"]), "--git-dir=/etc");
  assert.equal(floorViolation(["--git-dir", "/etc"]), "--git-dir");
  assert.equal(floorViolation(["--work-tree", "/tmp"]), "--work-tree");
  // bare "-c" is only config injection in the global position before the
  // subcommand, which the server refuses outright (subcommand must be args[0]);
  // within a subcommand it is the combined-diff flag. The attached form is
  // blocked by the regex below.
  assert.equal(floorViolation(["log", "-c"]), null);
  assert.equal(floorViolation(["-ccore.hooksPath=/evil"]), "-ccore.hooksPath=/evil");
  assert.equal(floorViolation(["--upload-pack", "evil"]), "--upload-pack");
  assert.equal(floorViolation(["--upload-pack=evil"]), "--upload-pack=evil");
  assert.equal(floorViolation(["--exec=evil"]), "--exec=evil");
  assert.equal(floorViolation(["-o", "ServerAliveInterval=1"]), "-o");
  assert.equal(floorViolation(["ext::sh -c evil"]), "ext::sh -c evil");
});

test("floor allows benign args including combined-diff -c", () => {
  assert.equal(floorViolation(["log", "-c", "-p"]), null);
  assert.equal(floorViolation(["status", "--porcelain"]), null);
  assert.equal(floorViolation(["diff", "HEAD~1", "HEAD"]), null);
});
