import { execFile } from "node:child_process";

// Above Paseo's 30-second hook limit, in case the CLI waits for the new session to open.
const RELOAD_TIMEOUT_MS = 40_000;

/**
 * Restart an agent's provider process; the conversation stays. The plugin SDK has no reload
 * call, so this goes through the Paseo CLI the daemon names in PASEO_CLI. The reload opens a new
 * session, which runs the plugin's launch hook again with the current environment.
 */
export function reloadAgent(agentId: string, signal?: AbortSignal): Promise<void> {
  const cli = process.env.PASEO_CLI || "paseo";
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ["agent", "reload", agentId],
      { timeout: RELOAD_TIMEOUT_MS, signal, encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(new Error(`${cli} agent reload ${agentId} failed: ${stderr.trim() || error.message}`));
      },
    );
  });
}
