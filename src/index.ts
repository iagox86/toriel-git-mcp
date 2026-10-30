import path from "node:path";
import { serve, type RpcHandler } from "./protocol.ts";
import { createHandler } from "./server.ts";

const SERVER_INFO = { name: "toriel-git-mcp", version: "0.1.0" };

interface Config {
  repository?: string;
}

function parseArgs(argv: readonly string[]): Config {
  let repository: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repository") {
      const value = argv[i + 1];
      if (!value) {
        fail("--repository requires a path");
      }
      repository = path.resolve(value);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { repository };
}

function fail(message: string): never {
  process.stderr.write(`toriel-git-mcp: ${message}\n\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  process.stderr.write(
    "usage: node src/index.ts [--repository <path>]\n\n" +
      "MCP stdio server exposing git as three tools:\n" +
      "  git_read  read-only commands (status, log, diff, ...)\n" +
      "  git_write mutating commands (add, commit, rebase, ...)\n" +
      "  git_net   network commands (push, pull, fetch, ...)\n\n" +
      "With --repository every call runs in that path. Without it, each call\n" +
      "must pass repo: a path to the repository or worktree to operate on.\n",
  );
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const handler: RpcHandler = createHandler(config.repository);
  await serve(process.stdin, process.stdout, handler, SERVER_INFO);
}

main().catch((err) => {
  process.stderr.write(`toriel-git-mcp: ${String(err)}\n`);
  process.exit(1);
});
