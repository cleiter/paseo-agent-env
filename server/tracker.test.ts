import { describe, expect, it } from "vitest";
import { AgentEnvTracker, changedNames } from "./tracker";

const launch = (injected: Record<string, string>) => ({ cwd: "/w", requestEnv: {}, injected });

describe("changedNames", () => {
  it("lists added, removed, and changed names", () => {
    expect(changedNames({ A: "1", B: "2", C: "3" }, { A: "1", B: "x", D: "4" })).toEqual([
      "B",
      "C",
      "D",
    ]);
  });
});

describe("AgentEnvTracker", () => {
  it("asks for a reload when the environment changed since launch", () => {
    const tracker = new AgentEnvTracker();
    tracker.record("a", launch({ PATH: "/bin" }));
    expect(tracker.reloadReasons("a", { PATH: "/bin" })).toEqual([]);
    expect(tracker.reloadReasons("a", { PATH: "/bin", PORT: "3354" })).toEqual(["PORT"]);
  });

  it("ignores tool bookkeeping", () => {
    const tracker = new AgentEnvTracker();
    tracker.record("a", launch({ DIRENV_WATCHES: "1" }));
    expect(tracker.reloadReasons("a", { DIRENV_WATCHES: "2" })).toEqual([]);
    expect(tracker.reloadReasons("a", { DIRENV_WATCHES: "2", LATE: "yes" })).toEqual(["LATE"]);
  });

  it("knows nothing about agents it never saw launch", () => {
    expect(new AgentEnvTracker().reloadReasons("a", { A: "1" })).toEqual([]);
  });

  it("settles after a reload that fixed the change", () => {
    const tracker = new AgentEnvTracker();
    tracker.record("a", launch({}));
    expect(tracker.reloadReasons("a", { PORT: "1" })).toEqual(["PORT"]);
    tracker.markReloaded("a", ["PORT"]);
    tracker.record("a", launch({ PORT: "1" }));
    expect(tracker.reloadReasons("a", { PORT: "1" })).toEqual([]);
  });

  it("stops reloading for a value that changes on every run", () => {
    const tracker = new AgentEnvTracker();
    tracker.record("a", launch({ STAMP: "1" }));
    expect(tracker.reloadReasons("a", { STAMP: "2" })).toEqual(["STAMP"]);
    tracker.markReloaded("a", ["STAMP"]);
    tracker.record("a", launch({ STAMP: "3" }));
    expect(tracker.reloadReasons("a", { STAMP: "4" })).toEqual([]);
    // A real change still counts.
    expect(tracker.reloadReasons("a", { STAMP: "5", PORT: "1" })).toEqual(["PORT"]);
  });
});
