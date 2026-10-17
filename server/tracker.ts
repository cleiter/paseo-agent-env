export interface AgentLaunch {
  cwd: string;
  /** The launch overrides from Paseo and earlier plugins; a re-check reuses them. */
  requestEnv: Record<string, string>;
  /** What the plugin injected. Kept in memory only; values may be secrets. */
  injected: Record<string, string>;
}

interface AgentState extends AgentLaunch {
  /** Names a reload was meant to fix; a repeat change marks them volatile. */
  lastReloadNames: Set<string>;
  /** Names whose value changes on every run, such as a timestamp. Never trigger a reload. */
  volatile: Set<string>;
}

// Tool bookkeeping that changes whenever the real variables do, or on its own when a watched
// file is touched. It never justifies a reload by itself, and it would clutter the reason.
const BOOKKEEPING_PREFIXES = ["DIRENV_"];

const isBookkeeping = (name: string) => BOOKKEEPING_PREFIXES.some((p) => name.startsWith(p));

/** Names whose value differs between two injected maps, sorted. */
export function changedNames(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

/**
 * What each live agent got at launch. In memory: a plugin reload starts empty, and agents
 * launched before it are re-checked only after their next launch.
 */
export class AgentEnvTracker {
  private readonly agents = new Map<string, AgentState>();

  /** Record a launch. Reload bookkeeping survives, because a reload is a launch too. */
  record(agentId: string, launch: AgentLaunch): void {
    const previous = this.agents.get(agentId);
    this.agents.set(agentId, {
      ...launch,
      lastReloadNames: previous?.lastReloadNames ?? new Set(),
      volatile: previous?.volatile ?? new Set(),
    });
  }

  get(agentId: string): AgentLaunch | undefined {
    return this.agents.get(agentId);
  }

  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * The names that justify a reload, or an empty list. A name that changes again right after a
   * reload that was meant to fix it is volatile: reloading would not settle it, only loop.
   */
  reloadReasons(agentId: string, current: Record<string, string>): string[] {
    const state = this.agents.get(agentId);
    if (!state) return [];
    const changed = changedNames(state.injected, current).filter((name) => !isBookkeeping(name));
    for (const name of changed) {
      if (state.lastReloadNames.has(name)) state.volatile.add(name);
    }
    state.lastReloadNames = new Set();
    return changed.filter((name) => !state.volatile.has(name));
  }

  markReloaded(agentId: string, names: string[]): void {
    const state = this.agents.get(agentId);
    if (state) state.lastReloadNames = new Set(names);
  }
}
