import { spawn } from "node:child_process";
import { hardenReadArgs, type GitClass } from "./policy.ts";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
}

// git trusts a handful of environment variables for exactly the things this
// server pins (repo location, config, transport helpers). Strip them so a
// hostile environment cannot override the -C pin or smuggle config in.
const STRIPPED_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROTOCOL",
  "GIT_ASKPASS",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_NAMESPACE",
  "GIT_ALLOW_PROTOCOL",
  "GIT_COMMON_DIR",
  "GIT_EXTERNAL_DIFF",
  "GIT_EXEC_PATH",
]);

export function sanitizeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.has(key)) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
}

// The child environment for an invocation of the given class. Read-class
// executions get GIT_ALLOW_PROTOCOL=file: any transport a read command might
// be pointed at through repo-local config (remote.<name>.url = ext::...) then
// fails loudly instead of running a helper. Only the file protocol is ever
// needed to read local objects. Write and net classes keep the sanitized
// environment as-is - they are the classes where transports belong, and the
// permission layer, not the server floor, governs them.
//
// Note: GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM are intentionally NOT sanitized
// here; out of scope to change legitimate global config behavior.
export function buildGitEnv(
  gitClass: GitClass | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeEnv(base);
  if (gitClass === "read") {
    env.GIT_ALLOW_PROTOCOL = "file";
  }
  return env;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface RunGitOptions {
  timeoutMs?: number;
  gitClass?: GitClass;
}

export async function runGit(
  repo: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Read-class argv gets the no-helper flags injected here, at the single
  // execution choke point, so every caller - not just the server handler -
  // gets the hardening. args[0] is the subcommand and stays in place.
  let executionArgs = [...args];
  if (options.gitClass === "read" && args.length > 0) {
    executionArgs = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.fsmonitorHook=false",
      args[0],
      ...hardenReadArgs(args[0], args.slice(1)),
    ];
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let done = false;

    // shell: false and an argv array - nothing here is ever interpreted by a
    // shell, and -C is prepended by us, not the caller.
    const child = spawn("git", ["-C", repo, ...executionArgs], {
      shell: false,
      env: buildGitEnv(options.gitClass),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer, current: string): string => {
      if (truncated) {
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill("SIGKILL");
        return next.slice(0, Math.max(0, MAX_OUTPUT_BYTES));
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(chunk, stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(chunk, stderr);
    });

    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: GitResult) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, truncated, timedOut: false, error: String(err) });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, truncated, timedOut: truncated && code === null });
    });
  });
}

export function formatGitResult(result: GitResult): { text: string; isError: boolean } {
  if (result.error) {
    return { text: `git failed to start: ${result.error}`, isError: true };
  }
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.code !== 0) {
    let tail = `exit code ${result.code ?? "unknown"}`;
    if (result.timedOut) {
      tail += " (timed out)";
    }
    if (result.stderr) {
      tail += `\nstderr:\n${result.stderr}`;
    }
    parts.push(tail);
  } else if (result.stderr) {
    parts.push(`stderr:\n${result.stderr}`);
  }
  if (result.truncated) {
    parts.push("(output truncated)");
  }
  return { text: parts.join("\n") || "(no output)", isError: result.code !== 0 };
}
