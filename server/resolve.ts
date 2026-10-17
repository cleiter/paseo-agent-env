import { execFile } from "node:child_process";
import type { AgentEnvLayer } from "./config";
import { parseEnvOutput } from "./parse";

const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 2000;

// Paseo's hook budget is 30 seconds for all plugins together; leave room for the rest.
export const DEFAULT_TIMEOUT_MS = 25_000;

// Daemon runtime switches that must not leak into a project command. ELECTRON_RUN_AS_NODE in
// particular turns any Electron app the command starts into a bare Node process.
const RUNTIME_CONTROL_KEYS = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
  // Startup files would rewrite the environment behind the command's back.
  "BASH_ENV",
  "ENV",
];

// Bookkeeping that tools set on their own. It differs from the baseline, so it would otherwise
// count as a change and reach the agent as noise.
const SHELL_NOISE_KEYS = new Set([
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  // `direnv exec` leaks its "evaluating .envrc" flag into the command it runs.
  "DIRENV_IN_ENVRC",
  // On macOS `direnv exec` resets this launchd variable to "0", with or without an .envrc.
  "XPC_SERVICE_NAME",
]);

/**
 * Raised when a command layer fails: non-zero exit, spawn error, timeout, or unparseable
 * output. The message never carries the command's output, because the output of an env tool is
 * where the secrets are. `stderr` is for the plugin log only.
 */
export class AgentEnvCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
    readonly stderr: string,
  ) {
    super(`paseo-agent-env command failed (${reason}): ${command}. See \`paseo plugin logs paseo-agent-env\`.`);
    this.name = "AgentEnvCommandError";
  }
}

// Windows variable names are case-insensitive: a command printing `Path` must update `PATH`,
// not sit beside it.
const CASE_INSENSITIVE = process.platform === "win32";

function findKey(env: Record<string, unknown>, key: string): string | undefined {
  if (key in env) return key;
  if (!CASE_INSENSITIVE) return undefined;
  const lowered = key.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lowered);
}

function canonicalKey(key: string, ...sources: Record<string, unknown>[]): string {
  for (const source of sources) {
    const found = findKey(source, key);
    if (found !== undefined) return found;
  }
  return key;
}

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }
  return { file: "bash", args: ["-c", command] };
}

export function run(
  command: string,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const { file, args } = shellInvocation(command);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER,
        signal: options.signal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const tail = stderr.length > MAX_STDERR_CHARS ? `...${stderr.slice(-MAX_STDERR_CHARS)}` : stderr;
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        let reason: string;
        if (options.signal?.aborted) reason = "aborted";
        else if (failure.killed) reason = `timed out after ${options.timeoutMs} ms`;
        else if (failure.code === "ENOENT") reason = `${file} not found`;
        else if (typeof failure.code === "number") reason = `exit ${failure.code}`;
        else reason = "spawn failed";
        reject(new AgentEnvCommandError(command, reason, tail.trim()));
      },
    );
  });
}

/**
 * The environment a project command runs with: the sources merged left to right, minus the
 * daemon's runtime switches.
 */
export function buildCommandEnv(
  ...sources: Record<string, string | undefined>[]
): Record<string, string> {
  const commandEnv: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) commandEnv[canonicalKey(key, commandEnv)] = value;
    }
  }
  for (const key of RUNTIME_CONTROL_KEYS) {
    const found = findKey(commandEnv, key);
    if (found !== undefined) delete commandEnv[found];
  }
  return commandEnv;
}

export interface ResolveOptions {
  layers: AgentEnvLayer[];
  /** Where commands run. */
  cwd: string;
  /** The daemon's inherited environment. */
  baseEnv: Record<string, string | undefined>;
  /** Variables every command sees but that are not injected unless a command changes them. */
  contextEnv: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolve the layers into the variables to inject. Static layers apply directly and spawn
 * nothing. A command layer runs with every earlier layer applied and contributes only what it
 * set or changed, so it never clobbers an unrelated override.
 */
export async function resolveAgentEnv(options: ResolveOptions): Promise<Record<string, string>> {
  const { layers, cwd, baseEnv, contextEnv, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injected: Record<string, string> = {};

  for (const layer of layers) {
    if (layer.kind === "static") {
      for (const [key, value] of Object.entries(layer.vars)) {
        injected[canonicalKey(key, injected, baseEnv)] = value;
      }
      continue;
    }

    const commandEnv = buildCommandEnv(baseEnv, contextEnv, injected);

    const stdout = await run(layer.command, { cwd, env: commandEnv, timeoutMs, signal });
    let printed: Record<string, string | null>;
    try {
      printed = parseEnvOutput(stdout);
    } catch (error) {
      throw new AgentEnvCommandError(
        layer.command,
        error instanceof Error ? error.message : String(error),
        "",
      );
    }

    for (const [key, value] of Object.entries(printed)) {
      if (SHELL_NOISE_KEYS.has(key)) continue;
      const existing = findKey(commandEnv, key);
      if (value === null) {
        // Paseo's override map can only add or replace, so only an earlier layer's value can
        // be withdrawn. A daemon variable stays.
        const own = findKey(injected, key);
        if (own !== undefined) delete injected[own];
        continue;
      }
      if (existing !== undefined && commandEnv[existing] === value) continue;
      injected[canonicalKey(key, injected, commandEnv)] = value;
    }
  }

  return injected;
}
