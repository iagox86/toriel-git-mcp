import { homedir } from "node:os";
import path from "node:path";
import { formatGitResult, runGit } from "./git.ts";
import { classify, floorViolation, type GitClass } from "./policy.ts";
import { invalidParams, type RpcHandler } from "./protocol.ts";
import { buildVerbArgv, VERB_TOOLS, type VerbName } from "./verbs.ts";

interface FacadeSpec {
  name: string;
  gitClass: GitClass;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  verb: false;
}

interface VerbSpec {
  name: VerbName;
  gitClass: "read";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true };
  verb: true;
}

type ToolSpec = FacadeSpec | VerbSpec;

const ARGS_SCHEMA = {
  type: "object",
  properties: {
    args: {
      type: "array",
      items: { type: "string" },
      description:
        'git arguments, first element is the subcommand, e.g. ["log", "--oneline", "-5"]. Passed to git as argv, never through a shell.',
    },
    repo: {
      type: "string",
      description:
        "Path to the repository or worktree to operate on (absolute or ~-prefixed). Omit only when the server was started with --repository.",
    },
  },
  required: ["args"],
  additionalProperties: false,
} as const;

export function expandRepoPath(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return path.resolve(input);
}

export function buildTools(repo?: string): ToolSpec[] {
  const scope = repo
    ? `All commands run in the pinned repository ${repo}; do not pass repo.`
    : "Every call must pass repo: a path to the repository or worktree to operate on (absolute or ~-prefixed).";
  const facades: FacadeSpec[] = [
    {
      name: "git_read",
      gitClass: "read",
      description:
        `Run a read-only git command: status, log, diff, show, blame, branch (list forms), tag (list forms), stash list/show, config --get/--list, grep, rev-parse, ls-files, and similar. Mutating and network subcommands are rejected. ${scope}`,
      inputSchema: ARGS_SCHEMA,
      annotations: { readOnlyHint: true },
      verb: false,
    },
    {
      name: "git_write",
      gitClass: "write",
      description:
        `Run a repository-mutating git command: add, commit, restore, switch, checkout, reset, revert, cherry-pick, rebase, merge, stash (push/pop/apply), branch/tag deletion or creation, and similar. No network operations. ${scope}`,
      inputSchema: ARGS_SCHEMA,
      annotations: { destructiveHint: true },
      verb: false,
    },
    {
      name: "git_net",
      gitClass: "net",
      description:
        `Run a network git command: push, pull, fetch, ls-remote, clone, submodule. Typically gated behind an approval rule in the permission config. ${scope}`,
      inputSchema: ARGS_SCHEMA,
      annotations: { destructiveHint: true, openWorldHint: true },
      verb: false,
    },
  ];
  // Structured verbs: typed params, server-built argv, read-class hardening
  // inherited from the shared execution path.
  const verbs: VerbSpec[] = VERB_TOOLS.map((tool) => ({
    name: tool.name,
    gitClass: "read",
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    verb: true,
  }));
  return [...facades, ...verbs];
}

export function createHandler(repo?: string): RpcHandler {
  const tools = buildTools(repo);
  return (method: string, params: unknown) => {
    if (method === "tools/list") {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      };
    }

    const { name, arguments: callParams } = params as {
      name?: unknown;
      arguments?: unknown;
    };
    const spec = tools.find((tool) => tool.name === name);
    if (!spec) {
      return errorResult(`unknown tool: ${String(name)}`);
    }

    if (spec.verb) {
      // Structured verbs take an object of typed params, not the args array.
      // Omitted arguments is an empty object (every git_status/git_log param
      // is optional).
      if (
        callParams !== undefined &&
        (typeof callParams !== "object" || callParams === null || Array.isArray(callParams))
      ) {
        return errorResult(
          `parameters must be an object, e.g. { rev: "HEAD" }`,
        );
      }
      const record = (callParams ?? {}) as Record<string, unknown>;
      const built = buildVerbArgv(spec.name, record);
      if (built.error) {
        return errorResult(built.error);
      }
      const repoResolution = resolveRepoPath(repo, record.repo ?? undefined, '{ rev: "HEAD", repo: "/home/me/project" }');
      if (repoResolution.error) {
        return errorResult(repoResolution.error);
      }
      // Defense in depth: server-built argv must pass the same floor the
      // facades are held to. The builder guarantees it; the check is cheap.
      const violation = floorViolation(built.argv);
      if (violation) {
        return errorResult(
          `argument "${violation}" is rejected: it can escape the pinned repository, inject config, or invoke transport helpers`,
        );
      }
      return runGit(repoResolution.path, built.argv, { gitClass: "read" }).then((result) => {
        const { text, isError } = formatGitResult(result);
        return { content: [{ type: "text", text }], isError };
      });
    }

    const argv = (callParams as { args?: unknown } | undefined)?.args;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
      throw invalidParams("args must be a non-empty array of strings, e.g. { args: [\"status\"] }");
    }
    const [cmd, ...rest] = argv;
    if (cmd.startsWith("-")) {
      return errorResult(
        `the first argument must be the git subcommand, not an option (got "${cmd}")`,
      );
    }

    const repoResolution = resolveRepoPath(repo, (callParams as { repo?: unknown } | undefined)?.repo, '{ args: ["status"], repo: "/home/me/project" }');
    if (repoResolution.error) {
      return errorResult(repoResolution.error);
    }

    const violation = floorViolation(argv);
    if (violation) {
      return errorResult(
        `argument "${violation}" is rejected: it can escape the pinned repository, inject config, or invoke transport helpers`,
      );
    }

    const actual = classify(cmd, rest);
    if (actual === null) {
      return errorResult(`git subcommand "${cmd}" is not permitted by this server`);
    }
    if (actual !== spec.gitClass) {
      const owner = tools.find((tool) => tool.gitClass === actual)?.name ?? actual;
      return errorResult(
        `"${cmd}" with these arguments is a ${actual} operation; call ${owner} instead`,
      );
    }

    // actual === spec.gitClass past the check above; passing the class lets
    // runGit apply read-class hardening (no-helper flags, GIT_ALLOW_PROTOCOL=file).
    return runGit(repoResolution.path, argv, { gitClass: actual }).then((result) => {
      const { text, isError } = formatGitResult(result);
      return { content: [{ type: "text", text }], isError };
    });
  };
}

// Shared repo pin/expand handling for facades and verbs. Returns the path to
// run in, or an error message for the response.
function resolveRepoPath(
  pinned: string | undefined,
  requested: unknown,
  example: string,
): { path: string } | { error: string } {
  if (pinned) {
    if (requested !== undefined) {
      return { error: `this server is pinned to ${pinned}; omit the repo argument` };
    }
    return { path: pinned };
  }
  if (typeof requested !== "string" || requested.trim() === "") {
    return { error: `repo is required: pass the path to the repository or worktree, e.g. ${example}` };
  }
  return { path: expandRepoPath(requested) };
}

function errorResult(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}
