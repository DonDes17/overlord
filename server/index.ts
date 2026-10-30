import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

import { initDb, db } from "./db/index.js";
import { conversations, projects } from "./db/schema.js";
import { eq, sql } from "drizzle-orm";

import projectRoutes from "./routes/projects.js";
import sessionRoutes from "./routes/sessions.js";
import conversationRoutes from "./routes/conversations.js";
import todoRoutes from "./routes/todos.js";
import marketingRoutes from "./routes/marketing.js";
import skillsRoutes from "./routes/skills.js";
import learningsRoutes from "./routes/learnings.js";
import codegraphRoutes from "./routes/codegraph.js";
import uploadsRoutes from "./routes/uploads.js";
import settingsRoutes from "./routes/settings.js";
import { getWorkspaceRoot } from "./settings.js";
import insightsRoutes from "./routes/insights.js";
import commandsRoutes from "./routes/commands.js";
import toolRequestsRoutes from "./routes/tool-requests.js";

import { setWebSocketServer } from "./ws.js";
import { attachWsHandlers } from "./agent/ws-handler.js";
import { agentSessions, getOrCreateSession, loadSessionFromDb, resolveProjectPath, sessionKey, saveEventsNow } from "./agent/sessions.js";
import { isValidSessionId, listClaudeSessions, sessionFileExists } from "./agent/claude-sessions.js";
import { getCommitsSince, rollbackToSnapshot } from "./agent/git-snapshot.js";
import { isValidSha, revertHunk, revertTurn, turnDiff, turnDiffStats } from "./agent/git-diff.js";
import { createBranch, currentBranch, deleteBranch, listBranches, switchBranch } from "./agent/git-branch.js";
import type { Channel } from "./agent/types.js";

const PORT = Number(process.env.PORT) || 4747;
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const STATIC_ROOT = process.env.OVERLORD_STATIC_ROOT || resolve(process.cwd(), "dist/client");
const RTK_SETUP_SCRIPT = resolve(process.cwd(), "scripts/setup-rtk.sh");

initDb();

function runRuntimeSetupHooks() {
  if (process.env.RTK_SKIP === "1") return;
  if (existsSync(RTK_SETUP_SCRIPT)) {
    const proc = spawn("bash", [RTK_SETUP_SCRIPT], {
      detached: true,
      env: { ...process.env },
      stdio: "ignore",
    });
    proc.unref();
  }
}

runRuntimeSetupHooks();

const app = new Hono();
app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  return c.text("Internal Server Error", 500);
});
app.use("/api/*", cors());
app.use("/api/*", async (c, next) => {
  c.set("rootDir" as never, getWorkspaceRoot() as never);
  await next();
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, name: "overlord" });
});

