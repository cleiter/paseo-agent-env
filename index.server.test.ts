import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contribute from "./index.server";
import { CONFIG_PATH } from "./server/config";

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

/** The plugin wired to a fake server and a fake agent handle that records reloads. */
function setup(dir: string) {
  const handlers: Record<string, Handler> = {};
  const server = {
    addHook: (name: string, handler: Handler) => ((handlers[name] = handler), () => {}),
  };
  const remove = contribute(server as unknown as Parameters<typeof contribute>[0]);

  const signal = new AbortController().signal;
  const open = (reason: string) =>
    handlers["agent.open.before"]!(
      { request: { agentId: "a", cwd: dir, env: {}, purpose: "interactive", reason } },
      { signal },
    );

  const appended: unknown[] = [];
  const agent = {
    status: "idle",
    reloads: 0,
    /** Makes the next reload fail, like a daemon that briefly cannot reopen the session. */
    failNextReload: false,
    refresh: async () => {},
    // Like the daemon: a reload reopens the session, which runs the open hook again.
    reload: async () => {
      agent.reloads += 1;
      if (agent.failNextReload) {
        agent.failNextReload = false;
        throw new Error("reload failed");
      }
      await open("refresh");
    },
    timeline: { append: async (item: unknown) => void appended.push(item) },
  };
  const paseo = { agents: { ref: () => agent } };

  return {
    agent,
    appended,
    remove,
    open: () => open("create"),
    turnEnded: () => handlers["agent.turn.after"]!({ agent: { id: "a" } }, { paseo, signal }),
  };
}

describe("agent-env plugin", () => {
  let dir: string;
  const file = (name: string) => join(dir, name);
  const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), "utf8") : "");
  const configure = (config: unknown) => {
    mkdirSync(dirname(file(CONFIG_PATH)), { recursive: true });
    writeFileSync(file(CONFIG_PATH), JSON.stringify(config));
  };
  // Counts its runs, so a test can tell whether the layers ran.
  const PORT_LAYER = `echo run >> runs; printf 'PORT=%s\\0' "$(cat port)"`;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-env-plugin-")));
    writeFileSync(file("port"), "1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("injects the layers at launch", async () => {
    configure({ layers: [PORT_LAYER] });
    const result = (await setup(dir).open()) as { env: Record<string, string> };
    expect(result.env).toEqual({ PORT: "1" });
  });

  it("reloads an idle agent whose environment changed", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    await plugin.turnEnded();
    expect(plugin.agent.reloads).toBe(1);
    expect(plugin.appended).toMatchObject([{ kind: "env-reloaded", data: { names: ["PORT"] } }]);

    // The reload recorded the new environment, so the next turn end has nothing to do.
    await plugin.turnEnded();
    expect(plugin.agent.reloads).toBe(1);
  });

  it("does not reload a busy agent", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    plugin.agent.status = "running";
    await plugin.turnEnded();
    expect(plugin.agent.reloads).toBe(0);
  });

  it("runs nothing at a turn end with reloadOnChange off", async () => {
    configure({ layers: [PORT_LAYER], reloadOnChange: false });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    await plugin.turnEnded();
    expect(read("runs")).toBe("run\n");
    expect(plugin.agent.reloads).toBe(0);
  });

  it("reloads without the variables when the layers are removed", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    rmSync(file(CONFIG_PATH));
    await plugin.turnEnded();
    expect(plugin.agent.reloads).toBe(1);
    expect(plugin.appended).toMatchObject([{ data: { names: ["PORT"] } }]);
  });

  it("retries a failed reload at the next turn end", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    plugin.agent.failNextReload = true;
    await plugin.turnEnded();
    expect(plugin.appended).toEqual([]);

    // Not taken for a volatile variable: the same change still reloads.
    await plugin.turnEnded();
    expect(plugin.agent.reloads).toBe(2);
    expect(plugin.appended).toMatchObject([{ data: { names: ["PORT"] } }]);
  });
});
