import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";

/**
 * Run `fn` with GIT_INDEX_FILE pointing at a throwaway copy of the repo's index, so git commands
 * that write the index (`add -A`, `checkout <sha> -- .`) never touch what the user has staged.
 */
export function withTempIndex<T>(cwd: string, fn: (env: Record<string, string>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "overlord-idx-"));
  const tmpIndex = join(dir, "index");
  try {
    let realIndex = execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd, encoding: "utf-8", timeout: 2000 }).trim();
    if (!isAbsolute(realIndex)) realIndex = join(cwd, realIndex);
    // Copying the real index keeps stat info, so `git add -A` only rehashes changed files.
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    return fn({ GIT_INDEX_FILE: tmpIndex });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
