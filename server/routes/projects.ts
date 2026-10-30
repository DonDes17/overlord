import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, sessions, conversations, messages, todos, marketingDrafts, marketingAssets } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { readdirSync, existsSync, readFileSync } from "fs";
import { isAbsolute, join, relative } from "path";
import { execSync } from "child_process";
import { detectWorkspaces } from "../workspaces.js";
import { buildEffectiveSystemPrompt } from "../agent/system-prompt.js";
import { removeWorktree } from "../agent/git-worktree.js";
import type { Channel } from "../agent/types.js";

function getGitRemoteUrl(projectPath: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    // Convert SSH to HTTPS: git@github.com:user/repo.git -> https://github.com/user/repo
    if (url.startsWith("git@")) {
      return url
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/\.git$/, "");
    }
    // Clean HTTPS urls
    return url.replace(/\.git$/, "");
  } catch {
    return null;
  }
}

const app = new Hono();

function isInWorkspace(projectPath: string, workspaceRoot: string) {
  const rel = relative(workspaceRoot, projectPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// GET /api/projects - list all projects (non-hidden, favorites first)
app.get("/", (c) => {
  const showHidden = c.req.query("hidden") === "true";
  const rootDir = (c.get("rootDir" as never) as string) || process.cwd();
  const allProjects = db
    .select()
    .from(projects)
    .orderBy(desc(projects.favorite), desc(projects.updatedAt))
    .all()
    .filter((p) => isInWorkspace(p.path, rootDir))
    .filter((p) => showHidden || !p.hidden);
  return c.json(allProjects);
});

// GET /api/projects/:id - get a project with its latest session
app.get("/:id", (c) => {
  const id = Number(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  const latestSession = db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, id))
    .orderBy(desc(sessions.startedAt))
    .limit(1)
    .get();

  const remoteUrl = getGitRemoteUrl(project.path);
  return c.json({ ...project, latestSession: latestSession ?? null, remoteUrl });
});

// GET /api/projects/:id/workspaces - detect monorepo workspaces
app.get("/:id/workspaces", (c) => {
  const id = Number(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  const info = detectWorkspaces(project.path);
  return c.json(info);
});

// GET /api/projects/:id/system-prompt?channel=chat: preview the effective system prompt
app.get("/:id/system-prompt", (c) => {
  const id = Number(c.req.param("id"));
  const channel = (c.req.query("channel") as Channel) || "chat";
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  const parts = buildEffectiveSystemPrompt(project, channel, project.path);
  return c.json(parts);
});

// PATCH /api/projects/:id - update project status
app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  // If path is being changed, handle rename/move logic
  if (body.path) {
    const currentProject = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!currentProject) return c.json({ error: "Project not found" }, 404);

    const newPath = body.path.trim();
    const oldPath = currentProject.path;

    if (newPath !== oldPath) {
      // Check if another project already uses this path in DB
      const otherProject = db.select().from(projects).where(eq(projects.path, newPath)).get();
      if (otherProject && otherProject.id !== id) {
        return c.json({ error: "Another project already uses this path" }, 409);
      }

      const newPathExists = existsSync(newPath);
      const oldPathExists = existsSync(oldPath);

      if (newPathExists) {
        return c.json({ error: `A folder already exists at this location: ${newPath}` }, 409);
      }

      try {
        const { renameSync, mkdirSync } = await import("fs");
        if (oldPathExists) {
          // Rename/move the existing folder
          renameSync(oldPath, newPath);
        } else {
          // Old folder gone, create new empty folder at new location
          mkdirSync(newPath, { recursive: true });
        }
      } catch (err) {
        return c.json({ error: `Move failed: ${err}` }, 500);
      }

      body.path = newPath;
      if (!body.name) {
        body.name = newPath.split("/").pop() || "unknown";
      }

      // Clear the claudeSessionId of any in-memory agent session for this project
      // (Claude sessions are tied to cwd, so rename invalidates them)
      // This is done via the DB indirectly, but also clear conversations' sessionId.
      db.update(conversations)
        .set({ claudeSessionId: null })
        .where(eq(conversations.projectId, id))
        .run();
    }
  }

  db.update(projects)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .run();
  const updated = db.select().from(projects).where(eq(projects.id, id)).get();
  return c.json(updated);
});

