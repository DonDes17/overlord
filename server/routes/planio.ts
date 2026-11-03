import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects, todos } from "../db/schema.js";
import { getPlanioBaseUrl, getPlanioStatuses, setPlanioBaseUrl, setPlanioStatuses } from "../settings.js";
import { buildTicketContext, fetchMyOpenTickets, fetchTicket, ticketUrl } from "../agent/planio.js";
import { englishSlug } from "../agent/english-slug.js";
import type { PlanioTicketDetail } from "../agent/planio.js";
import { createBranchConversation } from "./conversations.js";

const app = new Hono();

app.get("/settings", (c) => c.json({ baseUrl: getPlanioBaseUrl(), statuses: getPlanioStatuses() }));

app.put("/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const baseUrl = setPlanioBaseUrl(body.baseUrl);
    const statuses = body.statuses === undefined ? getPlanioStatuses() : setPlanioStatuses(body.statuses);
    return c.json({ baseUrl, statuses });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid address" }, 400);
  }
});

// Planio project names a project is mapped to ("Cloud, Exopro"): matched by name, case-insensitive.
const mappedNames = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

const syncing = new Set<number>();

// POST /api/planio/sync { projectId }: import the user's open tickets as todos of this project.
// One headless Claude call (about a cent). Never writes to Planio.
app.post("/sync", async (c) => {
  const { projectId } = await c.req.json().catch(() => ({}));
  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project) return c.json({ ok: false, error: "Project not found" }, 404);
  if (syncing.has(project.id)) return c.json({ ok: false, error: "Une synchronisation est déjà en cours." }, 409);

  syncing.add(project.id);
  try {
    const fetched = await fetchMyOpenTickets();
    if (!fetched.ok) return c.json({ ok: false, error: fetched.error }, 502);

    // Which Planio projects exist among my tickets: lets the UI offer a choice when nothing is mapped yet.
    const counts = new Map<string, number>();
    for (const t of fetched.tickets) counts.set(t.project, (counts.get(t.project) ?? 0) + 1);
    const available = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    const names = mappedNames(project.planioProject);
    if (names.length === 0) return c.json({ ok: true, needsMapping: true, available, imported: 0, updated: 0, gone: 0, partial: fetched.tickets.length < fetched.total, fetched: fetched.tickets.length, total: fetched.total });

    const mine = fetched.tickets.filter((t) => names.some((n) => t.project.toLowerCase().includes(n)));
    const existing = db.select().from(todos).where(and(eq(todos.projectId, project.id), eq(todos.source, "planio"))).all();
    const byTicket = new Map(existing.map((t) => [t.externalId, t]));

    // Only tickets in the wanted statuses are imported ("Development", "Ready to dev"...; none listed = all).
    // A ticket already imported that moved to another status stays, with its new status shown.
    const wanted = getPlanioStatuses().map((n) => n.toLowerCase());
    const isWanted = (status: string) => wanted.length === 0 || wanted.includes(status.trim().toLowerCase());

    let order = db.select().from(todos).where(eq(todos.projectId, project.id)).all().reduce((m, t) => Math.max(m, t.sortOrder), 0);
    let imported = 0;
    let updated = 0;
    for (const t of mine) {
      const known = byTicket.get(String(t.id));
      if (known) {
        // Planio is the source of truth for the text and the status; `done` stays the user's.
        db.update(todos).set({ title: t.subject, description: t.description || null, externalStatus: t.status }).where(eq(todos.id, known.id)).run();
        updated++;
      } else if (isWanted(t.status)) {
        db.insert(todos).values({ projectId: project.id, title: t.subject, description: t.description || null, source: "planio", externalId: String(t.id), externalStatus: t.status, sortOrder: ++order }).run();
        imported++;
      }
    }

    // No longer among my open tickets (closed or reassigned): flagged, never deleted.
    const stillOpen = new Set(mine.map((t) => String(t.id)));
    let gone = 0;
    for (const t of existing) {
      if (!stillOpen.has(t.externalId ?? "") && t.externalStatus !== null) {
        db.update(todos).set({ externalStatus: null }).where(eq(todos.id, t.id)).run();
        gone++;
      }
    }
    return c.json({ ok: true, imported, updated, gone, available, partial: fetched.tickets.length < fetched.total, fetched: fetched.tickets.length, total: fetched.total });
  } finally {
    syncing.delete(project.id);
  }
});

// POST /api/planio/start { todoId, branchName? }: start work on a ticket in its own worktree, on a branch
// named after it. A second call reads the full ticket (notes included); if it fails, the ticket text stored
// at the last sync is used instead, and the user is told.
app.post("/start", async (c) => {
  const { todoId, branchName } = await c.req.json().catch(() => ({}));
  const todo = db.select().from(todos).where(eq(todos.id, Number(todoId))).get();
  if (!todo || todo.source !== "planio" || !todo.externalId) return c.json({ ok: false, error: "Ce n'est pas un ticket Planio." }, 400);
  const id = Number(todo.externalId);

  const detail = await fetchTicket(id);
  const ticket: PlanioTicketDetail = detail.ok
    ? detail.ticket
    : { id, subject: todo.title, status: todo.externalStatus ?? "", project: "", description: todo.description ?? "", notes: [] };
  const url = ticketUrl(getPlanioBaseUrl(), id);

  // Branch names are always in English: the subject is translated, and without an answer the branch is
  // just the ticket number (never the original words).
  const english = typeof branchName === "string" && branchName.trim() ? null : await englishSlug(ticket.subject, 50);
  const branch = typeof branchName === "string" && branchName.trim() ? branchName.trim() : english ? `${id}-${english}` : String(id);

  const created = createBranchConversation({
    projectId: todo.projectId,
    title: `#${id} ${ticket.subject}`,
    contextText: buildTicketContext(ticket, url),
    worktree: { branch },
    ticket: { id, subject: ticket.subject, url },
  });
  if (!created.ok) return c.json({ ok: false, error: created.error }, 400);

  return c.json({
    ok: true,
    conversation: created.conversation,
    notes: ticket.notes.length,
    warning: detail.ok ? undefined : `Le ticket complet n'a pas pu être relu (${detail.error}). Le texte de la dernière synchronisation est utilisé.`,
  });
});

export default app;
