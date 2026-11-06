# toriel-git-mcp

A small MCP stdio server that exposes git as three permission-scoped
facades plus six structured read verbs, over one pinned repository. No
dependencies, no build step; runs directly under node 23.6+ (type stripping).

The point is not git functionality - any agent can shell out to git. The
point is that each class of git operation becomes a separately named tool, so a
permission layer can allow, ask, or deny per class without parsing shell
commands. The structured verbs go one step further: they take typed parameters
and build their argv themselves, so user input can never become a git flag.

## Tools

Three permission-scoped facades:

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

Six structured read verbs: each is `readOnly`, takes typed JSON parameters,
builds its argv itself (structured argv - user input can never become a git
flag), and inherits the read-class hardening (no-helper flags, fsmonitor pin,
`GIT_ALLOW_PROTOCOL=file`, env stripping) from the shared execution path:

| tool         | does                                                        | parameters                                                                     |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `git_status` | working-tree state (`--porcelain`)                           | `paths?`                                                                        |
| `git_diff`   | diff between two revs - rev-to-rev only; use `git_status` for worktree state, since worktree-involving diffs would run clean/smudge attribute filters that git cannot disable | `from`, `to`, `paths?`                                              |
| `git_log`    | one-line commit list                                        | `rev?` (default HEAD), `maxCount?` (default 50, clamped 1-200), `paths?`          |
| `git_show`   | a commit's message and diff                                  | `rev`                                                                           |
| `git_blame`  | line attribution for a tracked file                          | `path`, `rev?`                                                                  |
| `git_grep`   | search tracked file contents (pattern travels after a literal `-e`) | `pattern`, `paths?`, `ignoreCase?`, `fixedStrings?`                  |

Every tool (facades and verbs) also takes the optional `repo` argument.

Class-mixed subcommands resolve by their arguments: `branch` and `tag` are
readable in list forms but classify as write with `-D`/`-a`; `stash` reads only
`list`/`show`; `config` reads only `--get*`/`--list`; `remote` reads only
`-v`/`get-url` (`remote show` is a write: it contacts the remote and honors
`remote.<name>.url` configured transports); `reflog expire`/`delete` and
`--output` are writes. `verify-commit`/`verify-tag` are not permitted at all.
tool refuses invocations that classify outside its own class and names the tool
that owns them. The verbs bypass classification entirely: their argv is built
server-side from validated params, and the deny floor is still applied to the
built argv as defense in depth.

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
   `filter.<name>.clean` in `.gitattributes`) DO run from read commands that
   consult the working tree, and git offers no flag to disable them. The
   verbs are shaped to avoid it: `git_diff` is rev-to-rev only (both sides
   come from the object store) and `git_blame` is pinned to `HEAD` (rev-less
   blame blames working-tree lines and runs the filter). `git_status` still
   runs the filter for a STAT-dirty file (unchanged content, new mtime - git
   runs clean to confirm no change; asserted in the tests so this claim
   stays honest), and `git_show`/`git_log`/`git_grep` never touch the
   working tree. Repositories with untrusted working trees should not get an
   unconditional `git_read` allow.

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
      "git_status": "allow",
      "git_diff": "allow",
      "git_log": "allow",
      "git_show": "allow",
      "git_blame": "allow",
      "git_grep": "allow",
      "git_read": "ask",
      "git_write": "ask",
      "git_net": "deny"
    }
  }
}
```

Grant the six structured verb tools to agents that only need to inspect the
repository: their argv is built server-side, they inherit the read-class
hardening, and the validator refuses dash-leading values, so they are safe to
allow. Keep `git_read` at `ask` for full agents (the raw facade is where the
clean/smudge residual lives); set it to `allow` only for repositories you
trust. `git_write` prompts and `git_net` is deny-by-default by design; enable
`git_net` only deliberately.

## Development

```sh
npm test    # unit + stdio integration tests against disposable fixture repos
```

Run the server by hand (it speaks newline-delimited JSON-RPC on stdin):

```sh
node src/index.ts --repository ~/projects/somerepo
```

## Layout

- `src/policy.ts` - classification tables, read screens, deny floor, read-argv hardening (pure, unit tested)
- `src/verbs.ts` - structured verb tools: JSON schemas and pure argv builders (pure, unit tested)
- `src/git.ts` - process spawn, env sanitization, no-helper flag + protocol hardening, output caps, timeout
- `src/protocol.ts` - minimal MCP JSON-RPC over stdio
- `src/server.ts` - tool descriptors and the tools/call handler
- `src/index.ts` - argument parsing and wiring
