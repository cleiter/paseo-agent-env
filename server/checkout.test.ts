import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCheckout } from "./checkout";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("resolveCheckout", () => {
  // realpath: on macOS tmpdir sits behind the /var -> /private/var symlink and git reports
  // the resolved path.
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-env-checkout-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses the cwd outside git", async () => {
    expect(await resolveCheckout(root)).toEqual({
      worktreePath: root,
      sourceCheckoutPath: root,
      branchName: null,
    });
  });

  it("finds the source checkout from a linked worktree subdirectory", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "x");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const worktree = join(root, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    mkdirSync(join(worktree, "sub"));

    expect(await resolveCheckout(join(worktree, "sub"))).toEqual({
      worktreePath: worktree,
      sourceCheckoutPath: repo,
      branchName: "feature",
    });
    expect(await resolveCheckout(repo)).toEqual({
      worktreePath: repo,
      sourceCheckoutPath: repo,
      branchName: "main",
    });
  });
});