app.route("/api/projects", projectRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/todos", todoRoutes);
app.route("/api/marketing", marketingRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/learnings", learningsRoutes);
app.route("/api/codegraph", codegraphRoutes);
app.route("/api/uploads", uploadsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/insights", insightsRoutes);
app.route("/api/commands", commandsRoutes);
app.route("/api/tool-requests", toolRequestsRoutes);

type TerminalConfig =
  | { id: string; name: string; platform: "darwin"; app: string }
  | { id: string; name: string; platform: "linux"; cmd: string; args: (dir: string) => string[] }
  | { id: string; name: string; platform: "win32"; cmd: string };

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const TERMINALS: TerminalConfig[] = [
  { id: "terminal", name: "Terminal", platform: "darwin", app: "Terminal" },
  { id: "iterm2", name: "iTerm2", platform: "darwin", app: "iTerm" },
  { id: "warp", name: "Warp", platform: "darwin", app: "Warp" },
  { id: "gnome-terminal", name: "GNOME Terminal", platform: "linux", cmd: "gnome-terminal", args: (dir: string) => ["--working-directory", dir] },
  { id: "konsole", name: "Konsole", platform: "linux", cmd: "konsole", args: (dir: string) => ["--workdir", dir] },
  { id: "xfce4-terminal", name: "Xfce Terminal", platform: "linux", cmd: "xfce4-terminal", args: (dir: string) => ["--working-directory", dir] },
  { id: "xterm", name: "xterm", platform: "linux", cmd: "xterm", args: (dir: string) => ["-e", "sh", "-c", `cd ${shellQuote(dir)} && exec "\${SHELL:-sh}"`] },
  { id: "cmd", name: "Command Prompt", platform: "win32", cmd: "cmd" },
];

function hasDarwinApp(appName: string) {
  try {
    execSync(`osascript -e 'id of app "${appName}"'`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getAvailableTerminals() {
  const platform = process.platform;
  return TERMINALS.filter((terminal) => {
    if (terminal.platform !== platform) return false;
    if ("app" in terminal) return hasDarwinApp(terminal.app);
    if (!("cmd" in terminal) || terminal.cmd === "cmd") return true;
    try {
      execSync(`which ${terminal.cmd}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

app.get("/api/terminals", (c) => {
  return c.json(getAvailableTerminals().map(({ id, name }) => ({ id, name })));
});

app.post("/api/terminal/open", async (c) => {
  const body = await c.req.json();
  const dir = body.path;
  if (!dir || typeof dir !== "string") return c.json({ error: "Path required" }, 400);

  const available = getAvailableTerminals();
  const terminalConfig = available.find((terminal) => terminal.id === body.terminal) ?? available[0];
  if (!terminalConfig) return c.json({ error: "No terminal found" }, 404);

  if (terminalConfig.platform === "darwin") {
    spawn("open", ["-a", terminalConfig.app, dir], { detached: true, stdio: "ignore" });
  } else if (terminalConfig.platform === "win32") {
    spawn("cmd", ["/c", "start", "", "/D", dir, "cmd"], { detached: true, stdio: "ignore" });
  } else {
    spawn(terminalConfig.cmd, terminalConfig.args(dir), { detached: true, stdio: "ignore" });
  }

  return c.json({ ok: true });
});

const EDITORS = [
  { id: "cursor", name: "Cursor", cmd: "cursor", test: "cursor", darwinApp: "Cursor" },
  { id: "vscode", name: "VS Code", cmd: "code", test: "code", darwinApp: "Visual Studio Code" },
  { id: "zed", name: "Zed", cmd: "zed", test: "zed", darwinApp: "Zed" },
  { id: "webstorm", name: "WebStorm", cmd: "webstorm", test: "webstorm", darwinApp: "WebStorm" },
  { id: "idea", name: "IntelliJ IDEA", cmd: "idea", test: "idea", darwinApp: "IntelliJ IDEA" },
  { id: "sublime", name: "Sublime Text", cmd: "subl", test: "subl", darwinApp: "Sublime Text" },
  { id: "vim", name: "Vim", cmd: "vim", test: "vim" },
  { id: "nano", name: "Nano", cmd: "nano", test: "nano" },
];

function hasCommand(command: string) {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isEditorAvailable(editor: (typeof EDITORS)[number]) {
  if (hasCommand(editor.test)) return true;
  const darwinApp = "darwinApp" in editor ? editor.darwinApp : undefined;
  return process.platform === "darwin" && !!darwinApp && hasDarwinApp(darwinApp);
}

app.get("/api/editors", (c) => {
  const available = EDITORS.filter(isEditorAvailable);
  return c.json(available);
});

app.post("/api/editor/open", async (c) => {
  const body = await c.req.json();
  const { filePath, editor } = body;
  if (!filePath || !editor) return c.json({ error: "filePath and editor required" }, 400);

  const editorConfig = EDITORS.find((e) => e.id === editor);
  if (!editorConfig) return c.json({ error: "Unknown editor" }, 404);

  if (hasCommand(editorConfig.cmd)) {
    spawn(editorConfig.cmd, [filePath], { detached: true, stdio: "ignore" });
  } else if (process.platform === "darwin" && "darwinApp" in editorConfig && editorConfig.darwinApp && hasDarwinApp(editorConfig.darwinApp)) {
    spawn("open", ["-a", editorConfig.darwinApp, filePath], { detached: true, stdio: "ignore" });
  } else {
    return c.json({ error: `${editorConfig.name} is not available` }, 404);
  }
  return c.json({ ok: true });
});

app.get("/api/rtk/gain/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  try {
    const output = execSync("rtk gain --project --format json", {
      cwd: project.path,
      encoding: "utf-8",
      timeout: 5000,
    });
    return c.json(JSON.parse(output));
  } catch {
    return c.json({ summary: null });
  }
});

// Dynamically resolve model aliases to versioned IDs.
// We start the CLI with an alias, read the first `system/init` event, then stop
// the process. It is cheap and uses the existing Claude CLI authentication.
interface ResolvedModelOption { id: string; label: string; short: string; version: string | null; }

// Opus and Sonnet support 1M context. Haiku does not.
const MODEL_ALIASES = [
  { alias: "opus", oneM: true },
  { alias: "sonnet", oneM: true },
  { alias: "haiku", oneM: false },
];
const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1h
let modelCache: { at: number; models: ResolvedModelOption[] } | null = null;

function resolveAlias(alias: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn(
      CLAUDE_PATH,
      ["--model", alias, "--print", "--output-format", "stream-json", "--verbose", "hi"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch {}
      resolveP(val);
    };
    const timer = setTimeout(() => finish(null), 20000);
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "system" && ev.subtype === "init" && ev.model) {
            finish(ev.model);
            return;
          }
        } catch {}
      }
    });
    proc.on("error", () => finish(null));
    proc.on("close", () => finish(null));
  });
}

function formatModelVersion(id: string): string {
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return id.replace(/^claude-/, "");
}

app.get("/api/models", async (c) => {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL) {
    return c.json(modelCache.models);
  }

  const resolved = await Promise.all(
    MODEL_ALIASES.map(async (spec) => ({ ...spec, id: await resolveAlias(spec.alias) })),
  );

  const models: ResolvedModelOption[] = [
    { id: "", label: "Default (Claude CLI default)", short: "Default", version: null },
  ];
  for (const r of resolved) {
    const ver = r.id ? formatModelVersion(r.id) : r.alias[0].toUpperCase() + r.alias.slice(1);
    models.push({ id: r.alias, label: `Claude ${ver}`, short: ver, version: r.id });
    if (r.oneM) {
      models.push({
        id: `${r.alias}[1m]`,
        label: `Claude ${ver} (1M context)`,
        short: `${ver} 1M`,
        version: r.id ? `${r.id}[1m]` : null,
      });
    }
  }

  // Cache only when at least one alias resolved, so transient CLI or network
  // failures do not freeze the static fallback list.
  if (resolved.some((r) => r.id)) modelCache = { at: Date.now(), models };
  return c.json(models);
});

app.post("/api/agent/ask", async (c) => {
  const body = await c.req.json();
  const { projectId, question } = body;
  if (!projectId || !question) return c.json({ error: "projectId and question required" }, 400);

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);

  console.log(`[ask:${project.name}] "${question.slice(0, 80)}..."`);

  const result = await new Promise<{ ok: boolean; answer?: string; error?: string; code?: number | null }>((resolveP) => {
    const proc = spawn(CLAUDE_PATH, ["--print", "--", question], {
      cwd: project.path,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    proc.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    proc.stderr!.on("data", () => {});

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolveP({ ok: false, error: "Timeout (3min)", answer: output.trim() });
    }, 3 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[ask:${project.name}] done code=${code} (${output.length} chars)`);
      resolveP({ ok: true, answer: output.trim(), code });
    });
  });

  return c.json({ ...result, project: project.name });
});

app.post("/api/agent/rollback", async (c) => {
  const body = await c.req.json();
  const { projectId, snapshotSha, messageIndex, channel = "chat" } = body;

  if (!projectId || !snapshotSha) return c.json({ error: "projectId and snapshotSha required" }, 400);

  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ error: "No session found" }, 404);

  const commitsSince = getCommitsSince(session.projectPath, snapshotSha);
  if (commitsSince > 0) {
    return c.json({
      error: `${commitsSince} commit(s) ont ete faits depuis ce point. Le rollback ecraserait ces changements.`,
      commitsSince,
      needsConfirm: true,
    });
  }

  const result = rollbackToSnapshot(session.projectPath, snapshotSha);
  if (!result.ok) return c.json({ error: result.error }, 500);

  if (typeof messageIndex === "number" && messageIndex >= 0) {
    session.events = session.events.slice(0, messageIndex);
    saveEventsNow(session);
  }

  return c.json({ ok: true });
});

// Diff of one agent turn: from the snapshot taken before the message to the
// next message's snapshot, or to the working directory for the latest turn.
app.post("/api/agent/diff", async (c) => {
  const { projectId, fromSha, toSha, channel: rawChannel, statsOnly } = await c.req.json();
  const channel = parseChannel(rawChannel);
  if (!projectId || !channel || !isValidSha(fromSha)) return c.json({ ok: false, error: "projectId and a valid fromSha are required" }, 400);
  if (toSha !== undefined && toSha !== null && !isValidSha(toSha)) return c.json({ ok: false, error: "Invalid toSha" }, 400);

  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project) return c.json({ ok: false, error: "Project not found" }, 404);

  try {
    const path = pathFor(project, channel);
    // statsOnly: file list and counts for the turn footer, without the patch.
    if (statsOnly) return c.json({ ok: true, ...turnDiffStats(path, fromSha, toSha ?? undefined) });
    return c.json({ ok: true, ...turnDiff(path, fromSha, toSha ?? undefined) });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// Folder a request about a conversation must act on: its worktree if it has one, else the project.
function pathFor(project: { id: number; path: string }, channel: Channel): string {
  return agentSessions.get(sessionKey(project.id, channel))?.projectPath ?? resolveProjectPath(project.id, project.path, channel);
}

// Per folder, not per project: an agent running in a worktree must not block the main folder.
function isAgentRunning(path: string): boolean {
  for (const [, session] of agentSessions) {
    if (session.projectPath === path && session.status === "running") return true;
  }
  return false;
}

// Current git branch of a project (shown in the chat header).
app.get("/api/agent/branch", (c) => {
  const projectId = Number(c.req.query("projectId"));
  const channel = parseChannel(c.req.query("channel"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || !channel) return c.json({ ok: false, error: "Project not found" }, 404);
  const path = pathFor(project, channel);
  return c.json({ ok: true, ...currentBranch(path), branches: listBranches(path) });
});

// Switch to a branch (/branch <name>), create one (/branch -c <name>) or delete one (/branch -d <name>).
app.post("/api/agent/branch", async (c) => {
  const { projectId, name, action, channel: rawChannel } = await c.req.json();
  const channel = parseChannel(rawChannel);
  if (!projectId || !channel || typeof name !== "string" || !name.trim() || !["switch", "create", "delete"].includes(action)) {
    return c.json({ ok: false, error: "projectId, name and a valid action are required" }, 400);
  }

  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project) return c.json({ ok: false, error: "Project not found" }, 404);
  const path = pathFor(project, channel);
  if (isAgentRunning(path)) {
    return c.json({ ok: false, error: "The agent is running on this project. Stop it before changing branches." }, 409);
  }

  const run = action === "create" ? createBranch : action === "delete" ? deleteBranch : switchBranch;
  const result = run(path, name.trim());
  return c.json({ ...result, ...currentBranch(path) }, result.ok ? 200 : 400);
});

function parseChannel(raw: unknown): Channel | null {
  if (raw === undefined || raw === null || raw === "chat") return "chat";
  if (typeof raw === "string" && (raw === "marketing" || /^sub:\d+$/.test(raw))) return raw as Channel;
  return null;
}

// Claude sessions of this project, most recent first (/resume).
app.get("/api/agent/claude-sessions", (c) => {
  const projectId = Number(c.req.query("projectId"));
  const channel = parseChannel(c.req.query("channel"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || !channel) return c.json({ ok: false, error: "Project not found" }, 404);

  const current = agentSessions.get(sessionKey(projectId, channel))?.claudeSessionId ?? null;
  return c.json({ ok: true, current, sessions: listClaudeSessions(pathFor(project, channel), 10) });
});

// /plan: plan mode applies to the next messages of this conversation (read-only, the agent proposes a plan).
app.get("/api/agent/plan", (c) => {
  const projectId = Number(c.req.query("projectId"));
  const channel = parseChannel(c.req.query("channel"));
  if (!channel) return c.json({ ok: false, error: "Invalid channel" }, 400);
  return c.json({ ok: true, enabled: !!agentSessions.get(sessionKey(projectId, channel))?.planMode });
});

app.post("/api/agent/plan", async (c) => {
  const { projectId, channel: rawChannel, enabled } = await c.req.json();
  const channel = parseChannel(rawChannel);
  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project || !channel || typeof enabled !== "boolean") return c.json({ ok: false, error: "projectId, channel and enabled are required" }, 400);

  const session = getOrCreateSession(project.id, project.path, channel);
  session.planMode = enabled;
  return c.json({ ok: true, enabled });
});

// /clear: the next message starts a fresh Claude session. The conversation stays on screen.
app.post("/api/agent/clear", async (c) => {
  const { projectId, channel: rawChannel } = await c.req.json();
  const channel = parseChannel(rawChannel);
  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project || !channel) return c.json({ ok: false, error: "Project not found" }, 404);
  if (isAgentRunning(pathFor(project, channel))) return c.json({ ok: false, error: "The agent is running. Stop it first." }, 409);

  const session = agentSessions.get(sessionKey(project.id, channel)) ?? loadSessionFromDb(project.id, project.path, channel);
  if (session) {
    session.claudeSessionId = null;
    saveEventsNow(session);
  }
  return c.json({ ok: true });
});

// /resume <id>: the next message continues that Claude session.
app.post("/api/agent/resume", async (c) => {
  const { projectId, channel: rawChannel, sessionId } = await c.req.json();
  const channel = parseChannel(rawChannel);
  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project || !channel) return c.json({ ok: false, error: "Project not found" }, 404);
  const path = pathFor(project, channel);
  if (!isValidSessionId(sessionId) || !sessionFileExists(path, sessionId)) {
    return c.json({ ok: false, error: "Unknown session for this project." }, 404);
  }
  if (isAgentRunning(path)) return c.json({ ok: false, error: "The agent is running. Stop it first." }, 409);

  const session = getOrCreateSession(project.id, project.path, channel);
  session.claudeSessionId = sessionId;
  saveEventsNow(session);
  return c.json({ ok: true });
});

// Undo the changes of a turn (or of some of its files) on the working tree.
app.post("/api/agent/revert", async (c) => {
  const { projectId, fromSha, toSha, paths, hunk, channel: rawChannel } = await c.req.json();
  const channel = parseChannel(rawChannel);
  if (!projectId || !channel || !isValidSha(fromSha)) return c.json({ ok: false, error: "projectId and a valid fromSha are required" }, 400);
  if (toSha !== undefined && toSha !== null && !isValidSha(toSha)) return c.json({ ok: false, error: "Invalid toSha" }, 400);
  if (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !p || p.startsWith("-") || p.startsWith("/") || p.split("/").includes("..")))) {
    return c.json({ ok: false, error: "Invalid paths" }, 400);
  }

  const safePath = (p: unknown) => typeof p === "string" && !!p && !p.startsWith("-") && !p.startsWith("/") && !p.split("/").includes("..");
  if (hunk !== undefined && !(safePath(hunk?.path) && Number.isInteger(hunk?.index) && hunk.index >= 0 && typeof hunk?.header === "string" && hunk.header.startsWith("@@ ") && hunk.header.length < 500)) {
    return c.json({ ok: false, error: "Invalid hunk" }, 400);
  }

  const project = db.select().from(projects).where(eq(projects.id, Number(projectId))).get();
  if (!project) return c.json({ ok: false, error: "Project not found" }, 404);

  const path = pathFor(project, channel);
  if (isAgentRunning(path)) {
    return c.json({ ok: false, error: "The agent is running in this folder. Stop it before undoing changes." }, 409);
  }

  try {
    const result = hunk
      ? revertHunk(path, fromSha, toSha ?? undefined, hunk.path, hunk.index, hunk.header)
      : revertTurn(path, fromSha, toSha ?? undefined, paths);
    return c.json(result, result.ok ? 200 : 500);
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

app.post("/api/agent/rollback/force", async (c) => {
  const body = await c.req.json();
  const { projectId, snapshotSha, messageIndex, channel = "chat" } = body;

  if (!projectId || !snapshotSha) return c.json({ error: "projectId and snapshotSha required" }, 400);

  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ error: "No session found" }, 404);

  const result = rollbackToSnapshot(session.projectPath, snapshotSha);
  if (!result.ok) return c.json({ error: result.error }, 500);

  if (typeof messageIndex === "number" && messageIndex >= 0) {
    session.events = session.events.slice(0, messageIndex);
    saveEventsNow(session);
  }

  return c.json({ ok: true });
});

app.get("/api/agent/:projectId/status", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const channel = (c.req.query("channel") as Channel) || "chat";
  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ active: false, status: "none" });
  return c.json({
    active: session.status === "running",
    status: session.status,
    conversationId: session.conversationId,
    claudeSessionId: session.claudeSessionId,
    eventsCount: session.events.length,
  });
});

