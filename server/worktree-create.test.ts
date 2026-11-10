import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "./config";
import { AgentEnvCommandError } from "./resolve";
import { addWorktreeCreatedHook, runWorktreeCreateCommands } from "./worktree-create";

const BASE = { PATH: process.env.PATH, HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: "1" };

describe("runWorktreeCreateCommands", () => {
  let dir: string;
  let worktree: { path: string; branch: string; sourceCheckout: string };
  const configure = (config: unknown) => {
    const file = join(worktree.path, CONFIG_PATH);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config));
  };
  const runFor = (timeoutMs?: number) =>
    runWorktreeCreateCommands({ worktree, baseEnv: BASE, ...(timeoutMs ? { timeoutMs } : {}) });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-env-worktree-")));
    worktree = { path: join(dir, "wt"), branch: "amazing-swan", sourceCheckout: join(dir, "main") };
    mkdirSync(worktree.path);
    mkdirSync(worktree.sourceCheckout);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does nothing without a config or commands", async () => {
    expect(await runFor()).toEqual([]);
    configure({ layers: [] });
    expect(await runFor()).toEqual([]);
  });

  it("runs the commands in order in the new worktree with the Paseo variables", async () => {
    configure({
      layers: [],
      worktreeCreate: [
        `printf '%s|%s|%s|%s|%s' "$(pwd)" "$PASEO_WORKTREE_PATH" "$PASEO_SOURCE_CHECKOUT_PATH" "$PASEO_BRANCH_NAME" "\${ELECTRON_RUN_AS_NODE:-unset}" > out`,
        "printf ':second' >> out",
      ],
    });
    await runFor();
    expect(readFileSync(join(worktree.path, "out"), "utf8")).toBe(
      `${worktree.path}|${worktree.path}|${worktree.sourceCheckout}|amazing-swan|unset:second`,
    );
  });

  it("stops at the first failing command", async () => {
    configure({ layers: [], worktreeCreate: ["echo boom >&2; exit 3", "touch never"] });
    const failure = await runFor().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentEnvCommandError);
    expect((failure as AgentEnvCommandError).reason).toBe("exit 3");
    expect((failure as AgentEnvCommandError).stderr).toBe("boom");
    expect(() => readFileSync(join(worktree.path, "never"))).toThrow();
  });

  it("shares one time budget across all commands", async () => {
    configure({ layers: [], worktreeCreate: ["sleep 0.3", "sleep 0.3"] });
    const failure = await runFor(450).catch((error: unknown) => error);
    expect((failure as AgentEnvCommandError).reason).toBe("timed out (450 ms budget)");
  });

  it("does not start a command once the budget is used up", async () => {
    configure({ layers: [], worktreeCreate: ["sleep 0.3", "touch never"] });
    const failure = await runFor(300).catch((error: unknown) => error);
    expect((failure as AgentEnvCommandError).reason).toBe("timed out (300 ms budget)");
    expect(() => readFileSync(join(worktree.path, "never"))).toThrow();
  });

  it("fails on an invalid config instead of skipping it", async () => {
    configure({ layers: [], worktreeCreate: "bin/prepare" });
    await expect(runFor()).rejects.toThrow("`worktreeCreate` must be an array of commands");
  });
});

describe("addWorktreeCreatedHook", () => {
  type Handler = (payload: unknown, context: { signal: AbortSignal }) => Promise<void>;
  const asServer = (value: object) => value as Parameters<typeof addWorktreeCreatedHook>[0];

  it("does nothing on a Paseo without addHook", () => {
    const remove = addWorktreeCreatedHook(asServer({}));
    expect(() => remove()).not.toThrow();
  });

  it("does nothing when addHook does not know the hook", () => {
    const server = asServer({
      addHook: () => {
        throw new Error("Unknown lifecycle hook: worktree.create.after");
      },
    });
    expect(() => addWorktreeCreatedHook(server)()).not.toThrow();
  });

  it("registers worktree.create.after and rethrows a failing command", async () => {
    let registered: { name: string; handler: Handler } | undefined;
    const removed: string[] = [];
    const server = asServer({
      addHook(name: string, handler: Handler) {
        registered = { name, handler };
        return () => removed.push(name);
      },
    });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-env-hook-")));
    try {
      const file = join(dir, CONFIG_PATH);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ layers: [], worktreeCreate: ["exit 1"] }));

      const remove = addWorktreeCreatedHook(server);
      expect(registered?.name).toBe("worktree.create.after");
      await expect(
        registered!.handler(
          { worktree: { path: dir, branch: "b", sourceCheckout: dir } },
          { signal: new AbortController().signal },
        ),
      ).rejects.toBeInstanceOf(AgentEnvCommandError);
      remove();
      expect(removed).toEqual(["worktree.create.after"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
