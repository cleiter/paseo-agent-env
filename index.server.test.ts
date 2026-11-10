import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contribute from "./index.server";
import { CONFIG_PATH } from "./server/config";

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

/** The plugin wired to a fake server, with a fake Paseo CLI that records reload calls. */
function setup(dir: string) {
  const handlers: Record<string, Handler> = {};
  const server = {
    before: (name: string, handler: Handler) => ((handlers[name] = handler), () => {}),
    on: (name: string, handler: Handler) => ((handlers[name] = handler), () => {}),
  };
  const remove = contribute(server as unknown as Parameters<typeof contribute>[0]);

  const appended: unknown[] = [];
  const agent = {
    status: "idle",
    refresh: async () => {},
    timeline: { append: async (item: unknown) => void appended.push(item) },
  };
  const paseo = { agents: { ref: () => agent } };
  const signal = new AbortController().signal;

  return {
    agent,
    appended,
    remove,
    open: () =>
      handlers["agent.session_open"]!(
        { request: { agentId: "a", cwd: dir, env: {}, purpose: "launch", reason: "create" } },
        { signal },
      ),
    turnEnded: () => handlers["agent.turn_ended"]!({ agent: { id: "a" } }, { paseo, signal }),
  };
}

describe("agent-env plugin", () => {
  let dir: string;
  let previousCli: string | undefined;
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
    // Fails once when a `fail` file exists, like a CLI that is briefly unreachable.
    writeFileSync(
      file("paseo"),
      `#!/bin/sh\necho "$@" >> "${dir}/calls"\nif [ -e "${dir}/fail" ]; then rm "${dir}/fail"; exit 1; fi\n`,
    );
    chmodSync(file("paseo"), 0o755);
    previousCli = process.env.PASEO_CLI;
    process.env.PASEO_CLI = file("paseo");
    writeFileSync(file("port"), "1");
  });
  afterEach(() => {
    if (previousCli === undefined) delete process.env.PASEO_CLI;
    else process.env.PASEO_CLI = previousCli;
    rmSync(dir, { recursive: true, force: true });
  });

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
    expect(read("calls")).toBe("agent reload a\n");
    expect(plugin.appended).toMatchObject([{ kind: "env-reloaded", data: { names: ["PORT"] } }]);
  });

  it("does not reload a busy agent", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    plugin.agent.status = "running";
    await plugin.turnEnded();
    expect(read("calls")).toBe("");
  });

  it("runs nothing at a turn end with reloadOnChange off", async () => {
    configure({ layers: [PORT_LAYER], reloadOnChange: false });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    await plugin.turnEnded();
    expect(read("runs")).toBe("run\n");
    expect(read("calls")).toBe("");
  });

  it("reloads without the variables when the layers are removed", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    rmSync(file(CONFIG_PATH));
    await plugin.turnEnded();
    expect(read("calls")).toBe("agent reload a\n");
    expect(plugin.appended).toMatchObject([{ data: { names: ["PORT"] } }]);
  });

  it("retries a failed reload at the next turn end", async () => {
    configure({ layers: [PORT_LAYER] });
    const plugin = setup(dir);
    await plugin.open();
    writeFileSync(file("port"), "2");
    writeFileSync(file("fail"), "");
    await plugin.turnEnded();
    expect(plugin.appended).toEqual([]);

    // Not taken for a volatile variable: the same change still reloads.
    await plugin.turnEnded();
    expect(read("calls")).toBe("agent reload a\nagent reload a\n");
    expect(plugin.appended).toMatchObject([{ data: { names: ["PORT"] } }]);
  });
});
