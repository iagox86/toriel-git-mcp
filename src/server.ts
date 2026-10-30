import { homedir } from "node:os";
import path from "node:path";
import { formatGitResult, runGit } from "./git.ts";
import { classify, floorViolation, type GitClass } from "./policy.ts";
import { invalidParams, type RpcHandler } from "./protocol.ts";

interface ToolSpec {
  name: string;
  gitClass: GitClass;
  description: string;
  annotations: Record<string, unknown>;
}

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
  return [
    {
      name: "git_read",
      gitClass: "read",
      description:
        `Run a read-only git command: status, log, diff, show, blame, branch (list forms), tag (list forms), stash list/show, config --get/--list, grep, rev-parse, ls-files, and similar. Mutating and network subcommands are rejected. ${scope}`,
      annotations: { readOnlyHint: true },
    },
    {
      name: "git_write",
      gitClass: "write",
      description:
        `Run a repository-mutating git command: add, commit, restore, switch, checkout, reset, revert, cherry-pick, rebase, merge, stash (push/pop/apply), branch/tag deletion or creation, and similar. No network operations. ${scope}`,
      annotations: { destructiveHint: true },
    },
    {
      name: "git_net",
      gitClass: "net",
      description:
        `Run a network git command: push, pull, fetch, ls-remote, clone, submodule. Typically gated behind an approval rule in the permission config. ${scope}`,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
  ];
}

export function createHandler(repo?: string): RpcHandler {
  const tools = buildTools(repo);
  return (method: string, params: unknown) => {
    if (method === "tools/list") {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: ARGS_SCHEMA,
          annotations: tool.annotations,
        })),
      };
    }

    const { name, arguments: args } = params as {
      name?: unknown;
      arguments?: { args?: unknown };
    };
    const spec = tools.find((tool) => tool.name === name);
    if (!spec) {
      return errorResult(`unknown tool: ${String(name)}`);
    }
    const argv = args?.args;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
      throw invalidParams("args must be a non-empty array of strings, e.g. { args: [\"status\"] }");
    }
    const [cmd, ...rest] = argv;
    if (cmd.startsWith("-")) {
      return errorResult(
        `the first argument must be the git subcommand, not an option (got "${cmd}")`,
      );
    }

    let repoPath: string;
    const requested = (args?.repo as unknown) ?? undefined;
    if (repo) {
      if (requested !== undefined) {
        return errorResult(
          `this server is pinned to ${repo}; omit the repo argument`,
        );
      }
      repoPath = repo;
    } else {
      if (typeof requested !== "string" || requested.trim() === "") {
        return errorResult(
          'repo is required: pass the path to the repository or worktree, e.g. { args: ["status"], repo: "/home/me/project" }',
        );
      }
      repoPath = expandRepoPath(requested);
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

    return runGit(repoPath, argv).then((result) => {
      const { text, isError } = formatGitResult(result);
      return { content: [{ type: "text", text }], isError };
    });
  };
}

function errorResult(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}