// POST /api/projects/scan - scan root dir for projects
// ?gitOnly=true to only scan git repos (default: scan all directories)
app.post("/scan", async (c) => {
  const rootDir = (c.get("rootDir" as never) as string) || process.cwd();
  const body = await c.req.json().catch(() => ({}));
  const gitOnly = body.gitOnly ?? false;
  const found: string[] = [];

  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        if (gitOnly) {
          const projectPath = join(rootDir, entry.name);
          if (existsSync(join(projectPath, ".git"))) {
            found.push(entry.name);
          }
        } else {
          found.push(entry.name);
        }
      }
    }
  } catch {
    return c.json({ error: "Cannot read root directory" }, 500);
  }

  // Upsert found projects
  const upserted = [];
  for (const name of found) {
    const path = join(rootDir, name);
    const existing = db
      .select()
      .from(projects)
      .where(eq(projects.path, path))
      .get();
    if (!existing) {
      db.insert(projects).values({ name, path }).run();
    }
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.path, path))
      .get();
    upserted.push(project);
  }

  return c.json(upserted);
});

// POST /api/projects/add - add a specific directory as a project
app.post("/add", async (c) => {
  const body = await c.req.json();
  const path = body.path?.trim();
  if (!path) return c.json({ error: "Path required" }, 400);

  if (!existsSync(path)) return c.json({ error: "Directory not found" }, 404);

  const name = body.name || path.split("/").pop() || "unknown";
  const existing = db.select().from(projects).where(eq(projects.path, path)).get();
  if (!existing) {
    db.insert(projects).values({ name, path }).run();
  }
  const project = db.select().from(projects).where(eq(projects.path, path)).get();
  return c.json(project);
});

// POST /api/projects/create - create a new folder and register it as a project
app.post("/create", async (c) => {
  const rootDir = (c.get("rootDir" as never) as string) || process.cwd();
  const body = await c.req.json();
  const name = body.name?.trim();
  const initGit = body.initGit ?? true;

  if (!name) return c.json({ error: "Name required" }, 400);
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
    return c.json({ error: "Invalid name (use letters, numbers, -, _, .)" }, 400);
  }

  const path = join(rootDir, name);
  if (existsSync(path)) return c.json({ error: "Directory already exists" }, 409);

  try {
    const { mkdirSync } = await import("fs");
    mkdirSync(path, { recursive: true });

    if (initGit) {
      execSync("git init", { cwd: path, stdio: "ignore" });
    }
  } catch (err) {
    return c.json({ error: `Failed to create directory: ${err}` }, 500);
  }

  const existing = db.select().from(projects).where(eq(projects.path, path)).get();
  if (!existing) {
    db.insert(projects).values({ name, path }).run();
  }
  const project = db.select().from(projects).where(eq(projects.path, path)).get();
  return c.json(project);
});

// DELETE /api/projects/:id - remove project + all related data
// Query param ?deleteFolder=true to also delete the folder on disk
app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const deleteFolder = c.req.query("deleteFolder") === "true";

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  // Collect marketing asset file paths so we can unlink them
  const assets = db
    .select()
    .from(marketingAssets)
    .where(eq(marketingAssets.projectId, id))
    .all();

  // Fetch conversations to delete their messages
  const projectConversations = db
    .select({ id: conversations.id, worktreePath: conversations.worktreePath, worktreeBranch: conversations.worktreeBranch })
    .from(conversations)
    .where(eq(conversations.projectId, id))
    .all();

  // Worktrees are removed only when clean and merged; the others stay on disk and are reported.
  const worktreesKept: { path: string; branch: string }[] = [];
  for (const conv of projectConversations) {
    if (!conv.worktreePath || !conv.worktreeBranch) continue;
    if (!removeWorktree(project.path, conv.worktreePath, conv.worktreeBranch).ok) {
      worktreesKept.push({ path: conv.worktreePath, branch: conv.worktreeBranch });
    }
  }

  try {
    // Delete child tables first (respect FK order)
    for (const conv of projectConversations) {
      db.delete(messages).where(eq(messages.conversationId, conv.id)).run();
    }
    db.delete(conversations).where(eq(conversations.projectId, id)).run();
    db.delete(sessions).where(eq(sessions.projectId, id)).run();
    db.delete(todos).where(eq(todos.projectId, id)).run();
    db.delete(marketingDrafts).where(eq(marketingDrafts.projectId, id)).run();
    db.delete(marketingAssets).where(eq(marketingAssets.projectId, id)).run();
    db.delete(projects).where(eq(projects.id, id)).run();

    // Unlink asset files on disk
    const { unlinkSync, rmSync } = await import("fs");
    for (const asset of assets) {
      try { unlinkSync(asset.filePath); } catch {}
    }

    // Optionally remove project folder on disk
    if (deleteFolder && existsSync(project.path)) {
      rmSync(project.path, { recursive: true, force: true });
    }

    return c.json({ ok: true, deletedFolder: deleteFolder, worktreesKept });
  } catch (err) {
    return c.json({ error: `Deletion failed: ${err}` }, 500);
  }
});

export default app;
