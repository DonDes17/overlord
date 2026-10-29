import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";

// Lockfiles are listed in the stats but left out of the rendered patch:
// they are huge and almost never what you want to review.
const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Podfile.lock"];
const MAX_PATCH_BYTES = 3 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  lockfile: boolean;
}

export interface TurnDiff {
  files: DiffFileStat[];
  patch: string;
  truncated: boolean;
  toWorkingTree: boolean;
}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20000,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === "string" && SHA_RE.test(sha);
}

/**
 * Tree object for the current working directory, untracked files included
 * (.gitignore respected). Works on a throwaway copy of the index so the
 * user's staging area is never touched.
 */
function workingTreeSha(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "overlord-idx-"));
  const tmpIndex = join(dir, "index");
  try {
    let realIndex = git(cwd, ["rev-parse", "--git-path", "index"]).trim();
    if (!isAbsolute(realIndex)) realIndex = join(cwd, realIndex);
    // Copying the real index keeps stat info, so `git add -A` only rehashes changed files.
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(cwd, ["add", "-A"], env);
    return git(cwd, ["write-tree"], env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isLockfile(path: string): boolean {
  return LOCKFILES.some((name) => path === name || path.endsWith(`/${name}`));
}

/**
 * Diff between the snapshot taken before a turn and either the snapshot of the
 * next turn or, for the latest turn, the current working directory.
 */
export function turnDiff(cwd: string, fromSha: string, toSha?: string): TurnDiff {
  const toWorkingTree = !toSha;
  const target = toSha ?? workingTreeSha(cwd);

  const files: DiffFileStat[] = git(cwd, ["diff", "--numstat", "-M", "--no-ext-diff", fromSha, target])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split("\t");
      // Renames come out as "old => new" or "dir/{old => new}"; keep the destination for display.
      const raw = rest.join("\t");
      const path = raw.includes(" => ")
        ? raw.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/")
        : raw;
      const binary = added === "-";
      return {
        path,
        added: binary ? 0 : Number(added),
        deleted: binary ? 0 : Number(deleted),
        binary,
        lockfile: isLockfile(path),
      };
    });

  const excludes = LOCKFILES.flatMap((name) => [`:(exclude)${name}`, `:(exclude)**/${name}`]);
  let patch = git(cwd, ["diff", "-M", "--no-color", "--no-ext-diff", fromSha, target, "--", ".", ...excludes]);

  let truncated = false;
  if (Buffer.byteLength(patch, "utf-8") > MAX_PATCH_BYTES) {
    // Cut on a file boundary so diff2html still gets a valid patch.
    const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
    patch = cut > 0 ? patch.slice(0, cut + 1) : "";
    truncated = true;
  }

  return { files, patch, truncated, toWorkingTree };
}
