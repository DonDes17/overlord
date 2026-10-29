import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";

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
    const dir = mkdtempSync(join(tmpdir(), "overlord-idx-"));
    const tmpIndex = join(dir, "index");
    let sha: string;
    try {
      let realIndex = execSync("git rev-parse --git-path index", { cwd, encoding: "utf-8", timeout: 2000 }).trim();
      if (!isAbsolute(realIndex)) realIndex = join(cwd, realIndex);
      if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      execSync("git add -A", { cwd, stdio: "ignore", env });
      sha = execSync("git stash create", {
        cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env,
      }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

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
  try {
    const count = execSync(`git rev-list --count ${sha}..HEAD`, { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    return parseInt(count, 10) || 0;
  } catch {
    return -1;
  }
}

export function rollbackToSnapshot(cwd: string, sha: string): { ok: boolean; error?: string } {
  try {
    const commitsSince = getCommitsSince(cwd, sha);
    if (commitsSince > 0) {
      return { ok: false, error: `${commitsSince} commit(s) depuis ce snapshot. Rollback non securise.` };
    }
    execSync(`git checkout ${sha} -- .`, { cwd, stdio: "ignore", timeout: 10000 });
    execSync("git clean -fd --exclude=node_modules --exclude=.env", { cwd, stdio: "ignore", timeout: 10000 });
    execSync("git reset", { cwd, stdio: "ignore" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
