import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, floorViolation } from "../src/policy.ts";

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
