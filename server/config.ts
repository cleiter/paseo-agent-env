import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One layer of the agent's environment. A string in the config is a command that prints the
 * environment to stdout; an object is a static set of variables.
 */
export type AgentEnvLayer =
  | { kind: "static"; vars: Record<string, string> }
  | { kind: "command"; command: string };

// Checked in beside Paseo's own repository config (.paseo/hub.yml, .paseo/triggers/).
export const CONFIG_PATH = join(".paseo", "plugins", "paseo-agent-env", "config.json");

export interface AgentEnvConfig {
  layers: AgentEnvLayer[];
  /** Reload an idle agent when its environment changed after launch. */
  reloadOnChange: boolean;
  /** Commands that run in a new worktree before its setup and its first agent. */
  worktreeCreate: string[];
}

const EMPTY: AgentEnvConfig = { layers: [], reloadOnChange: true, worktreeCreate: [] };

const KNOWN_KEYS = new Set(["layers", "reloadOnChange", "worktreeCreate"]);

export class AgentEnvConfigError extends Error {
  constructor(configPath: string, detail: string) {
    super(`Invalid ${configPath}: ${detail}`);
    this.name = "AgentEnvConfigError";
  }
}

function parseLayer(value: unknown, index: number, configPath: string): AgentEnvLayer {
  if (typeof value === "string") {
    const command = value.trim();
    if (command.length === 0) {
      throw new AgentEnvConfigError(configPath, `layers[${index}] is an empty command`);
    }
    return { kind: "command", command };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const vars: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.length === 0 || key.includes("=")) {
        throw new AgentEnvConfigError(configPath, `layers[${index}] has an invalid name "${key}"`);
      }
      if (typeof entry !== "string") {
        throw new AgentEnvConfigError(configPath, `layers[${index}]: "${key}" must be a string`);
      }
      vars[key] = entry;
    }
    return { kind: "static", vars };
  }
  throw new AgentEnvConfigError(
    configPath,
    `layers[${index}] must be a command string or a map of string variables`,
  );
}

function parseWorktreeCreate(value: unknown, configPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new AgentEnvConfigError(configPath, "`worktreeCreate` must be an array of commands");
  }
  return value.map((entry, index) => {
    const command = typeof entry === "string" ? entry.trim() : "";
    if (command.length === 0) {
      throw new AgentEnvConfigError(configPath, `worktreeCreate[${index}] must be a non-empty command`);
    }
    return command;
  });
}

/**
 * Validate the config document:
 * `{ "layers": [...], "reloadOnChange"?: boolean, "worktreeCreate"?: [...] }`. Layers merge left to right, so
 * precedence is visible in the file.
 *
 * Strict on purpose: dropping a malformed entry would launch the agent with a partial
 * environment, and a missing secret shows up much later as an unexplained auth failure inside
 * an MCP server. `layers` is required, so a misspelled `layers` still fails.
 *
 * Unknown keys only warn: a repository's config may use a key from a newer plugin version, and
 * an older plugin must not fail every launch over it.
 */
export function parseConfig(
  value: unknown,
  configPath: string,
  warn: (message: string) => void = console.warn,
): AgentEnvConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentEnvConfigError(configPath, "expected an object with a `layers` array");
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) {
      warn(`${configPath}: ignoring unknown key "${key}" (a typo, or a key from a newer plugin version)`);
    }
  }
  const { layers, reloadOnChange = true, worktreeCreate = [] } = value as Record<string, unknown>;
  if (!Array.isArray(layers)) {
    throw new AgentEnvConfigError(configPath, "`layers` must be an array");
  }
  if (typeof reloadOnChange !== "boolean") {
    throw new AgentEnvConfigError(configPath, "`reloadOnChange` must be true or false");
  }
  return {
    layers: layers.map((entry, index) => parseLayer(entry, index, configPath)),
    reloadOnChange,
    worktreeCreate: parseWorktreeCreate(worktreeCreate, configPath),
  };
}

/** The config in `<dir>/.paseo/plugins/paseo-agent-env/config.json`; no layers when absent. */
export async function readAgentEnvConfig(dir: string): Promise<AgentEnvConfig> {
  const configPath = join(dir, CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AgentEnvConfigError(configPath, "not valid JSON");
  }
  return parseConfig(json, configPath);
}
