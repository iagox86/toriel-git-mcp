# toriel-git-mcp

A small MCP stdio server that exposes git as exactly three permission-scoped
tools over one pinned repository. No dependencies, no build step; runs directly
under node 23.6+ (type stripping).

The point is not git functionality - any agent can shell out to git. The point
is that each class of git operation becomes a separately named tool, so a
permission layer can allow, ask, or deny per class without parsing shell
commands.

## Tools

| tool        | class | annotation          | examples                                        |
| ----------- | ----- | ------------------- | ----------------------------------------------- |
| `git_read`  | read  | `readOnlyHint`      | status, log, diff, show, blame, branch/tag list  |
| `git_write` | write | `destructiveHint`   | add, commit, restore, reset, rebase, branch -D   |
| `git_net`   | net   | `destructiveHint`   | push, pull, fetch, ls-remote, clone, submodule   |

All three take the same single argument:

```json
{ "args": ["log", "--oneline", "-5"] }
```

The first element must be the git subcommand (options-before-subcommand is
rejected). Arguments go to git as argv - never through a shell.

Class-mixed subcommands resolve by their arguments: `branch` and `tag` are
readable in list forms but classify as write with `-D`/`-a`; `stash` reads only
`list`/`show`; `config` reads only `--get*`/`--list`; `remote` reads only
`-v`/`show`/`get-url`; `reflog expire`/`delete` and `--output` are writes. Each
tool refuses invocations that classify outside its own class and names the tool
that owns them.

## Security model

Defense in depth, two layers:

1. The permission layer (e.g. pi-permission-system) decides whether a call to
   `git_read`/`git_write`/`git_net` is allowed at all.
2. The server itself enforces a floor on every call, including allowed ones:
   - The repository is pinned once at startup via `--repository`; `git -C` is
     prepended by the server and `-C`, `--git-dir`, `--work-tree`,
     `--namespace`, `--super-prefix`, `--exec-path` are rejected.
   - Config injection is rejected (`-c key=val`, `-ckey=val`).
   - Transport helpers and protocol tricks are rejected (`--upload-pack`,
     `--receive-pack`, `--exec`, `--server-option`, `-o`, `ext::` URLs).
   - Dangerous `GIT_*` environment variables are stripped from the child
     environment (`GIT_DIR`, `GIT_CONFIG_*`, `GIT_SSH*`, ...), and
     `GIT_TERMINAL_PROMPT=0` prevents hangs on credential prompts.
   - Output is capped at 512 KiB per stream, commands time out after 30 s,
     and failures return exit code plus stderr instead of being swallowed.

A rule misconfiguration degrades to a prompt or an error, never to a sandbox
escape.

## Setup with pi

`~/.pi/agent/mcp.json` (user level) or `<project>/.pi/mcp.json` (project level):

```json
{
  "mcpServers": {
    "git": {
      "command": "node",
      "args": ["/home/ron/projects/toriel-git-mcp/src/index.ts", "--repository", "/home/ron/projects/whatever"]
    }
  }
}
```

One server instance is pinned to one repository; add one entry per project.

## Setup with pi-permission-system

MCP calls resolve to targets including the bare tool name, so:

```json
{
  "permission": {
    "mcp": {
      "git_read": "allow",
      "git_write": "ask",
      "git_net": "deny"
    }
  }
}
```

Reads run without friction, writes prompt, and network operations are refused
outright. `git_net` is deny-by-default by design; enable it only deliberately.

## Development

```sh
npm test    # unit + stdio integration tests against a disposable fixture repo
```

Run the server by hand (it speaks newline-delimited JSON-RPC on stdin):

```sh
node src/index.ts --repository ~/projects/somerepo
```

## Layout

- `src/policy.ts` - classification tables, read screens, deny floor (pure, unit tested)
- `src/git.ts` - process spawn, env sanitization, output caps, timeout
- `src/protocol.ts` - minimal MCP JSON-RPC over stdio
- `src/server.ts` - tool descriptors and the tools/call handler
- `src/index.ts` - argument parsing and wiring
