import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH, parseConfig, readAgentEnvConfig } from "./config";

describe("parseConfig", () => {
  it("reads commands and static maps in order", () => {
    expect(parseConfig({ layers: [{ A: "1" }, "mise env --json"] }, "p").layers).toEqual([
      { kind: "static", vars: { A: "1" } },
      { kind: "command", command: "mise env --json" },
    ]);
    expect(parseConfig({ layers: [] }, "p").layers).toEqual([]);
  });

  it("reloads on change unless turned off", () => {
    expect(parseConfig({ layers: [] }, "p").reloadOnChange).toBe(true);
    expect(parseConfig({ layers: [], reloadOnChange: false }, "p").reloadOnChange).toBe(false);
    expect(() => parseConfig({ layers: [], reloadOnChange: "no" }, "p")).toThrow(
      "`reloadOnChange` must be true or false",
    );
  });

  it("reads worktreeCreate commands", () => {
    expect(parseConfig({ layers: [] }, "p").worktreeCreate).toEqual([]);
    expect(parseConfig({ layers: [], worktreeCreate: [" bin/prepare "] }, "p").worktreeCreate).toEqual([
      "bin/prepare",
    ]);
    expect(() => parseConfig({ layers: [], worktreeCreate: "bin/prepare" }, "p")).toThrow(
      "`worktreeCreate` must be an array of commands",
    );
    expect(() => parseConfig({ layers: [], worktreeCreate: ["ok", ""] }, "p")).toThrow(
      "worktreeCreate[1] must be a non-empty command",
    );
  });

  it("fails on a malformed layer instead of dropping it", () => {
    expect(() => parseConfig({ layers: [{ A: 1 }] }, "p")).toThrow('layers[0]: "A" must be a string');
    expect(() => parseConfig({ layers: ["ok", 42] }, "p")).toThrow("layers[1] must be");
    expect(() => parseConfig({ layers: ["  "] }, "p")).toThrow("empty command");
    expect(() => parseConfig({ layers: [{ "A=B": "x" }] }, "p")).toThrow("invalid name");
  });

  it("warns about an unknown key instead of failing", () => {
    const warnings: string[] = [];
    const config = parseConfig({ layers: ["echo A=1"], newerKey: true }, "p", (m) => warnings.push(m));
    expect(config.layers).toEqual([{ kind: "command", command: "echo A=1" }]);
    expect(warnings).toEqual([
      'p: ignoring unknown key "newerKey" (a typo, or a key from a newer plugin version)',
    ]);
  });

  it("fails on a wrong shape or a misspelled layers key", () => {
    expect(() => parseConfig(["echo A=1"], "p")).toThrow("expected an object");
    expect(() => parseConfig({ layers: "echo A=1" }, "p")).toThrow("`layers` must be an array");
    // A misspelled `layers` leaves `layers` missing, which still fails.
    expect(() => parseConfig({ layer: [] }, "p")).toThrow("`layers` must be an array");
  });
});

describe("readAgentEnvConfig", () => {
  let dir: string;
  const write = (text: string) => {
    const file = join(dir, CONFIG_PATH);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-env-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is empty without a config file", async () => {
    expect(await readAgentEnvConfig(dir)).toEqual({
      layers: [],
      reloadOnChange: true,
      worktreeCreate: [],
    });
  });

  it("reads .paseo/plugins/paseo-agent-env/config.json", async () => {
    write(JSON.stringify({ layers: ["echo A=1"] }));
    expect((await readAgentEnvConfig(dir)).layers).toEqual([
      { kind: "command", command: "echo A=1" },
    ]);
  });

  it("ignores paseo.json", async () => {
    writeFileSync(join(dir, "paseo.json"), JSON.stringify({ agentEnv: ["echo A=1"] }));
    expect((await readAgentEnvConfig(dir)).layers).toEqual([]);
  });

  it("fails on invalid JSON with the file path", async () => {
    write("{ nope");
    await expect(readAgentEnvConfig(dir)).rejects.toThrow(
      `${join(dir, CONFIG_PATH)}: not valid JSON`,
    );
  });
});
