import { execFileSync } from "child_process";
import { currentBranch } from "./git-branch.js";

function run(cmd: string, cwd: string, args: string[], timeout = 15000): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout,
    // Never wait for credentials on a terminal nobody is looking at.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const git = (cwd: string, args: string[], timeout?: number) => run("git", cwd, args, timeout);

function errorText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string };
  return (e.stderr || e.stdout || String(err)).toString().trim();
}

/** `owner/repo` of a GitHub remote URL (ssh or https), null for anything else. */
export function parseGithubRepo(remoteUrl: string): string | null {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface WorktreeGitState {
  /** Uncommitted changes (including the resolved-but-not-committed files of a merge). */
  dirty: boolean;
  /** Files still in conflict. */
  conflicts: string[];
}

export function worktreeGitState(worktreePath: string): WorktreeGitState {
  const dirty = git(worktreePath, ["status", "--porcelain"]).length > 0;
  const conflicts = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  return { dirty, conflicts };
}

export type UpdateResult =
  | { ok: true; upToDate: boolean }
  | { ok: false; conflicts: string[]; error?: string };

/**
 * Merge the base into the worktree branch, in the worktree: conflicts, if any, are left there
 * for the agent to resolve, so the base branch itself never receives a conflicted merge.
 */
export function updateFromBase(worktreePath: string, base: string): UpdateResult {
  try {
    const out = git(worktreePath, ["merge", "--no-edit", base], 30000);
    return { ok: true, upToDate: /already up to date/i.test(out) };
  } catch (err) {
    const conflicts = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    if (conflicts.length > 0) return { ok: false, conflicts };
    // Not a content conflict (e.g. untracked files in the way): nothing useful is left half-done.
    try { git(worktreePath, ["merge", "--abort"]); } catch {}
    return { ok: false, conflicts: [], error: errorText(err) };
  }
}

/** Fast-forward the base branch, checked out in the project folder, to the worktree branch. */
export function fastForwardBase(repoPath: string, base: string, branch: string): { ok: boolean; error?: string } {
  const current = currentBranch(repoPath);
  if (current.branch !== base || current.detached) {
    return {
      ok: false,
      error: `Le dossier principal est sur « ${current.branch ?? "?"} », pas sur « ${base} ». Faites \`git switch ${base}\` dans le projet, puis relancez /merge.`,
    };
  }
  try {
    git(repoPath, ["merge", "--ff-only", branch], 30000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Remote ref to update from for a PR: the remote's own copy of the base when it exists (that is
 * what the PR is compared with), else the local base.
 */
export function prBaseRef(worktreePath: string, base: string): string {
  try {
    git(worktreePath, ["fetch", "origin", base], 30000);
    git(worktreePath, ["rev-parse", "--verify", "--quiet", `origin/${base}`]);
    return `origin/${base}`;
  } catch {
    return base;
  }
}

export type PrResult = { ok: true; url: string; existing: boolean } | { ok: false; error: string };

/**
 * Push the branch to the project's own `origin` and open a PR there. The target repo comes from
 * that remote and is always passed to gh explicitly: gh must never guess it (on a fork it picks
 * the upstream repo), and every Overlord project has its own remote.
 */
export function createPullRequest(repoPath: string, worktreePath: string, branch: string, base: string): PrResult {
  let remote: string;
  try {
    remote = git(repoPath, ["remote", "get-url", "origin"]);
  } catch {
    return { ok: false, error: "Ce projet n'a pas de remote `origin` : rien à pousser." };
  }
  const repo = parseGithubRepo(remote);
  if (!repo) return { ok: false, error: `Les PR automatiques ne gèrent que GitHub (origin : ${remote}).` };

  try {
    git(worktreePath, ["push", "-u", "origin", branch], 60000);
  } catch (err) {
    return { ok: false, error: `Échec du push vers ${repo} :\n${errorText(err)}` };
  }

  try {
    const out = run("gh", worktreePath, ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--fill"], 60000);
    const url = out.split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()));
    return url ? { ok: true, url: url.trim(), existing: false } : { ok: false, error: `PR créée mais URL introuvable :\n${out}` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "`gh` est introuvable. Installez la CLI GitHub et connectez-vous (`gh auth login`). La branche est poussée." };
    }
    const text = errorText(err);
    if (/already exists/i.test(text)) {
      try {
        const url = run("gh", worktreePath, ["pr", "view", branch, "--repo", repo, "--json", "url", "-q", ".url"]);
        return { ok: true, url, existing: true };
      } catch {}
    }
    return { ok: false, error: `Branche poussée sur ${repo}, mais la PR n'a pas pu être créée :\n${text}` };
  }
}
