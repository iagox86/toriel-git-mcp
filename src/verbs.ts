// Structured, verb-scoped read tools: typed JSON params in, pure argv out.
// User input never becomes a git flag: every user string (revs, paths, the
// grep pattern) must be non-empty and must not start with "-", and the git
// grep pattern travels after a literal -e, so it cannot be parsed as an
// option even if the rule above were bypassed.
//
// Execution goes through the existing read-class path (runGit with
// gitClass "read"), so the no-helper flags, the core.fsmonitor pin,
// GIT_ALLOW_PROTOCOL=file, and the environment stripping are inherited
// from git.ts/policy.ts - nothing here duplicates any of it.
//
// Everything in this module is pure so it can be unit tested exhaustively
// (test/verbs.test.ts).

export type VerbName =
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_show"
  | "git_blame"
  | "git_grep";

export interface VerbTool {
  name: VerbName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true };
}

export type VerbResult = { argv: string[] } | { error: string };

// repo is part of every verb schema: it is consumed by the server for the
// pinned/expanded path and is never an argv input (it is listed in the
// allowed keys so it is not flagged as an unknown parameter).
const REPO_PROPERTY = {
  type: "string",
  description:
    "Path to the repository or worktree to operate on (absolute or ~-prefixed). Omit only when the server was started with --repository.",
} as const;

const PATHS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Limit the command to these paths (git pathspec). Omit for the whole tree.",
} as const;

