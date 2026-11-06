// Classification of git subcommands into the three permission-scoped tool
// classes. Everything here is pure so it can be unit tested exhaustively.

export type GitClass = "read" | "write" | "net";

// Subcommands that only inspect the repository. A handful of them are
// class-mixed (branch/tag/stash/...) and get resolved by the screens below.
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
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
  "diff-tree",
  "merge-base",
  "for-each-ref",
  "show-branch",
  "count-objects",
]);

// verify-commit / verify-tag are deliberately absent: they run gpg.program,
// which repo-local .git/config can point at any executable.

export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "add",
  "rm",
  "mv",
  "commit",
  "switch",
  "checkout",
  "restore",
  "reset",
  "revert",
  "cherry-pick",
  "rebase",
  "merge",
  "am",
  "apply",
  "clean",
  "gc",
  "prune",
  "bisect",
  "notes",
  "replace",
  "update-ref",
  "symbolic-ref",
  "init",
  "init-db",
]);

export const NET_COMMANDS: ReadonlySet<string> = new Set([
  "push",
  "pull",
  "fetch",
  "ls-remote",
  "clone",
  "submodule",
]);

const VERSION_ARGS: ReadonlySet<string> = new Set([
  "version",
  "--version",
  "help",
  "-h",
  "--help",
]);

// Flags that would let a "read" call escape the pinned repository, inject
// config, or hand git a helper executable. Denied for every class; the
// permission layer governs whether a call is allowed, this floor governs
// whether an allowed call can break out of the sandbox.
const DENIED_EXACT: ReadonlySet<string> = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--server-option",
  "-o",
]);

const DENIED_PREFIXES: readonly string[] = [
  "-C",
  "--git-dir=",
  "--work-tree=",
  "--namespace=",
  "--super-prefix=",
  "--exec-path=",
  "--upload-pack=",
  "--receive-pack=",
  "--exec=",
  "--server-option=",
  "ext::",
];

// Attached config injection, e.g. -cfoo=bar. Bare "-c" on diff/log/show is the
// combined-diff flag and stays allowed; the global "git -c key=val <cmd>"
// config form is already impossible because the subcommand must be args[0].
const CONFIG_INJECTION = /^-c[\w.-]+=/;

export function floorViolation(args: readonly string[]): string | null {
  for (const arg of args) {
    if (DENIED_EXACT.has(arg) || DENIED_PREFIXES.some((p) => arg.startsWith(p))) {
      return arg;
    }
    if (CONFIG_INJECTION.test(arg)) {
      return arg;
    }
  }
  return null;
}

// diff/log can write to arbitrary files via --output; every other read flag
// inspected here is inspect-only.
function noOutputToFile(args: readonly string[]): boolean {
  return !args.some((a) => a === "--output" || a.startsWith("--output="));
}

const BRANCH_MUTATING: ReadonlySet<string> = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "--copy",
  "-f",
  "--force",
  "--edit-description",
  "--set-upstream-to",
  "-u",
  "--unset-upstream",
  "--track",
  "--no-track",
]);

const TAG_LIST_FLAGS: ReadonlySet<string> = new Set([
  "-l",
  "--list",
  "-n",
  "--contains",
  "--points-at",
  "--merged",
  "--no-merged",
  "--sort",
  "--format",
  "--color",
  "--column",
  "-i",
]);

const REMOTE_READ: ReadonlySet<string> = new Set([
  "-v",
  "--verbose",
  "get-url",
]);
// "show" is not in the screen: `remote show` contacts the remote (a network
// side effect) and honors remote.<name>.url configured transports such as
// ext::sh -c ..., so repo-local config could execute a program. With the
// screen, `remote show` falls through to class "write", which git_read
// refuses.

// Per-subcommand screens: true means the invocation is genuinely read-only.
// The hardenReadArgs flags cannot rely on position: git honors the LAST of a
// repeated boolean flag, so a caller-supplied --ext-diff / --textconv /
// --show-signature after our injected --no-* would re-enable the helper.
// These are refused on the read screens outright (classify falls to
// "write", which the read tool cannot run).
const READ_REENABLE: ReadonlySet<string> = new Set([
  "--ext-diff",
  "--textconv",
  "--show-signature",
]);

function reenablesHelpers(args: readonly string[]): boolean {
  return args.some((a) => READ_REENABLE.has(a));
}

// git grep's -O/--open-files-in-pager runs a program (the value, or
// core.pager for the bare form) on the matches - arbitrary execution the
// caller supplies directly, no repo config needed. Two forms to refuse:
// long abbreviations (--open works for --open-files-in-pager, value can be
// attached) and bundled shorts (-nOcmd puts -O last with the command
// attached, so a startsWith("-O") check is not enough - any single-dash arg
// containing an O is refused; false positives are fail-closed).
function opensInPager(args: readonly string[]): boolean {
  return args.some((a) => /^-[^-]*O/.test(a) || a.startsWith("--open"));
}

