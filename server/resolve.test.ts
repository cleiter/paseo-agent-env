import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEnvCommandError, mergeLaunchEnv, resolveAgentEnv } from "./resolve";

const BASE = { PATH: process.env.PATH, HOME: process.env.HOME, KEEP: "daemon" };

describe("resolveAgentEnv", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "agent-env-resolve-")));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function resolve(layers: Parameters<typeof resolveAgentEnv>[0]["layers"], extra = {}) {
    return resolveAgentEnv({ layers, cwd, baseEnv: BASE, contextEnv: {}, ...extra });
  }

  it("injects static variables without running anything", async () => {
    expect(await resolve([{ kind: "static", vars: { A: "1" } }])).toEqual({ A: "1" });
  });

  it("injects only what a command changed", async () => {
    const env = await resolve([
      {
        kind: "command",
        command: `printf 'KEEP=daemon\\0NEW=x\\0PWD=/nope\\0DIRENV_IN_ENVRC=1\\0XPC_SERVICE_NAME=0\\0'`,
      },
    ]);
    expect(env).toEqual({ NEW: "x" });
  });

  it("runs commands in cwd with earlier layers and context applied", async () => {
    const env = await resolve(
      [
        { kind: "static", vars: { GREETING: "hi" } },
        { kind: "command", command: `printf 'OUT=%s:%s:%s\\0' "$GREETING" "$CTX" "$(pwd)"` },
      ],
      { contextEnv: { CTX: "ctx" } },
    );
    expect(env).toEqual({ GREETING: "hi", OUT: `hi:ctx:${cwd}` });
  });

  it("lets later layers win", async () => {
    const env = await resolve([
      { kind: "static", vars: { A: "static" } },
      { kind: "command", command: `printf 'A=command\\0'` },
      { kind: "static", vars: { B: "last" } },
    ]);
    expect(env).toEqual({ A: "command", B: "last" });
  });

  it("keeps a multi-line secret intact", async () => {
    const env = await resolve([
      { kind: "command", command: `printf 'KEY=line1\\nline2\\n\\0'` },
    ]);
    expect(env).toEqual({ KEY: "line1\nline2\n" });
  });

  it("withdraws an earlier layer's value when a command prints null", async () => {
    const env = await resolve([
      { kind: "static", vars: { A: "1", B: "2" } },
      { kind: "command", command: `echo '{"A":null,"KEEP":null}'` },
    ]);
    expect(env).toEqual({ B: "2" });
  });

  it("hides daemon runtime switches from commands", async () => {
    const env = await resolveAgentEnv({
      layers: [{ kind: "command", command: `printf 'SEEN=%s\\0' "\${ELECTRON_RUN_AS_NODE-unset}"` }],
      cwd,
      baseEnv: { ...BASE, ELECTRON_RUN_AS_NODE: "1" },
      contextEnv: {},
    });
    expect(env).toEqual({ SEEN: "unset" });
  });

  it("fails on a non-zero exit with stderr kept out of the message", async () => {
    const error = await resolve([
      { kind: "command", command: "printf 'token=sec%s' ret >&2; exit 3" },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentEnvCommandError);
    const failure = error as AgentEnvCommandError;
    expect(failure.message).toContain("exit 3");
    expect(failure.message).not.toContain("secret");
    expect(failure.stderr).toBe("token=secret");
  });

  it("fails on output that is not an environment, without quoting it", async () => {
    const error = await resolve([{ kind: "command", command: "printf 'hunter%s\\n' 2" }]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentEnvCommandError);
    expect((error as Error).message).not.toContain("hunter2");
  });

  it("fails on timeout", async () => {
    await expect(
      resolve([{ kind: "command", command: "sleep 5" }], { timeoutMs: 200 }),
    ).rejects.toThrow("timed out (200 ms budget)");
  });

  it("shares one time budget across all command layers", async () => {
    const slow = { kind: "command" as const, command: "sleep 0.3; echo A=1" };
    await expect(resolve([slow, slow], { timeoutMs: 450 })).rejects.toThrow(
      "timed out (450 ms budget)",
    );
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills what the command started when it times out", async () => {
    // The child holds stdout open too, so without killing it the result would never arrive.
    const command = `sleep 30 & echo $! > child.pid; wait`;
    await expect(resolve([{ kind: "command", command }], { timeoutMs: 300 })).rejects.toThrow(
      "timed out (300 ms budget)",
    );
    const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("kills what the command started when it is aborted", async () => {
    const controller = new AbortController();
    const pending = resolve([{ kind: "command", command: `sleep 30 & echo $! > child.pid; wait` }], {
      signal: controller.signal,
    });
    while (!existsSync(join(cwd, "child.pid"))) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow("(aborted)");
    const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("fails on an environment the OS cannot carry, without quoting it", async () => {
    const error = await resolveAgentEnv({
      layers: [{ kind: "command", command: "echo A=1" }],
      cwd,
      baseEnv: { ...BASE, TOKEN: "hunter\0two" },
      contextEnv: {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentEnvCommandError);
    expect((error as Error).message).toContain("invalid environment");
    expect((error as Error).message).not.toContain("hunter");
  });
});

describe("mergeLaunchEnv", () => {
  it("puts the plugin's variables over the request's", () => {
    expect(mergeLaunchEnv({ A: "req", B: "req" }, { A: "plugin" }, false)).toEqual({
      A: "plugin",
      B: "req",
    });
  });

  it("replaces a differently cased request variable where names are case-insensitive", () => {
    expect(mergeLaunchEnv({ PATH: "old", B: "req" }, { Path: "new" }, true)).toEqual({
      Path: "new",
      B: "req",
    });
    // Case-sensitive platforms keep both.
    expect(mergeLaunchEnv({ PATH: "old" }, { Path: "new" }, false)).toEqual({ PATH: "old", Path: "new" });
  });
});
