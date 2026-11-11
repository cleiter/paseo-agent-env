# paseo-agent-env

A Paseo plugin that gives agents the environment your project already defines with direnv, mise, or any other tool. Configure it with a checked-in file, so everyone who installs the plugin gets the same setup.

Paseo starts agent CLIs directly, not through your interactive shell, so shell hooks like `direnv hook zsh` or `mise activate` never run. Without this plugin, the agent and the MCP servers it starts miss the project's `PATH`, SDK versions, and secrets.

## Configuration

Create `.paseo/plugins/paseo-agent-env/config.json` in the repository root and commit it. Paseo's Hub config lives in the same `.paseo/` directory. `layers` is an ordered list:

- A **string** is a command that prints the environment to stdout.
- An **object** is a set of static variables. Nothing runs.

```json
{
  "layers": [
    { "CLAUDE_CONFIG_DIR": ".claude-work" },
    "direnv status | grep -q 'Found RC allowed 0' || { echo '.envrc is not allowed: run direnv allow' >&2; exit 1; }; direnv exec . env -0",
    "mise env --json"
  ]
}
```

Layers merge left to right, and later layers win. Each command runs with the earlier layers already applied.

`reloadOnChange` is optional and defaults to `true`. See [Reload on change](#reload-on-change).

### Command output

A command prints the environment to stdout in one of three encodings. The plugin detects which one.

| Encoding                      | Example                | Multi-line values |
| ----------------------------- | ---------------------- | ----------------- |
| JSON object                   | `mise env --json`      | Yes               |
| NUL-delimited `KEY=VALUE`     | `direnv exec . env -0` | Yes               |
| Newline-delimited `KEY=VALUE` | `echo FOO=bar`         | No                |

Use a JSON or NUL-delimited form when a value can contain a newline, such as a PEM key. Write logs to stderr; anything on stdout that is not an environment fails the launch.

A full dump such as `env -0` is fine: only variables the command added or changed are injected. In JSON, a `null` value withdraws a variable that an earlier layer set.

### direnv

```json
{
  "layers": ["direnv status | grep -q 'Found RC allowed 0' || { echo '.envrc is not allowed: run direnv allow' >&2; exit 1; }; direnv exec . env -0"]
}
```

Run `direnv allow` once in the main checkout. The guard is there because `direnv exec` exits 0 on a blocked `.envrc` and runs the command without it, which would start the agent without the project's variables. Tested with direnv 2.38.2.

Do not use `direnv export json`. It prints only the difference to the current environment, so it prints nothing when the daemon already has that `.envrc` loaded.

### mise

```json
{ "layers": ["mise env --json"] }
```

This prints the `[env]` block and the tool `PATH` from `mise.toml`. Run `mise trust` once. An untrusted config makes `mise env` exit 1, which fails the launch.

## Behavior

- **When it runs.** On every session open: create, resume, refresh, and import. History-only opens are skipped.
- **Where commands run.** In the main checkout, also when the agent works in a worktree. direnv approval and gitignored secrets such as `.envrc.local` exist only there, so a new worktree works before its setup has run. As a consequence, paths that `.envrc` adds (such as `PATH_add bin`) point into the main checkout. To evaluate the worktree instead, use `direnv exec "$PASEO_WORKTREE_PATH" env -0` and allow each worktree.
- **Which config.** The working copy of the file at the root of the agent's own checkout. A branch can change it, and an edit applies on the next launch without a commit. Paseo reads its own `paseo.json` from the committed base branch instead; this file does not follow that rule.
- **Validation.** A missing or non-array `layers` and malformed entries are errors, so a typo cannot silently drop a layer. An unknown key only logs a warning, so a config that uses a key from a newer plugin version still works with an older one.
- **Variables for commands.** `PASEO_SOURCE_CHECKOUT_PATH`, `PASEO_WORKTREE_PATH`, `PASEO_AGENT_CWD`, and `PASEO_BRANCH_NAME` when on a branch.
- **Precedence.** Variables from the plugin win over other launch overrides with the same name. Commands can add and replace variables, but not remove daemon variables.
- **Failures.** A non-zero exit, a timeout, unparseable output, or an invalid config file stops the launch. The error names the command but never includes its output. The command's stderr goes to `paseo plugin logs paseo-agent-env`, so keep secrets out of stderr.
- **Timeout.** All commands of a launch share 25 seconds. A timeout stops the command and every process it started. Paseo aborts the whole hook after 30 seconds.
- **Snapshot.** Commands run once per session open. With `reloadOnChange`, the plugin also checks again after each turn; see below.
- **Scope.** The agent CLI and everything it starts, including stdio MCP servers. Paseo's own commands and terminals keep the daemon environment. The provider availability check runs before the hook, so the agent CLI itself must be on the daemon's `PATH`.
- **Windows.** Commands run in PowerShell.

## Reload on change

Paseo starts the first agent of a new worktree before `worktree.setup` runs. Anything setup writes, such as a per-worktree `.envrc.local` or port file, is missing from that agent's environment. The hook cannot wait for setup: Paseo fails the launch after 30 seconds, and setup is often slower.

So the plugin repairs it afterwards. When a turn ends, it runs the layers again. If the result differs from what the agent got at launch and the agent is idle, the plugin reloads the agent. The provider process restarts with the new environment and the conversation stays. A row in the timeline names the changed variables, never their values.

- **The first turn still runs without the late variables.** A reload in the middle of a turn would end the turn. To have them from the first turn, write them with `worktreeCreate` (next section). Otherwise make the project's commands re-read the environment, for example `eval "$(direnv export bash)"`.
- **The re-check costs one run of the layers per turn.** Turn it off with `"reloadOnChange": false`.
- **Variables that change on every run do not cause reload loops.** A variable that changes again right after the reload meant to fix it is ignored from then on. `DIRENV_*` bookkeeping never counts as a change.
- **Removing the layers reloads too.** When the file is deleted or `layers` is empty, the agent reloads without the variables it got at launch.
- **A turn that starts at the moment of a reload ends.** The plugin checks that the agent is idle just before it reloads, but Paseo has no reload-if-idle call, so a prompt sent in that instant is cut short.
- **A failed re-check does not reload.** It goes to the plugin log, and the agent keeps running with its current environment.
- **Tracking lives in memory.** After a plugin reload or daemon restart, an agent is checked again only after its next launch.

## Prepare new worktrees

`worktreeCreate` lists commands that run once in a new worktree, after `git worktree add` and before setup, terminals and the first agent. Paseo waits for them, so files they write are there when the agent's layers run.

```json
{
  "layers": ["\"$PASEO_WORKTREE_PATH/bin/agent-env\""],
  "worktreeCreate": ["bin/prepare-worktree"]
}
```

- **Where and with what.** Commands run in the new worktree, one after another, with the daemon environment plus `PASEO_WORKTREE_PATH`, `PASEO_SOURCE_CHECKOUT_PATH` and `PASEO_BRANCH_NAME`. stdout is ignored; stderr goes to the plugin log when a command fails.
- **Keep them fast.** All commands share one 25-second budget, inside Paseo's 30 seconds for the hook. Leave dependency installs in `worktree.setup`.
- **A failure stops the creation.** Paseo removes the worktree, so no agent starts in a half-prepared one.
- **The branch is the placeholder.** Paseo renames a new branch after the first prompt, later than this hook. Key anything that must stay stable on the worktree path, not the branch.
- **Not on restore.** Paseo does not run the hook when it recreates an archived worktree. Run the same commands from `worktree.setup` too if they must exist there.
- **Copying files.** For gitignored files such as `.env`, use Paseo's built-in `.worktreeinclude` instead of a command.

## Trust

A command in the config runs on every agent launch, and a `worktreeCreate` command on every new worktree, in any repository that contains the file. This is the same trust model as `worktree.setup` in `paseo.json`: only open repositories you trust. Static variables run nothing.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload paseo-agent-env
```

Requires Paseo 0.15.0 or later.
