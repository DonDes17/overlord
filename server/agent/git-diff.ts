import { execFileSync } from "child_process";
import { withTempIndex } from "./git-index.js";

// Lockfiles are listed in the stats but left out of the rendered patch:
// they are huge and almost never what you want to review.
const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Podfile.lock"];
const MAX_PATCH_BYTES = 3 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface DiffFileStat {
  path: string;
  /** Previous path when the file was renamed. */
  oldPath?: string;
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
  return withTempIndex(cwd, (env) => {
    git(cwd, ["add", "-A"], env);
    return git(cwd, ["write-tree"], env).trim();
  });
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
      const renamed = raw.includes(" => ");
      const path = renamed
        ? raw.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/")
        : raw;
      const oldPath = renamed
        ? raw.replace(/\{([^}]*) => [^}]*\}/, "$1").replace(/ => .*$/, "").replace(/\/\//g, "/")
        : undefined;
      const binary = added === "-";
      return {
        path,
        oldPath,
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

export interface RevertResult {
  ok: boolean;
  error?: string;
}

/**
 * Undo a turn (or some of its files) by applying its patch in reverse on the
 * working tree. Changes made by later turns are kept; on conflict nothing is written.
 */
export function revertTurn(cwd: string, fromSha: string, toSha?: string, paths?: string[]): RevertResult {
  const target = toSha ?? workingTreeSha(cwd);
  const scope = paths?.length ? ["--", ...paths] : [];
  // --no-renames turns a rename into delete + add, so both paths must be in `paths`.
  const patch = git(cwd, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", fromSha, target, ...scope]);
  if (!patch.trim()) return { ok: true };

  const run = (args: string[]) =>
    execFileSync("git", ["apply", "-R", "--whitespace=nowarn", ...args], {
      cwd,
      input: patch,
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  try {
    run(["--check"]);
    run([]);
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    return { ok: false, error: (stderr || String(err)).trim() };
  }
}
