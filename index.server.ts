import type { PluginServerContext } from "@getpaseo/plugin/server";
import { type CheckoutPaths, resolveCheckout } from "./server/checkout";
import { type AgentEnvConfig, readAgentEnvConfig } from "./server/config";
import { reloadAgent } from "./server/reload";
import { AgentEnvCommandError, mergeLaunchEnv, resolveAgentEnv } from "./server/resolve";
import { AgentEnvTracker } from "./server/tracker";
import { addWorktreeCreatedHook } from "./server/worktree-create";
import { ENV_RELOADED_KIND, ENV_RELOADED_VERSION, type EnvReloadedData } from "./shared/timeline";

interface Resolution {
  checkout: CheckoutPaths;
  config: AgentEnvConfig;
  injected: Record<string, string>;
}

/** The checkout around an agent cwd and the config in it. */
async function loadFor(cwd: string): Promise<Omit<Resolution, "injected">> {
  const checkout = await resolveCheckout(cwd);
  // The working copy in the agent's own checkout, so the config follows the branch and an
  // edit applies on the next launch.
  const config = await readAgentEnvConfig(checkout.worktreePath);
  return { checkout, config };
}

/** Run the configured layers; null when the checkout has no layers. */
async function resolveFor(
  { checkout, config }: Omit<Resolution, "injected">,
  cwd: string,
  requestEnv: Record<string, string>,
  signal: AbortSignal,
): Promise<Resolution | null> {
  if (config.layers.length === 0) return null;

  try {
    const injected = await resolveAgentEnv({
      layers: config.layers,
      // The source checkout: direnv approval and gitignored secrets live there, so a fresh
      // worktree works before anything runs in it.
      cwd: checkout.sourceCheckoutPath,
      baseEnv: process.env,
      contextEnv: {
        PASEO_SOURCE_CHECKOUT_PATH: checkout.sourceCheckoutPath,
        PASEO_WORKTREE_PATH: checkout.worktreePath,
        PASEO_AGENT_CWD: cwd,
        ...(checkout.branchName ? { PASEO_BRANCH_NAME: checkout.branchName } : {}),
        ...requestEnv,
      },
      signal,
    });
    return { checkout, config, injected };
  } catch (error) {
    if (error instanceof AgentEnvCommandError) {
      // stderr only; stdout is the environment and never gets logged.
      console.error(
        `${error.message}\ncwd: ${checkout.sourceCheckoutPath}\nstderr: ${error.stderr || "(empty)"}`,
      );
    }
    throw error;
  }
}

// Names only; values may be secrets.
const listNames = (names: string[]) => names.join(", ") || "nothing";

export default function contribute(server: PluginServerContext) {
  const tracker = new AgentEnvTracker();

  const removeOpen = server.before("agent.session_open", async ({ request }, { signal }) => {
    // A history session only reads the transcript; a broken .envrc must not hide it.
    if (request.purpose === "history") return undefined;

    const resolution = await resolveFor(await loadFor(request.cwd), request.cwd, request.env, signal);
    if (!resolution) {
      tracker.forget(request.agentId);
      return undefined;
    }
    tracker.record(request.agentId, {
      cwd: request.cwd,
      requestEnv: request.env,
      injected: resolution.injected,
    });
    console.log(
      `agent ${request.agentId} (${request.reason}): injected ${listNames(Object.keys(resolution.injected).sort())}`,
    );
    return { ...request, env: mergeLaunchEnv(request.env, resolution.injected) };
  });

  // Paseo starts an agent before worktree setup runs, so the first launch can miss variables
  // that setup writes. A turn end is the first moment the agent is idle: check again and
  // reload it if the environment changed.
  const removeTurnEnded = server.on("agent.turn_ended", async ({ agent }, { paseo, signal }) => {
    const launch = tracker.get(agent.id);
    if (!launch) return;

    let injected: Record<string, string>;
    try {
      // The flag first: with reloadOnChange off, a turn end runs nothing.
      const loaded = await loadFor(launch.cwd);
      if (!loaded.config.reloadOnChange) return;
      // No layers any more: everything injected at launch has to go.
      injected = (await resolveFor(loaded, launch.cwd, launch.requestEnv, signal))?.injected ?? {};
    } catch (error) {
      // A reload now would fail the launch and leave the agent stopped. Keep it running.
      console.error(`agent ${agent.id}: re-check failed, not reloading: ${String(error)}`);
      return;
    }

    const names = tracker.reloadReasons(agent.id, injected);
    if (names.length === 0) return;

    const handle = paseo.agents.ref(agent.id);
    await handle.refresh();
    if (handle.status !== "idle") {
      // A new turn started meanwhile; the next turn end checks again.
      console.log(`agent ${agent.id}: environment changed (${listNames(names)}), agent busy`);
      return;
    }

    try {
      await reloadAgent(agent.id, signal);
    } catch (error) {
      // Not marked as reloaded, so the next turn end retries instead of taking the same change
      // for a volatile variable.
      console.error(`agent ${agent.id}: environment changed (${listNames(names)}), reload failed: ${String(error)}`);
      return;
    }
    tracker.markReloaded(agent.id, names);
    console.log(`agent ${agent.id}: environment changed (${listNames(names)}), reloaded`);
    const data: EnvReloadedData = { names };
    await handle.timeline.append({
      type: "plugin",
      id: `env-reloaded-${Date.now()}`,
      kind: ENV_RELOADED_KIND,
      version: ENV_RELOADED_VERSION,
      data,
    });
  });

  const removeWorktreeCreated = addWorktreeCreatedHook(server);

  // Not on agent.closed: a reload closes the runtime too, and the reload bookkeeping must
  // survive it.
  const removeArchived = server.on("agent.archived", ({ agent }) => tracker.forget(agent.id));

  return () => {
    removeOpen();
    removeTurnEnded();
    removeArchived();
    removeWorktreeCreated();
  };
}
