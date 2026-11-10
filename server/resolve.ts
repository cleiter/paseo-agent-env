import { type ChildProcess, execFile, spawn } from "node:child_process";
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

/**
 * Kill a command and everything it started. The shell runs in its own process group, so a
 * child that outlives it cannot keep writing after a timeout, or hold stdout open and stall the
 * result.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

export function run(
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    /** When the shared budget runs out, as from Date.now(). */
    deadline: number;
    /** The whole budget, for the message: the time left may be much less. */
    budgetMs: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const { file, args } = shellInvocation(command);
  const { signal } = options;
  const timedOut = `timed out (${options.budgetMs} ms budget)`;
  return new Promise((resolve, reject) => {
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) {
      // An earlier command used the budget up; starting this one would only be killed.
      reject(new AgentEnvCommandError(command, timedOut, ""));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        // A process group of its own, so killTree reaches the command's children.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      // spawn validates the environment synchronously, and its message quotes the offending
      // value, which may be a secret.
      reject(new AgentEnvCommandError(command, "invalid environment", ""));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stopped: string | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    const stop = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      killTree(child);
    };
    const timer = setTimeout(() => stop(timedOut), remainingMs);
    const onAbort = () => stop("aborted");
    if (signal?.aborted) stop("aborted");
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_BUFFER) stop("stdout too large");
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      // Only the tail goes to the log.
      stderr = (stderr + chunk).slice(-2 * MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    // "close", not "exit": stdout is complete only once every holder of the pipe is gone.
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (stopped === undefined && spawnError === undefined && code === 0) return resolve(stdout);
      const tail = stderr.length > MAX_STDERR_CHARS ? `...${stderr.slice(-MAX_STDERR_CHARS)}` : stderr;
      let reason: string;
      if (stopped !== undefined) reason = stopped;
      else if (spawnError?.code === "ENOENT") reason = `${file} not found`;
      else if (spawnError !== undefined) reason = "spawn failed";
      else if (code !== null) reason = `exit ${code}`;
      else reason = "killed by a signal";
      reject(new AgentEnvCommandError(command, reason, tail.trim()));
    });
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
  /** One budget for all command layers: Paseo's 30-second limit covers the whole hook. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The launch environment: Paseo's overrides with the plugin's variables on top. On Windows a
 * plugin `Path` must replace a request `PATH`, not sit beside it where the old value may win.
 */
export function mergeLaunchEnv(
  requestEnv: Record<string, string>,
  injected: Record<string, string>,
  caseInsensitive = CASE_INSENSITIVE,
): Record<string, string> {
  const merged = { ...requestEnv };
  if (caseInsensitive) {
    const names = new Set(Object.keys(injected).map((key) => key.toLowerCase()));
    for (const key of Object.keys(merged)) {
      if (names.has(key.toLowerCase())) delete merged[key];
    }
  }
  return { ...merged, ...injected };
}

/**
 * Resolve the layers into the variables to inject. Static layers apply directly and spawn
 * nothing. A command layer runs with every earlier layer applied and contributes only what it
 * set or changed, so it never clobbers an unrelated override.
 */
export async function resolveAgentEnv(options: ResolveOptions): Promise<Record<string, string>> {
  const { layers, cwd, baseEnv, contextEnv, signal } = options;
  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const injected: Record<string, string> = {};

  for (const layer of layers) {
    if (layer.kind === "static") {
      for (const [key, value] of Object.entries(layer.vars)) {
        injected[canonicalKey(key, injected, baseEnv)] = value;
      }
      continue;
    }

    const commandEnv = buildCommandEnv(baseEnv, contextEnv, injected);

    const stdout = await run(layer.command, { cwd, env: commandEnv, deadline, budgetMs, signal });
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
