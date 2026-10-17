// The timeline row the daemon side appends after it reloads an agent.
export const ENV_RELOADED_KIND = "env-reloaded";
export const ENV_RELOADED_VERSION = 1;

// A type alias, not an interface: only an alias satisfies the SDK's JsonValue.
export type EnvReloadedData = {
  /** Variable names only, never values. */
  names: string[];
};
