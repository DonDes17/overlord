import { Hono } from "hono";
import { db } from "../db/index.js";
import { conversations, messages, projects, queuedMessages } from "../db/schema.js";
import { eq, desc, and, like } from "drizzle-orm";
import { agentSessions, sessionKey } from "../agent/sessions.js";
import { createWorktree, removeWorktree, worktreeStatus } from "../agent/git-worktree.js";
import type { Channel } from "../agent/types.js";

const app = new Hono();

// Derive a short, human-friendly title + preview from a stored context excerpt.
function deriveTitle(contextText: string | null | undefined): string {
  if (!contextText) return "Branch";
  const firstLine = contextText
    .split("\n")
    .map((l) => l.replace(/^\s*(You|Claude|User|Assistant):\s*/i, "").trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? contextText).trim();
  return base.length > 60 ? base.slice(0, 60) + "…" : base || "Branch";
}

// Last readable snippet from a sub-conversation's stored events, for the list.
function previewFromEvents(eventsJson: string | null): { preview: string; lastActivityAt: string | null } {
  if (!eventsJson) return { preview: "", lastActivityAt: null };
  try {
    const events = JSON.parse(eventsJson) as any[];
    let preview = "";
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "result" && typeof ev.result === "string" && ev.result.trim()) {
        preview = ev.result.trim();
        break;
      }
      if (ev.type === "user_message" && typeof ev.content === "string" && ev.content.trim()) {
        preview = ev.content.trim();
        break;
      }
    }
    return {
      preview: preview.length > 140 ? preview.slice(0, 140) + "…" : preview,
      lastActivityAt: null,
    };
  } catch {
    return { preview: "", lastActivityAt: null };
  }
}

function liveRunning(projectId: number, conversationId: number): boolean {
  const channel = `sub:${conversationId}` as Channel;
  const session = agentSessions.get(sessionKey(projectId, channel));
  return session?.status === "running";
}

// --- Sub-conversations ("branches") ---------------------------------------

// POST /api/conversations/sub - spin off a new branch from a message.
// Body: { projectId, parentConversationId?, contextText, title?, worktree?: true | { name?: string } }
// With `worktree`, the branch gets its own git worktree (and `overlord/<name>` git branch) so it
// can run in parallel with other branches without touching the same files.
app.post("/sub", async (c) => {
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  if (!projectId) return c.json({ error: "projectId required" }, 400);

  const contextText: string = typeof body.contextText === "string" ? body.contextText : "";
  const title: string = (body.title && String(body.title).trim()) || deriveTitle(contextText);
  const parentConversationId =
    body.parentConversationId != null ? Number(body.parentConversationId) : null;

  // Insert first to obtain the id, then encode it into the channel so the
  // agent session machinery keys this branch independently (`sub:<id>`).
  const created = db
    .insert(conversations)
    .values({
      projectId,
      channel: "sub:pending",
      title,
      contextText: contextText || null,
      parentConversationId,
      unread: false,
    })
    .returning()
    .get();

  let updated = db
    .update(conversations)
    .set({ channel: `sub:${created.id}` })
    .where(eq(conversations.id, created.id))
    .returning()
    .get();

  if (body.worktree) {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    const requested = typeof body.worktree === "object" && typeof body.worktree.name === "string" ? body.worktree.name.trim() : "";
    const result = project
      ? createWorktree(project.path, projectId, created.id, requested || title)
      : ({ ok: false, error: "Project not found" } as const);
    if (!result.ok) {
      // No half-created branch: drop the row so the user can simply retry.
      db.delete(conversations).where(eq(conversations.id, created.id)).run();
      return c.json({ error: result.error }, 400);
    }
    updated = db
      .update(conversations)
      .set({ worktreePath: result.worktree.path, worktreeBranch: result.worktree.branch })
      .where(eq(conversations.id, created.id))
      .returning()
      .get();
  }

  return c.json(updated);
});

// GET /api/conversations/sub/:projectId - list branches for a project, newest first.
app.get("/sub/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const rows = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.projectId, projectId), like(conversations.channel, "sub:%")))
    .orderBy(desc(conversations.createdAt))
    .all();

  const result = rows
    // Guard against a half-created row that never got its final channel.
    .filter((r) => r.channel !== "sub:pending")
    .map((r) => {
      const { preview } = previewFromEvents(r.eventsJson);
      return {
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        contextText: r.contextText,
        parentConversationId: r.parentConversationId,
        createdAt: r.createdAt,
        unread: !!r.unread,
        running: liveRunning(projectId, r.id),
        hasEvents: !!r.eventsJson && r.eventsJson !== "[]",
        preview,
        worktreeBranch: r.worktreeBranch,
        worktreePath: r.worktreePath,
        worktree: r.worktreePath && r.worktreeBranch ? worktreeStatus(r.worktreePath, r.worktreeBranch) : null,
      };
    });

  return c.json(result);
});

