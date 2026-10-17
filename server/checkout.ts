import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CheckoutPaths {
  /** Where the agent's config lives: the git toplevel of the agent's cwd. */
  worktreePath: string;
  /** The main checkout the worktree was created from; equal to worktreePath outside worktrees. */
  sourceCheckoutPath: string;
  branchName: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the checkout around an agent's cwd. Outside git, every path is the cwd itself.
 *
 * The source checkout matters because direnv approval is per path and gitignored secrets
 * (`.envrc.local`, `.env`) exist only there: a fresh worktree has neither.
 */
export async function resolveCheckout(cwd: string): Promise<CheckoutPaths> {
  const toplevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) {
    return { worktreePath: cwd, sourceCheckoutPath: cwd, branchName: null };
  }

  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sourceCheckoutPath =
    commonDir && basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;

  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    worktreePath: toplevel,
    sourceCheckoutPath,
    branchName: branch && branch !== "HEAD" ? branch : null,
  };
}
