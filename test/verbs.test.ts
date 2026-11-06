// Pure tests for the structured verb tools: exact argv for every verb and
// validator refusals. The rule for every user string (revs, paths, pattern)
// is non-empty and must not start with "-"; the git grep pattern travels
// after a literal -e so it can never be parsed as an option at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { floorViolation } from "../src/policy.ts";
import { buildVerbArgv, VERB_TOOLS, type VerbName } from "../src/verbs.ts";

type Built = { argv: string[] } | { error: string };

function argv(name: string, params: unknown): string[] {
  const result = buildVerbArgv(name, params);
  if ("error" in result) {
    throw new Error(
      `expected argv for ${name} ${JSON.stringify(params)}, got: ${result.error}`,
    );
  }
  return result.argv;
}

function refused(name: string, params: unknown, pattern: RegExp): string {
  const result = buildVerbArgv(name, params);
  if (!("error" in result)) {
    throw new Error(
      `expected a refusal for ${name} ${JSON.stringify(params)}, got argv ${JSON.stringify(result.argv)}`,
    );
  }
  assert.match(result.error, pattern, `refusal message was: ${result.error}`);
  return result.error;
}

test("VERB_TOOLS describes exactly the six verbs, all readOnly", () => {
  assert.deepEqual(
    VERB_TOOLS.map((t) => t.name),
    ["git_status", "git_diff", "git_log", "git_show", "git_blame", "git_grep"],
  );
  for (const tool of VERB_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} annotations`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema type`);
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} additionalProperties`,
    );
  }
});

test("every verb schema carries the optional repo parameter", () => {
  const expected: Record<VerbName, string[]> = {
    git_status: ["paths", "repo"],
    git_diff: ["from", "paths", "repo", "to"],
    git_log: ["maxCount", "paths", "repo", "rev"],
    git_show: ["repo", "rev"],
    git_blame: ["path", "repo", "rev"],
    git_grep: ["fixedStrings", "ignoreCase", "paths", "pattern", "repo"],
  };
  for (const tool of VERB_TOOLS) {
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(properties).sort(),
      expected[tool.name],
      `${tool.name} schema properties`,
    );
  }
});

test("git_status: exact argv", () => {
  assert.deepEqual(argv("git_status", {}), ["status", "--porcelain"]);
  assert.deepEqual(argv("git_status", { paths: ["src", "test"] }), [
    "status",
    "--porcelain",
    "--",
    "src",
    "test",
  ]);
  // repo is consumed by the server, never an argv input
  assert.deepEqual(argv("git_status", { repo: "/x" }), ["status", "--porcelain"]);
});

test("git_diff: exact argv, rev-to-rev, trailing -- (implicit --no-index defense)", () => {
  assert.deepEqual(argv("git_diff", { from: "HEAD~2", to: "HEAD" }), [
    "diff",
    "HEAD~2",
    "HEAD",
    "--",
  ]);
  assert.deepEqual(argv("git_diff", { from: "a", to: "b", paths: ["f.txt"] }), [
    "diff",
    "a",
    "b",
    "--",
    "f.txt",
  ]);
  refused("git_diff", {}, /from must be a string/);
  refused("git_diff", { from: "a" }, /to must be a string/);
});

test("git_log: exact argv with defaults and clamping", () => {
  assert.deepEqual(argv("git_log", {}), ["log", "--oneline", "-n", "50", "HEAD", "--"]);
  assert.deepEqual(argv("git_log", { rev: "HEAD~1" }), [
    "log",
    "--oneline",
    "-n",
    "50",
    "HEAD~1",
    "--",
  ]);
  assert.deepEqual(argv("git_log", { maxCount: 0 }), ["log", "--oneline", "-n", "1", "HEAD", "--"]);
  assert.deepEqual(argv("git_log", { maxCount: 999 }), [
    "log",
    "--oneline",
    "-n",
    "200",
    "HEAD",
    "--",
  ]);
  assert.deepEqual(argv("git_log", { maxCount: 7, paths: ["src"] }), [
    "log",
    "--oneline",
    "-n",
    "7",
    "HEAD",
    "--",
    "src",
  ]);
  refused("git_log", { maxCount: 5.5 }, /maxCount must be an integer/);
  refused("git_log", { maxCount: "10" }, /maxCount must be an integer/);
  refused("git_log", { rev: "" }, /rev must be a non-empty string/);
  refused("git_log", { rev: "-cfoo=bar" }, /rev must not start with/);
});

test("git_show: exact argv", () => {
  assert.deepEqual(argv("git_show", { rev: "HEAD" }), ["show", "HEAD", "--"]);
  refused("git_show", {}, /rev must be a string/);
  refused("git_show", { rev: "-c foo=bar" }, /rev must not start with/);
});

test("git_blame: exact argv", () => {
  assert.deepEqual(argv("git_blame", { path: "f.txt" }), ["blame", "HEAD", "--", "f.txt"]);
  assert.deepEqual(argv("git_blame", { path: "f.txt", rev: "HEAD~1" }), [
    "blame",
    "HEAD~1",
    "--",
    "f.txt",
  ]);
  refused("git_blame", {}, /path must be a string/);
  refused("git_blame", { path: "-foo" }, /path must not start with/);
  refused("git_blame", { path: "f.txt", rev: "-x" }, /rev must not start with/);
});

test("git_grep: exact argv with -i/-F forms", () => {
  assert.deepEqual(argv("git_grep", { pattern: "foo" }), ["grep", "-n", "-e", "foo"]);
  assert.deepEqual(argv("git_grep", { pattern: "foo", ignoreCase: true }), [
    "grep",
    "-n",
    "-i",
    "-e",
    "foo",
  ]);
  assert.deepEqual(argv("git_grep", { pattern: "foo", fixedStrings: true }), [
    "grep",
    "-n",
    "-F",
    "-e",
    "foo",
  ]);
  assert.deepEqual(
    argv("git_grep", {
      pattern: "foo",
      ignoreCase: true,
      fixedStrings: true,
      paths: ["src"],
    }),
    ["grep", "-n", "-i", "-F", "-e", "foo", "--", "src"],
  );
  // the pattern sits after a literal -e, so even a dash-leading value
  // is unparseable as a flag; the validator still refuses it
  refused("git_grep", { pattern: "-x" }, /pattern must not start with/);
  refused("git_grep", { pattern: "" }, /pattern must be a non-empty string/);
  refused("git_grep", {}, /pattern must be a string/);
  refused("git_grep", { pattern: "x", ignoreCase: "yes" }, /ignoreCase must be a boolean/);
  refused("git_grep", { pattern: "x", fixedStrings: "no" }, /fixedStrings must be a boolean/);
});

test("strings with NUL bytes are refused (spawn would throw on them)", () => {
  refused("git_show", { rev: "HEAD\u0000x" }, /NUL/);
  refused("git_blame", { path: "f\u0000.txt" }, /NUL/);
});

test("unknown verbs and non-object params are refused", () => {
  refused("git_foo", {}, /unknown verb/);
  refused("git_status", null, /params must be an object/);
  refused("git_status", ["status"], /params must be an object/);
  refused("git_status", "status", /params must be an object/);
});

test("unknown parameters are refused by the builder", () => {
  refused("git_status", { bogus: 1 }, /unknown parameter: bogus/);
  refused("git_show", { rev: "HEAD", extra: true }, /unknown parameter: extra/);
  refused("git_diff", { from: "a", to: "b", repo: "/x", unknown: 1 }, /unknown parameter: unknown/);
  refused("git_grep", { pattern: "p", args: ["status"] }, /unknown parameter: args/);
});

test("bad entries inside paths are refused", () => {
  refused("git_status", { paths: "not-an-array" }, /paths must be an array/);
  refused("git_status", { paths: ["ok", "-evil"] }, /paths\[1\] must not start with/);
  refused("git_status", { paths: ["", "ok"] }, /paths\[0\] must be a non-empty string/);
  refused("git_log", { rev: "HEAD", paths: [5] }, /paths\[0\] must be a string/);
  // paths is not a git_blame parameter: the unknown-param check fires first
  refused("git_blame", { path: "f.txt", paths: ["-x"] }, /unknown parameter: paths/);
  refused("git_grep", { pattern: "p", paths: ["-x"] }, /paths\[0\] must not start with/);
});

test("bad types for non-string parameters are refused", () => {
  refused("git_show", { rev: 5 }, /rev must be a string/);
  refused("git_diff", { from: null, to: "b" }, /from must be a string/);
  refused("git_blame", { path: "f.txt", rev: 42 }, /rev must be a string/);
});

test("every built argv passes the read floor", () => {
  const corpus: Array<[string, unknown]> = [
    ["git_status", { paths: ["a", "b"] }],
    ["git_diff", { from: "a", to: "b", paths: ["c"] }],
    ["git_log", { rev: "HEAD", maxCount: 3, paths: ["d"] }],
    ["git_show", { rev: "HEAD" }],
    ["git_blame", { path: "f.txt", rev: "HEAD" }],
    ["git_grep", { pattern: "p", ignoreCase: true, fixedStrings: true, paths: ["e"] }],
  ];
  for (const [name, params] of corpus) {
    const built = buildVerbArgv(name, params) as Built;
    if ("error" in built) {
      throw new Error(`corpus entry failed: ${name} ${built.error}`);
    }
    assert.equal(floorViolation(built.argv), null, `${name}: ${JSON.stringify(built.argv)}`);
  }
});
