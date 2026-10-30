import { execFileSync } from "child_process";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export interface BranchInfo {
  /** Current branch, or the short SHA when HEAD is detached. null when not a git repo. */
  branch: string | null;
  detached: boolean;
}

export function currentBranch(cwd: string): BranchInfo {
  try {
    const name = git(cwd, ["branch", "--show-current"]);
    if (name) return { branch: name, detached: false };
    return { branch: git(cwd, ["rev-parse", "--short", "HEAD"]), detached: true };
  } catch {
    return { branch: null, detached: false };
  }
}

export function listBranches(cwd: string): string[] {
  try {
    // Most recently committed first, so a truncated list still shows the branches in use.
    return git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export interface BranchResult {
  ok: boolean;
  error?: string;
  action?: "created" | "switched" | "deleted";
}

function fail(err: unknown): BranchResult {
  const stderr = (err as { stderr?: string }).stderr;
  return { ok: false, error: (stderr || String(err)).trim() };
}

// Also rejects names starting with "-" and anything git would not accept as a branch.
function isValidName(cwd: string, name: string): boolean {
  try {
    git(cwd, ["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

/** Switch to an existing branch. git refuses if it would overwrite local changes. */
export function switchBranch(cwd: string, name: string): BranchResult {
  if (!isValidName(cwd, name)) return { ok: false, error: `« ${name} » n'est pas un nom de branche valide.` };
  if (!listBranches(cwd).includes(name)) {
    return { ok: false, error: `La branche « ${name} » n'existe pas. Pour la créer : /branch -c ${name}` };
  }
  try {
    git(cwd, ["switch", name]);
    return { ok: true, action: "switched" };
  } catch (err) {
    return fail(err);
  }
}

/** Create a branch from the current HEAD and switch to it, keeping the working tree as is. */
export function createBranch(cwd: string, name: string): BranchResult {
  if (!isValidName(cwd, name)) return { ok: false, error: `« ${name} » n'est pas un nom de branche valide.` };
  try {
    git(cwd, ["switch", "-c", name]);
    return { ok: true, action: "created" };
  } catch (err) {
    return fail(err);
  }
}

/** Safe delete (`git branch -d`): git refuses unmerged branches and the current one. */
export function deleteBranch(cwd: string, name: string): BranchResult {
  if (!isValidName(cwd, name)) return { ok: false, error: `« ${name} » n'est pas un nom de branche valide.` };
  try {
    git(cwd, ["branch", "-d", name]);
    return { ok: true, action: "deleted" };
  } catch (err) {
    return fail(err);
  }
}