// GET /api/conversations/:id/worktree - path, branch and state of a branch's worktree (/worktree).
app.get("/:id/worktree", (c) => {
  const conv = db.select().from(conversations).where(eq(conversations.id, Number(c.req.param("id")))).get();
  if (!conv) return c.json({ ok: false, error: "Not found" }, 404);
  if (!conv.worktreePath || !conv.worktreeBranch) return c.json({ ok: true, worktree: null });
  return c.json({
    ok: true,
    worktree: { path: conv.worktreePath, branch: conv.worktreeBranch, status: worktreeStatus(conv.worktreePath, conv.worktreeBranch) },
  });
});

// DELETE /api/conversations/:id/worktree - drop the worktree but keep the conversation (/worktree -d).
// The branch then works in the project folder. Refused when work would be lost, unless ?force=true.
app.delete("/:id/worktree", (c) => {
  const conv = db.select().from(conversations).where(eq(conversations.id, Number(c.req.param("id")))).get();
  if (!conv) return c.json({ ok: false, error: "Not found" }, 404);
  if (!conv.worktreePath || !conv.worktreeBranch) return c.json({ ok: false, error: "Cette branche n'a pas de worktree." }, 400);
  const project = db.select().from(projects).where(eq(projects.id, conv.projectId)).get();
  if (!project) return c.json({ ok: false, error: "Project not found" }, 404);

  const session = agentSessions.get(sessionKey(conv.projectId, conv.channel as Channel));
  if (session?.status === "running") {
    return c.json({ ok: false, error: "L'agent tourne dans cette branche. Stoppez-le d'abord." }, 409);
  }

  const result = removeWorktree(project.path, conv.worktreePath, conv.worktreeBranch, c.req.query("force") === "true");
  if (!result.ok) return c.json({ ok: false, error: result.error, status: result.status }, 409);

  // Claude sessions belong to a folder: the old one cannot be resumed from the project folder.
  db.update(conversations)
    .set({ worktreePath: null, worktreeBranch: null, claudeSessionId: null })
    .where(eq(conversations.id, conv.id))
    .run();
  if (session) {
    session.projectPath = project.path;
    session.claudeSessionId = null;
  }
  return c.json({ ok: true, warning: result.error });
});

// POST /api/conversations/:id/read - clear the unread flag for a branch.
app.post("/:id/read", (c) => {
  const id = Number(c.req.param("id"));
  db.update(conversations).set({ unread: false }).where(eq(conversations.id, id)).run();
  return c.json({ ok: true });
});

// DELETE /api/conversations/:id - remove a branch and its dependent rows.
app.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) return c.json({ error: "Not found" }, 404);

  // Only branches are deletable through this endpoint.
  if (!conv.channel.startsWith("sub:")) {
    return c.json({ error: "Only branches can be deleted" }, 400);
  }

  // Stop any live process and drop the in-memory session.
  const key = sessionKey(conv.projectId, conv.channel as Channel);
  const session = agentSessions.get(key);
  if (session?.currentProcess) {
    try { session.currentProcess.kill("SIGTERM"); } catch {}
  }
  agentSessions.delete(key);

  // Remove the worktree only when nothing would be lost; otherwise keep it and tell the caller
  // where it is, since the conversation row (and so its path) is about to disappear.
  let worktree: { removed: boolean; path: string; branch: string; reason?: string } | null = null;
  if (conv.worktreePath && conv.worktreeBranch) {
    const project = db.select().from(projects).where(eq(projects.id, conv.projectId)).get();
    const result = project
      ? removeWorktree(project.path, conv.worktreePath, conv.worktreeBranch, c.req.query("force") === "true")
      : { ok: false, error: "Project not found" };
    worktree = { removed: result.ok, path: conv.worktreePath, branch: conv.worktreeBranch, reason: result.error };
  }

  db.delete(messages).where(eq(messages.conversationId, id)).run();
  db.delete(queuedMessages)
    .where(and(eq(queuedMessages.projectId, conv.projectId), eq(queuedMessages.channel, conv.channel)))
    .run();
  db.delete(conversations).where(eq(conversations.id, id)).run();

  return c.json({ ok: true, worktree });
});

// --- Existing endpoints ----------------------------------------------------

// GET /api/conversations/:projectId - list conversations for a project
app.get("/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const result = db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt))
    .all();
  return c.json(result);
});

// GET /api/conversations/:id/messages - get messages for a conversation
app.get("/:id/messages", (c) => {
  const id = Number(c.req.param("id"));
  const result = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .all();
  return c.json(result);
});

// GET /api/conversations/latest/:projectId - get latest conversation with messages
app.get("/latest/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt))
    .limit(1)
    .get();

  if (!conv) return c.json({ conversation: null, messages: [] });

  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .all();

  return c.json({ conversation: conv, messages: msgs });
});

export default app;
