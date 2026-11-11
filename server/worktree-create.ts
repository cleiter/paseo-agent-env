import type { PluginHookWorktree, PluginServerContext } from "@getpaseo/plugin/server";
import { readAgentEnvConfig } from "./config";
import { AgentEnvCommandError, buildCommandEnv, DEFAULT_TIMEOUT_MS, run } from "./resolve";

/** What Paseo's `worktree.create.after` hook passes: the new worktree, already on disk. */
export type CreatedWorktree = PluginHookWorktree;

/**
 * Run the new worktree's `worktreeCreate` commands, one after another, in the worktree.
 * Paseo awaits the hook before setup, terminals and the first agent, so whatever the commands
 * write is there when the agent's environment resolves. A failure throws, and Paseo then
 * removes the worktree instead of starting an agent in a half-prepared one.
 *
 * stdout is not read: these commands prepare files, they do not print an environment.
 */
export async function runWorktreeCreateCommands(options: {
  worktree: CreatedWorktree;
  baseEnv: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { worktree, baseEnv, signal } = options;
  // The working copy of the new worktree, as for layers: the branch decides.
  const config = await readAgentEnvConfig(worktree.path);
  const env = buildCommandEnv(baseEnv, {
    PASEO_WORKTREE_PATH: worktree.path,
    PASEO_SOURCE_CHECKOUT_PATH: worktree.sourceCheckout,
    PASEO_BRANCH_NAME: worktree.branch,
  });
  // One budget for all commands: Paseo's 30-second limit covers the whole hook.
  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  for (const command of config.worktreeCreate) {
    await run(command, {
      cwd: worktree.path,
      env,
      deadline,
      budgetMs,
      signal,
    });
  }
  return config.worktreeCreate;
}

export function addWorktreeCreatedHook(server: PluginServerContext): () => void {
  return server.addHook("worktree.create.after", async ({ worktree }, { signal }) => {
    try {
      const commands = await runWorktreeCreateCommands({ worktree, baseEnv: process.env, signal });
      if (commands.length > 0) {
        console.log(`worktree ${worktree.path}: ran ${commands.length} worktreeCreate command(s)`);
      }
    } catch (error) {
      if (error instanceof AgentEnvCommandError) {
        console.error(`${error.message}\ncwd: ${worktree.path}\nstderr: ${error.stderr || "(empty)"}`);
      }
      // Paseo removes the worktree, so no agent starts in a half-prepared one.
      throw error;
    }
  });
}