export const VERB_TOOLS: readonly VerbTool[] = [
  {
    name: "git_status",
    description:
      "Show the working-tree state (git status --porcelain), optionally limited to paths.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_PROPERTY, paths: PATHS_PROPERTY },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_diff",
    description:
      "Show the diff between two revs (git diff). Rev-to-rev only; use git_status for worktree state - a diff that touches the working tree would run clean/smudge attribute filters, which git has no flag to disable.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        from: { type: "string", description: "Older rev to diff from." },
        to: { type: "string", description: "Newer rev to diff to." },
        paths: PATHS_PROPERTY,
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_log",
    description:
      "List commits, one line each (git log --oneline), optionally starting at a rev and limited to paths.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        rev: { type: "string", description: 'Rev to start at (default "HEAD").' },
        maxCount: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Number of commits to show (default 50, clamped to 1-200).",
        },
        paths: PATHS_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_show",
    description: "Show a commit: its message and the diff it introduces (git show).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        rev: { type: "string", description: "Rev to show." },
      },
      required: ["rev"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_blame",
    description:
      "Attribute each line of a tracked file to the commit that last touched it (git blame).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        path: { type: "string", description: "Path of the file to blame." },
        rev: { type: "string", description: "Rev to blame at (default: current content)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_grep",
    description:
      "Search tracked file contents for a pattern (git grep -n). The pattern travels after a literal -e and can never be parsed as a flag.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        pattern: {
          type: "string",
          description: "Pattern to search for (regex unless fixedStrings is true).",
        },
        paths: PATHS_PROPERTY,
        ignoreCase: { type: "boolean", description: "Case-insensitive match (git grep -i)." },
        fixedStrings: {
          type: "boolean",
          description: "Treat the pattern as a literal string, not a regex (git grep -F).",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

// Allowed parameters per verb. Anything outside this set is refused by
// buildVerbArgv (the schema's additionalProperties:false refuses it at the
// client layer too; this is the server-side copy of that check).
const VERB_PARAMS: Record<VerbName, readonly string[]> = {
  git_status: ["repo", "paths"],
  git_diff: ["repo", "from", "to", "paths"],
  git_log: ["repo", "rev", "maxCount", "paths"],
  git_show: ["repo", "rev"],
  git_blame: ["repo", "path", "rev"],
  git_grep: ["repo", "pattern", "paths", "ignoreCase", "fixedStrings"],
};

function checkString(key: string, value: unknown): { value: string } | { error: string } {
  if (typeof value !== "string") {
    return { error: `${key} must be a string` };
  }
  if (value.length === 0) {
    return { error: `${key} must be a non-empty string` };
  }
  if (value.startsWith("-")) {
    return { error: `${key} must not start with "-"` };
  }
  if (value.includes("\0")) {
    return { error: `${key} must not contain NUL bytes` };
  }
  return { value };
}

function checkOptionalString(
  key: string,
  value: unknown,
): { value?: string } | { error: string } {
  if (value === undefined) {
    return { value: undefined };
  }
  return checkString(key, value);
}

function checkPaths(key: string, value: unknown): { value: string[] } | { error: string } {
  if (value === undefined) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return { error: `${key} must be an array of strings` };
  }
  for (let i = 0; i < value.length; i++) {
    const checked = checkString(`${key}[${i}]`, value[i]);
    if ("error" in checked) {
      return checked;
    }
  }
  return { value: value as string[] };
}

function checkOptionalBoolean(key: string, value: unknown): { value: boolean } | { error: string } {
  if (value === undefined) {
    return { value: false };
  }
  if (typeof value !== "boolean") {
    return { error: `${key} must be a boolean` };
  }
  return { value };
}

function pathSuffix(paths: string[]): string[] {
  return paths.length > 0 ? ["--", ...paths] : [];
}

// Builds the argv for a verb call from its typed params. Pure: no I/O, no
// global state. Returns { argv } or { error } with the first problem found.
// The built argv always runs through the read-class path; it is verified in
// tests to pass floorViolation as defense in depth.
export function buildVerbArgv(name: string, params: unknown): VerbResult {
  if (typeof name !== "string" || !(name in VERB_PARAMS)) {
    return { error: `unknown verb: ${String(name)}` };
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { error: "params must be an object" };
  }
  const record = params as Record<string, unknown>;
  const allowed = VERB_PARAMS[name as VerbName];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return { error: `unknown parameter: ${key}` };
    }
  }
  switch (name) {
    case "git_status": {
      const paths = checkPaths("paths", record.paths);
      if ("error" in paths) {
        return paths;
      }
      return { argv: ["status", "--porcelain", ...pathSuffix(paths.value)] };
    }
    case "git_diff": {
      const from = checkString("from", record.from);
      if ("error" in from) {
        return from;
      }
      const to = checkString("to", record.to);
      if ("error" in to) {
        return to;
      }
      const paths = checkPaths("paths", record.paths);
      if ("error" in paths) {
        return paths;
      }
      // Rev-to-rev only, on purpose: worktree-involving diffs would run
      // clean/smudge attribute filters, which git cannot disable. The `--`
      // always terminates the rev list: without it, two positional args that
      // are outside paths make git fall into implicit --no-index mode and
      // READ ARBITRARY HOST FILES (found by review, 2026-11-06).
      return { argv: ["diff", from.value, to.value, "--", ...paths.value] };
    }
    case "git_log": {
      const rev = checkOptionalString("rev", record.rev);
      if ("error" in rev) {
        return rev;
      }
      let maxCount = 50;
      if (record.maxCount !== undefined) {
        if (!Number.isInteger(record.maxCount)) {
          return { error: "maxCount must be an integer" };
        }
        maxCount = Math.min(200, Math.max(1, record.maxCount));
      }
      const paths = checkPaths("paths", record.paths);
      if ("error" in paths) {
        return paths;
      }
      return {
        argv: [
          "log",
          "--oneline",
          "-n",
          String(maxCount),
          rev.value ?? "HEAD",
          "--",
          ...paths.value,
        ],
      };
    }
    case "git_show": {
      const rev = checkString("rev", record.rev);
      if ("error" in rev) {
        return rev;
      }
      // Trailing -- removes the rev-vs-filename ambiguity when a rev names
      // (or shadows) a worktree file.
      return { argv: ["show", rev.value, "--"] };
    }
    case "git_blame": {
      const path = checkString("path", record.path);
      if ("error" in path) {
        return path;
      }
      const rev = checkOptionalString("rev", record.rev);
      if ("error" in rev) {
        return rev;
      }
      // Blame is pinned to a rev (default HEAD): rev-less blame consults the
      // working tree and runs clean/smudge attribute filters on dirty files.
      return { argv: ["blame", rev.value ?? "HEAD", "--", path.value] };
    }
    case "git_grep": {
      const pattern = checkString("pattern", record.pattern);
      if ("error" in pattern) {
        return pattern;
      }
      const paths = checkPaths("paths", record.paths);
      if ("error" in paths) {
        return paths;
      }
      const ignoreCase = checkOptionalBoolean("ignoreCase", record.ignoreCase);
      if ("error" in ignoreCase) {
        return ignoreCase;
      }
      const fixedStrings = checkOptionalBoolean("fixedStrings", record.fixedStrings);
      if ("error" in fixedStrings) {
        return fixedStrings;
      }
      // -e form: the pattern is the value of a flag, never parsed itself as
      // an option.
      return {
        argv: [
          "grep",
          "-n",
          ...(ignoreCase.value ? ["-i"] : []),
          ...(fixedStrings.value ? ["-F"] : []),
          "-e",
          pattern.value,
          ...pathSuffix(paths.value),
        ],
      };
    }
  }
  return { error: `unknown verb: ${String(name)}` };
}
