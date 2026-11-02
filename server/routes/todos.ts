import { Hono } from "hono";
import { db } from "../db/index.js";
import { todos } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { getPlanioBaseUrl } from "../settings.js";
import { ticketUrl } from "../agent/planio.js";

const app = new Hono();

// GET /api/todos/:projectId
app.get("/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const result = db
    .select()
    .from(todos)
    .where(eq(todos.projectId, projectId))
    .orderBy(asc(todos.sortOrder), asc(todos.createdAt))
    .all();
  // A todo imported from a ticket carries a link to it.
  const base = getPlanioBaseUrl();
  return c.json(result.map((t) => ({ ...t, externalUrl: t.source === "planio" && t.externalId ? ticketUrl(base, t.externalId) : null })));
});

// POST /api/todos
app.post("/", async (c) => {
  const body = await c.req.json();
  const maxOrder = db
    .select({ max: todos.sortOrder })
    .from(todos)
    .where(eq(todos.projectId, body.projectId))
    .get();
  const result = db
    .insert(todos)
    .values({
      projectId: body.projectId,
      title: body.title,
      description: body.description ?? null,
      sortOrder: ((maxOrder?.max as number) ?? 0) + 1,
    })
    .returning()
    .get();
  return c.json(result);
});

// PATCH /api/todos/:id
app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  db.update(todos).set(body).where(eq(todos.id, id)).run();
  const updated = db.select().from(todos).where(eq(todos.id, id)).get();
  return c.json(updated);
});

// DELETE /api/todos/:id
app.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  db.delete(todos).where(eq(todos.id, id)).run();
  return c.json({ ok: true });
});

export default app;
