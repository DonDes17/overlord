import { execFileSync, execSync } from "child_process";
import { readdirSync, rmdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { withTempIndex } from "./git-index.js";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function createGitSnapshot(cwd: string): string | null {
  try {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore", timeout: 2000 });
    } catch {
      return null; // not a git repo, skip snapshot silently
    }

    let hasCommits = true;
    try {
      execSync("git rev-parse HEAD", { cwd, stdio: "ignore", timeout: 2000 });
    } catch {
      hasCommits = false;
    }
    if (!hasCommits) return null;

    // Work on a throwaway copy of the index so whatever the user has staged stays staged.
    const sha = withTempIndex(cwd, (env) => {
      execSync("git add -A", { cwd, stdio: "ignore", env: { ...process.env, ...env } });
      return execSync("git stash create", {
        cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env },
      }).trim();
    });

    if (!sha) {
      return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    }
    return sha;
  } catch (err) {
    console.log(`[git] snapshot failed:`, err);
    return null;
  }
}

export function getCommitsSince(cwd: string, sha: string): number {
  if (!SHA_RE.test(sha)) return -1;
  try {
    const count = execFileSync("git", ["rev-list", "--count", `${sha}..HEAD`], { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    return parseInt(count, 10) || 0;
  } catch {
    return -1;
  }
}

function listZ(cwd: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 10000 })
    .split("\0")
    .filter(Boolean);
}

// Same exclusions the old `git clean` had: never delete dependencies or the local env file.
function isProtected(path: string): boolean {
  const parts = path.split("/");
  return parts.includes("node_modules") || parts[parts.length - 1] === ".env";
}

function removeFileAndEmptyDirs(cwd: string, path: string) {
  try {
    unlinkSync(join(cwd, path));
  } catch {
    return;
  }
  // `git clean -d` used to take the emptied directories with it.
  for (let dir = dirname(path); dir && dir !== "." && dir !== "/"; dir = dirname(dir)) {
    try {
      if (readdirSync(join(cwd, dir)).length > 0) break;
      rmdirSync(join(cwd, dir));
    } catch {
      break;
    }
  }
}

/**
 * Put the working tree back as it was when the snapshot was taken, leaving the user's staging
 * area alone: files are restored through a throwaway index, files created since are deleted, and
 * only the real index entries of files that no longer exist are dropped.
 */
export function rollbackToSnapshot(cwd: string, sha: string): { ok: boolean; error?: string } {
  if (!SHA_RE.test(sha)) return { ok: false, error: "SHA de snapshot invalide." };
  try {
    const commitsSince = getCommitsSince(cwd, sha);
    if (commitsSince > 0) {
      return { ok: false, error: `${commitsSince} commit(s) depuis ce snapshot. Rollback non securise.` };
    }

    // Restore first: if it fails, nothing has been deleted.
    withTempIndex(cwd, (env) => {
      execFileSync("git", ["checkout", sha, "--", "."], {
        cwd, env: { ...process.env, ...env }, stdio: "ignore", timeout: 10000,
      });
    });

    // Created since the snapshot: tracked-or-staged files and untracked ones (ignored files stay).
    const inSnapshot = new Set(listZ(cwd, ["ls-tree", "-r", "-z", "--name-only", sha]));
    const created = listZ(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .filter((p) => !inSnapshot.has(p) && !isProtected(p));
    for (const path of created) removeFileAndEmptyDirs(cwd, path);

    // A file staged as new and now deleted must leave the index. A file that exists in HEAD keeps
    // its entry: it was an unstaged deletion before, and removing the entry would stage it.
    const inHead = new Set(listZ(cwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]));
    const staleEntries = created.filter((p) => !inHead.has(p));
    if (staleEntries.length > 0) {
      execFileSync("git", ["update-index", "--force-remove", "-z", "--stdin"], {
        cwd, input: staleEntries.join("\0") + "\0", stdio: ["pipe", "ignore", "ignore"], timeout: 10000,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