app.get("/api/agent/statuses", (c) => {
  const statuses: Record<number, string> = {};

  for (const [, session] of agentSessions) {
    if (session.channel !== "chat") continue;
    const projectId = session.projectId;
    if (session.status === "running") {
      statuses[projectId] = "running";
    } else if (session.events.length > 0) {
      const lastResult = [...session.events].reverse().find((e: any) => e.type === "result");
      statuses[projectId] = (lastResult as any)?.is_error ? "error" : "done";
    } else {
      statuses[projectId] = "idle";
    }
  }

  const allConvs = db
    .select()
    .from(conversations)
    .where(sql`channel = 'chat' AND events_json IS NOT NULL AND events_json != '[]'`)
    .all();

  for (const conv of allConvs) {
    if (!(conv.projectId in statuses)) {
      statuses[conv.projectId] = "done";
    }
  }

  return c.json(statuses);
});

app.use("/*", serveStatic({ root: STATIC_ROOT }));
app.get("/*", serveStatic({ root: STATIC_ROOT, path: "index.html" }));

export function startOverlordServer(port = PORT) {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🏰 Overlord running at http://localhost:${info.port}`);
    console.log(`📁 Workspace directory: ${getWorkspaceRoot()}`);
  });

  const wss = new WebSocketServer({ server: server as never, path: "/ws" });
  setWebSocketServer(wss);
  attachWsHandlers(wss);

  return { server, wss, port };
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  startOverlordServer();
}

export { app, PORT, STATIC_ROOT };
