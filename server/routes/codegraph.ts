import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { existsSync, rmSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { addLocalExclude } from "../agent/git-worktree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono();

function resolveBin(name: string) {
  const binName = process.platform === "win32" ? `${name}.cmd` : name;
  const candidates = [
    resolve(process.cwd(), "node_modules", ".bin", binName),
    join(__dirname, "..", "..", "node_modules", ".bin", binName),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

// Path to bundled codegraph binary
const CODEGRAPH_BIN = resolveBin("codegraph");

// In-memory tracking of which projects are currently being indexed
const indexingProjects = new Set<number>();

function isIndexed(projectPath: string): boolean {
  return existsSync(join(projectPath, ".codegraph"));
}

// Projects whose .codegraph/ has already been hidden from git during this run.
const hiddenFromGit = new Set<string>();

// .codegraph/ keeps an untracked config.json and .gitignore, which would show up in git status, in the
// snapshots and in the turn diffs. Hidden through the repo's local exclude file (never committed).
// Done here as well as after indexing so projects indexed before this change are fixed when opened.
function hideCodegraphFromGit(projectPath: string) {
  if (hiddenFromGit.has(projectPath)) return;
  hiddenFromGit.add(projectPath);
  try { addLocalExclude(projectPath, "/.codegraph/"); } catch {} // not a git repo: nothing to hide from
}

// GET /api/codegraph/:projectId/status
app.get("/:projectId/status", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  const indexed = isIndexed(project.path);
  if (indexed) hideCodegraphFromGit(project.path);
  return c.json({
    indexed,
    indexing: indexingProjects.has(projectId),
  });
});

// POST /api/codegraph/:projectId/init: runs `codegraph init` then `codegraph index`
app.post("/:projectId/init", async (c) => {
  const projectId = Number(c.req.param("projectId"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  if (indexingProjects.has(projectId)) {
    return c.json({ ok: false, error: "Already indexing" }, 409);
  }

  indexingProjects.add(projectId);
  console.log(`[codegraph:${projectId}] init + index ${project.path}`);

  // `init -i` runs init then index in one call. CI=1 in env skips interactive prompts.
  runCodegraph(["init", "-i", project.path], project.path)
    .then((res) => {
      if (res.code !== 0) {
        console.log(`[codegraph:${projectId}] init failed (code=${res.code}): ${res.stderr.slice(0, 500)}`);
      } else {
        console.log(`[codegraph:${projectId}] indexed successfully`);
        hiddenFromGit.delete(project.path); // re-checked on the next status read
        hideCodegraphFromGit(project.path);
      }
    })
    .catch((err) => console.log(`[codegraph:${projectId}] failed:`, err))
    .finally(() => {
      indexingProjects.delete(projectId);
    });

  return c.json({ ok: true });
});

// POST /api/codegraph/:projectId/sync: incremental update
app.post("/:projectId/sync", async (c) => {
  const projectId = Number(c.req.param("projectId"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  if (!isIndexed(project.path)) return c.json({ ok: false, error: "Not indexed" }, 400);

  // Background sync
  runCodegraph(["sync", project.path], project.path)
    .catch((err) => console.log(`[codegraph:${projectId}] sync failed:`, err));

  return c.json({ ok: true });
});

// DELETE /api/codegraph/:projectId: remove .codegraph
app.delete("/:projectId", async (c) => {
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid project id" }, 400);
  }

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return c.json({ error: "Not found" }, 404);

    indexingProjects.delete(projectId);
    rmSync(join(project.path, ".codegraph"), { recursive: true, force: true });
    return c.json({ ok: true, indexed: false, indexing: false });
  } catch (err) {
    console.log(`[codegraph:${projectId}] disable failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function runCodegraph(args: string[], cwd: string, timeoutMs = 10 * 60 * 1000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEGRAPH_BIN, args, { cwd, env: { ...process.env, CI: "1" } });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("timeout"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export { app, isIndexed, runCodegraph, CODEGRAPH_BIN, indexingProjects };
export default app;