// Two positional path-like args to `diff` make git fall into implicit
// --no-index mode, which reads ARBITRARY FILES on the host (verified live:
// `git -C repo diff /tmp/a /tmp/b` prints both files). Revs never look like
// this (refs/heads/x, HEAD~1, abc123 are fine), so refusing path-shaped
// positionals on the diff family is fail-closed and cheap. The structured
// git_diff verb additionally always emits `--` after its revs.
const DIFF_PATH_LIKE = /^(\/|\.\.?($|\/)|~)/;

function diffPathArgs(args: readonly string[]): boolean {
  return args.some((a) => !a.startsWith("-") && DIFF_PATH_LIKE.test(a));
}

const SCREENS: Record<string, (args: readonly string[]) => boolean> = {
  branch: (args) => !args.some((a) => BRANCH_MUTATING.has(a)),
  tag: (args) =>
    // Allowlist, not denylist: git accepts long-flag abbreviations, so a
    // denylist misses --dele for --delete (verified live). Every dash-arg
    // must be a known-safe list flag, and list mode must be positively
    // requested - a bare `tag v1.0` creates a tag.
    args.every((a) => !a.startsWith("-") || TAG_LIST_FLAGS.has(a) || a.startsWith("-n")) &&
    (args.length === 0 || args.some((a) => TAG_LIST_FLAGS.has(a) || a.startsWith("-n"))),
  stash: (args) => args.length > 0 && (args[0] === "list" || args[0] === "show"),
  worktree: (args) => args.length > 0 && args[0] === "list",
  config: (args) =>
    args.length > 0 && (args[0] === "--list" || args[0] === "-l" || args[0].startsWith("--get")),
  remote: (args) => args.length === 0 || REMOTE_READ.has(args[0]),
  reflog: (args) => args[0] !== "expire" && args[0] !== "delete",
  grep: (args) => !opensInPager(args),
  log: (args) => noOutputToFile(args) && !reenablesHelpers(args),
  diff: (args) => noOutputToFile(args) && !reenablesHelpers(args) && !diffPathArgs(args),
  show: (args) => noOutputToFile(args) && !reenablesHelpers(args),
  "diff-tree": (args) => noOutputToFile(args) && !reenablesHelpers(args) && !diffPathArgs(args),
  blame: (args) => !reenablesHelpers(args),
  "merge-base": noOutputToFile,
};

// Flags injected server-side into read invocations so a repo-local
// .git/config cannot execute helper programs: diff.external /
// diff.<driver>.command / diff.<driver>.textconv run from the diff family,
// and gpg.program runs when log/show verify signatures. Every flag was
// verified to be accepted by its command against a fixture repo
// (test/git.test.ts).
// Injected BEFORE the user's args: appended flags would land after a `--`
// pathspec separator and be parsed as paths, silently leaving the helpers
// live. Caller flags that re-enable helpers (--ext-diff/--textconv/
// --show-signature, which win as the last repeated flag) are refused by the
// screens above, so position does not matter for them.
//
// merge-base is deliberately absent: git rejects both --no-ext-diff and
// --no-textconv there (verified empirically), and merge-base does not run
// diff.external in git 2.55.
const READ_ARG_HARDENING: ReadonlyMap<string, readonly string[]> = new Map([
  ["diff", ["--no-ext-diff", "--no-textconv"]],
  ["diff-tree", ["--no-ext-diff", "--no-textconv"]],
  ["log", ["--no-ext-diff", "--no-textconv", "--no-show-signature"]],
  ["show", ["--no-ext-diff", "--no-textconv", "--no-show-signature"]],
  ["blame", ["--no-ext-diff", "--no-textconv"]],
]);

// Returns the argv for a read-class invocation with the no-helper flags
// injected before the user's args where needed. Pure; always returns a new
// array.
export function hardenReadArgs(cmd: string, args: readonly string[]): string[] {
  const extra = READ_ARG_HARDENING.get(cmd);
  if (extra === undefined) {
    return [...args];
  }
  // Flags go FIRST, before user args: flags after them would land after a
  // `--` pathspec separator in the caller's args and be parsed as paths,
  // silently leaving diff.external and friends live (found by review,
  // 2026-11-06). Re-enable attempts via the caller's own flags are refused
  // by the screens, not by position.
  return [...extra, ...args];
}

// Returns the class the invocation actually belongs to, or null when the
// subcommand is not permitted at all. Class-mixed subcommands resolve to the
// more powerful class when their args escape the read screen, so a read tool
// can never run them and a write tool can.
export function classify(cmd: string, args: readonly string[]): GitClass | null {
  if (VERSION_ARGS.has(cmd)) {
    return "read";
  }
  if (NET_COMMANDS.has(cmd)) {
    return "net";
  }
  if (READ_COMMANDS.has(cmd)) {
    const screen = SCREENS[cmd];
    if (screen && !screen(args)) {
      return "write";
    }
    return "read";
  }
  if (WRITE_COMMANDS.has(cmd)) {
    return "write";
  }
  return null;
}
