Gives agents the environment your project defines with direnv, mise, or any other tool. Paseo starts agent CLIs without your interactive shell, so shell hooks never run and agents miss the project's `PATH`, SDK versions, and secrets. This plugin fixes that for the agent and for the MCP servers it starts.

Configure it in `.paseo/plugins/paseo-agent-env/config.json` in the repository. Because the file is checked in, everyone with the plugin gets the same setup. `layers` is an ordered list of commands that print the environment and maps of static variables; later layers win:

```json
{
  "layers": [
    { "CLAUDE_CONFIG_DIR": ".claude-work" },
    "direnv status | grep -q 'Found RC allowed 0' || { echo '.envrc is not allowed: run direnv allow' >&2; exit 1; }; direnv exec . env -0",
    "mise env --json"
  ]
}
```

Commands print JSON, NUL-delimited, or newline-delimited `KEY=VALUE` output, and only the variables they add or change are injected. They run on every session open (create, resume, refresh, import) in the main checkout, also for worktree agents, so direnv approval and gitignored secrets work on a new worktree. A failing command, a timeout, or invalid output stops the launch instead of starting the agent with a partial environment. Command output never appears in the error; stderr goes to the plugin log.

Paseo starts the first agent of a new worktree before worktree setup runs, so that agent can miss variables setup writes later. After each turn the plugin runs the layers again, and if the environment changed it reloads the idle agent with the new one; the conversation stays and a timeline row names the changed variables. The first turn itself still runs without them. Set `"reloadOnChange": false` to turn this off. To have those variables from the first turn, list commands under `worktreeCreate`: they run in a new worktree before its setup and its first agent.

Commands in the config run unattended on every agent launch, the same trust model as `worktree.setup`. Only open repositories you trust. Requires Paseo 0.15.0 or later; on Windows, commands run in PowerShell.
