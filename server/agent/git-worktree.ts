import { execFileSync, spawn } from "child_process";
import { copyFileSync, openSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, appendFileSync } from "fs";
import { mergedPullRequest } from "./git-merge.js";
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
  /** Branch checked out in the project folder at creation (null when HEAD was detached). */
  base: string | null;
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

/**
 * Add a pattern to the repo's local exclude file (`<git-common-dir>/info/exclude`): shared by all its
 * worktrees, never committed, so it hides files from `git status` and from the `git add -A` of snapshots
 * without touching the project's own .gitignore. Idempotent. Throws when `repoPath` is not a git repo.
 *
 * Used for a symlinked node_modules (not matched by a `node_modules/` ignore pattern, since git does not
 * see a directory) and for the .codegraph/ folder CodeGraph creates in a project.
 */
export function addLocalExclude(repoPath: string, pattern: string) {
  const commonDir = git(repoPath, ["rev-parse", "--git-common-dir"]);
  const infoDir = join(isAbsolute(commonDir) ? commonDir : resolve(repoPath, commonDir), "info");
  const file = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

/** Install command for a React Native project (its tooling follows real paths, so a symlinked node_modules breaks it). */
function reactNativeInstall(repoPath: string): { cmd: string; args: string[] } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf-8"));
    if (!pkg.dependencies?.["react-native"] && !pkg.devDependencies?.["react-native"]) return null;
  } catch {
    return null;
  }
  if (existsSync(join(repoPath, "yarn.lock"))) return { cmd: "yarn", args: ["install"] };
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["install"] };
  if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) return { cmd: "bun", args: ["install"] };
  if (existsSync(join(repoPath, "package-lock.json"))) return { cmd: "npm", args: ["ci"] };
  return null;
}

const shq = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Submodule folders declared by the worktree's .gitmodules. */
function submodulePaths(dir: string): string[] {
  if (!existsSync(join(dir, ".gitmodules"))) return [];
  try {
    return git(dir, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])
      .split("\n")
      .map((l) => l.split(/\s+/).slice(1).join(" "))
      .filter((p) => p && !p.startsWith("/") && !p.includes(".."));
  } catch {
    return [];
  }
}

function prepareWorktree(repoPath: string, dir: string) {
  addLocalExclude(repoPath, "/node_modules");

  const install = reactNativeInstall(repoPath);
  const submodules = submodulePaths(dir);
  const steps: string[] = [];

  // `git worktree add` leaves submodules as empty folders. Populate them, borrowing the objects of the main
  // project's copy so that nothing (or almost nothing) is downloaded.
  for (const sub of submodules) {
    steps.push(`git submodule update --init --recursive --reference ${shq(join(repoPath, sub))} -- ${shq(sub)}`);
  }

  if (install) {
    // React Native (Metro, Gradle autolinking) resolves real paths: a symlink to the main project's
    // node_modules makes it mix both folders. Install for real, in the background (can take minutes).
    steps.push([install.cmd, ...install.args].join(" "));
    // A submodule that has its own node_modules in the main project needs its own install too.
    for (const sub of submodules) {
      if (existsSync(join(repoPath, sub, "node_modules")) && existsSync(join(repoPath, sub, "package.json"))) {
        steps.push(`(cd ${shq(sub)} && ${[install.cmd, ...install.args].join(" ")})`);
      }
    }
  } else {
    const modules = join(repoPath, "node_modules");
    const link = join(dir, "node_modules");
    if (existsSync(modules) && !existsSync(link)) symlinkSync(modules, link, "dir");
  }

  if (steps.length > 0 && process.platform !== "win32") {
    // One background shell, output next to the worktree so a failure can be read.
    try {
      const log = openSync(`${dir}.install.log`, "w");
      const child = spawn("sh", ["-c", steps.join("\n")], { cwd: dir, stdio: ["ignore", log, log], detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      child.on("error", () => {});
      child.unref();
    } catch {}
  }

  // Git-ignored local files a native Android build needs (SDK path).
  const localProps = join("android", "local.properties");
  if (existsSync(join(repoPath, localProps)) && existsSync(join(dir, "android")) && !existsSync(join(dir, localProps)) && isIgnored(repoPath, localProps)) {
    copyFileSync(join(repoPath, localProps), join(dir, localProps));
  }

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
  name: string,
  /** `branch`: use exactly this git branch name (a ticket branch like `6929-fix-x`), no `overlord/` prefix. */
  options?: { branch?: string }
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

  const base = git(repoPath, ["branch", "--show-current"]) || null;
  const exact = options?.branch?.trim();
  if (exact) {
    try {
      git(repoPath, ["check-ref-format", "--branch", exact]);
    } catch {
      return { ok: false, error: `« ${exact} » n'est pas un nom de branche valide.` };
    }
    try {
      git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${exact}`]);
      return { ok: false, error: `La branche « ${exact} » existe déjà.` };
    } catch {}
  }
  const slug = exact ? exact.replace(/\//g, "-") : worktreeSlug(name, conversationId);
  const branch = exact ?? `overlord/${slug}`;
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
  return { ok: true, worktree: { path: dir, branch, base } };
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
  // A squash/rebase merged pull request leaves the branch's commits "unmerged" for git, yet nothing is lost.
  let merged = false;
  if (existsSync(path)) {
    const status = worktreeStatus(path, branch);
    if (!force && status && status.changed === 0 && status.ahead > 0 && mergedPullRequest(repoPath, branch)) merged = true;
    if (!force && !merged && (!status || status.changed > 0 || status.ahead > 0)) {
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
    git(repoPath, ["branch", force || merged ? "-D" : "-d", branch]);
  } catch (err) {
    // The folder is gone; a branch that cannot be deleted safely is kept, not an error.
    return { ok: true, error: `Worktree supprimé, branche ${branch} conservée : ${errorText(err)}` };
  }
  return { ok: true };
}
