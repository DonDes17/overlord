import { execFileSync } from "child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, appendFileSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve } from "path";

// Worktrees live next to Overlord's database, never inside a repo: inside, they would show
// up as untracked and end up in the `git add -A` of that repo's snapshots.
const WORKTREES_ROOT = join(homedir(), ".overlord", "worktrees");

function git(cwd: string, args: string[], timeout = 10000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function errorText(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  return (stderr || String(err)).trim();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface WorktreeStatus {
  /** Modified, added or untracked files. */
  changed: number;
  /** Commits that exist only on the worktree's branch (not merged anywhere else). */
  ahead: number;
}

export function worktreeSlug(name: string, conversationId: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${base || "branch"}-${conversationId}`;
}

// A symlinked node_modules is not matched by a `node_modules/` ignore pattern (git does not see
// a directory), so it would be added to every snapshot. `info/exclude` is local and shared by
// all worktrees of the repo.
function excludeNodeModules(repoPath: string) {
  const commonDir = git(repoPath, ["rev-parse", "--git-common-dir"]);
  const infoDir = join(isAbsolute(commonDir) ? commonDir : resolve(repoPath, commonDir), "info");
  const file = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (current.split("\n").some((l) => l.trim() === "/node_modules")) return;
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/node_modules\n`);
}

function prepareWorktree(repoPath: string, dir: string) {
  excludeNodeModules(repoPath);

  const modules = join(repoPath, "node_modules");
  const link = join(dir, "node_modules");
  if (existsSync(modules) && !existsSync(link)) symlinkSync(modules, link, "dir");

  // Only git-ignored env files are copied: tracked ones are already checked out, and a copied
  // file that is not ignored would show up as an untracked change in every snapshot.
  for (const entry of readdirSync(repoPath)) {
    if (!/^\.env/.test(entry)) continue;
    const from = join(repoPath, entry);
    const to = join(dir, entry);
    if (!statSync(from).isFile() || existsSync(to) || !isIgnored(repoPath, entry)) continue;
    copyFileSync(from, to);
  }
}

function isIgnored(repoPath: string, file: string): boolean {
  try {
    git(repoPath, ["check-ignore", "-q", file]);
    return true;
  } catch {
    return false;
  }
}

/**
 * New worktree on a new branch `overlord/<slug>`, created from the current HEAD of the repo.
 * The caller stores the returned path and branch on the conversation.
 */
export function createWorktree(
  repoPath: string,
  projectId: number,
  conversationId: number,
  name: string
): { ok: true; worktree: WorktreeInfo } | { ok: false; error: string } {
  try {
    git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { ok: false, error: "Ce projet n'est pas un dépôt git." };
  }
  try {
    git(repoPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return { ok: false, error: "Ce dépôt n'a encore aucun commit." };
  }

  const slug = worktreeSlug(name, conversationId);
  const branch = `overlord/${slug}`;
  const dir = join(WORKTREES_ROOT, `${basename(repoPath)}-${projectId}`, slug);
  if (existsSync(dir)) return { ok: false, error: `Le dossier ${dir} existe déjà.` };

  try {
    git(repoPath, ["worktree", "prune"]);
    mkdirSync(join(dir, ".."), { recursive: true });
    git(repoPath, ["worktree", "add", "-b", branch, dir, "HEAD"], 60000);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  try {
    prepareWorktree(repoPath, dir);
  } catch (err) {
    // Don't leave a half-prepared worktree behind.
    try {
      git(repoPath, ["worktree", "remove", "--force", dir]);
      git(repoPath, ["branch", "-D", branch]);
    } catch {}
    return { ok: false, error: errorText(err) };
  }
  return { ok: true, worktree: { path: dir, branch } };
}

export function worktreeStatus(path: string, branch: string): WorktreeStatus | null {
  if (!existsSync(path)) return null;
  try {
    const changed = git(path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    // `--exclude` must come before the glob it applies to, and is relative to refs/heads/.
    const ahead = Number(git(path, ["rev-list", "--count", branch, "--not", `--exclude=${branch}`, "--branches"])) || 0;
    return { changed, ahead };
  } catch {
    return null;
  }
}

/**
 * Remove the worktree folder and its branch. Refuses when work would be lost (uncommitted changes
 * or commits not merged anywhere else) unless `force` is set.
 */
export function removeWorktree(
  repoPath: string,
  path: string,
  branch: string,
  force = false
): { ok: boolean; error?: string; status?: WorktreeStatus } {
  if (existsSync(path)) {
    const status = worktreeStatus(path, branch);
    if (!force && (!status || status.changed > 0 || status.ahead > 0)) {
      return {
        ok: false,
        status: status ?? undefined,
        error: status
          ? `Le worktree contient du travail non sauvegardé (${status.changed} fichier(s) modifié(s), ${status.ahead} commit(s) non fusionné(s)).`
          : "Impossible de lire l'état du worktree.",
      };
    }
    try {
      // Unlink our node_modules symlink first; rmSync never follows it.
      const link = join(path, "node_modules");
      if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmSync(link);
      git(repoPath, ["worktree", "remove", "--force", path], 30000);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  } else {
    try {
      git(repoPath, ["worktree", "prune"]);
    } catch {}
  }

  try {
    git(repoPath, ["branch", force ? "-D" : "-d", branch]);
  } catch (err) {
    // The folder is gone; a branch that cannot be deleted safely is kept, not an error.
    return { ok: true, error: `Worktree supprimé, branche ${branch} conservée : ${errorText(err)}` };
  }
  return { ok: true };
}
