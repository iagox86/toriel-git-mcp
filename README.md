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
`-v`/`get-url` (`remote show` is a write: it contacts the remote and honors
`remote.<name>.url` configured transports); `reflog expire`/`delete` and
`--output` are writes. `verify-commit`/`verify-tag` are not permitted at all.
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
3. Repository-local config (`.git/config`, `.git/config.worktree`) is still
   trusted by git, and some settings execute programs. The server closes the
   read-surface holes server-side, without asking git to change behavior:
   - Read invocations get no-helper flags injected right after the
     subcommand, BEFORE the caller's args (`diff`, `diff-tree`:
     `--no-ext-diff --no-textconv`; `log`, `show` additionally
     `--no-show-signature`; `blame`: `--no-ext-diff --no-textconv`), so
     `diff.external`, `diff.<driver>.command`, `diff.<driver>.textconv`, and
     `gpg.program` in the repository config cannot be executed from a read
     command. Before the caller's args, not after: appended flags would be
     swallowed as pathspecs by a `--` separator.
   - Because git honors the last of a repeated flag, the read screens also
     REFUSE the caller passing `--ext-diff`, `--textconv` or
     `--show-signature` to the diff family (`log`, `show`, `diff`,
     `diff-tree`, `blame`): those invocations classify as write, which
     `git_read` cannot run.
   - `verify-commit` and `verify-tag` are not permitted at all (they run
     `gpg.program` directly).
   - `core.fsmonitor` from repo config is pinned to `false` for read-class
     children (server-side `-c core.fsmonitor=false
     core.fsmonitorHook=false`): the fsmonitor hook fires from plain reads
     like `status` and `diff`, and no flag defends it.
   - `git grep` refuses `-O`/`--open-files-in-pager` in any form (attached
     value, bare, abbreviated): it runs a caller-supplied program on the
     matches - no repo config required.
   - `remote show` is not a read (it contacts the remote and honors
     `ext::`/configured transports); `git_read` refuses it.
   - Read-class children get `GIT_ALLOW_PROTOCOL=file`, so any transport a
     read command is pointed at through repo config fails loudly instead of
     running. Write and net classes are unaffected.

   Remaining trust boundary: `clean`/`smudge` attribute filters (for example
   `filter.<name>.clean` in `.gitattributes`) DO run from read commands such
   as `git diff`, and git offers no flag to disable them. The permission
   layer's ask-gate on `git_read` is the control for that; repositories with
   untrusted working trees should not get an unconditional `git_read` allow.

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

- `src/policy.ts` - classification tables, read screens, deny floor, read-argv hardening (pure, unit tested)
- `src/git.ts` - process spawn, env sanitization, no-helper flag + protocol hardening, output caps, timeout
- `src/protocol.ts` - minimal MCP JSON-RPC over stdio
- `src/server.ts` - tool descriptors and the tools/call handler
- `src/index.ts` - argument parsing and wiring
