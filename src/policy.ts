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
  "verify-commit",
  "verify-tag",
  "count-objects",
]);

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
  "show",
  "get-url",
]);

// Per-subcommand screens: true means the invocation is genuinely read-only.
const SCREENS: Record<string, (args: readonly string[]) => boolean> = {
  branch: (args) => !args.some((a) => BRANCH_MUTATING.has(a)),
  tag: (args) =>
    args.length === 0 ||
    args[0] === "-l" ||
    args[0] === "--list" ||
    args[0].startsWith("-n") ||
    TAG_LIST_FLAGS.has(args[0]),
  stash: (args) => args.length > 0 && (args[0] === "list" || args[0] === "show"),
  worktree: (args) => args.length > 0 && args[0] === "list",
  config: (args) =>
    args.length > 0 && (args[0] === "--list" || args[0] === "-l" || args[0].startsWith("--get")),
  remote: (args) => args.length === 0 || REMOTE_READ.has(args[0]),
  reflog: (args) => args[0] !== "expire" && args[0] !== "delete",
  log: noOutputToFile,
  diff: noOutputToFile,
  show: noOutputToFile,
  "diff-tree": noOutputToFile,
  "merge-base": noOutputToFile,
};

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
