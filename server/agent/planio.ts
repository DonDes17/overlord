import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";

// Planio tickets, read through the Planio connector of the user's Claude account (no API key to manage).
//
// Overlord's server cannot call that connector itself, so it runs a short headless `claude --print` whose
// only job is to call the Planio tools. What is used is never what the model writes back: it is the raw
// result of the tool call, which sits in the CLI's JSON output (Redmine's own JSON). Nothing is retyped,
// so nothing can be altered or cut. A call costs about a cent and takes 5 to 6 seconds.
//
// Read-only on purpose: Planio is visible to the user's clients, so no tool that writes is ever allowed here.

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const MODEL = process.env.OVERLORD_PLANIO_MODEL || "claude-haiku-5-5";
const TOOL_PREFIX = "mcp__claude_ai_Planio__";
const READ_TOOLS = ["get_user", "search_issues", "get_issue"].map((name) => TOOL_PREFIX + name);
const TIMEOUT_MS = 120_000;

// Caps on what gets copied into a conversation's context.
const MAX_DESCRIPTION = 8000;
const MAX_NOTE = 1500;
const MAX_NOTES = 10;

export interface PlanioTicket {
  id: number;
  subject: string;
  status: string;
  project: string;
  description: string;
}

export interface PlanioNote {
  author: string;
  date: string;
  text: string;
}

export interface PlanioTicketDetail extends PlanioTicket {
  notes: PlanioNote[];
}

interface ToolResult {
  name: string;
  isError: boolean;
  text: string;
  json: any | null;
}

type RunResult = { ok: true; results: ToolResult[] } | { ok: false; error: string };

const NOT_CONNECTED =
  "Le connecteur Planio n'a rien renvoyé. Vérifiez qu'il est connecté dans votre compte Claude (claude.ai, connecteurs) et que la session n'a pas expiré.";

/** Run one headless Claude call and collect the raw results of the tools it called. */
function runClaude(prompt: string, tools: string[] = READ_TOOLS): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, ["--print", "--model", MODEL, "--output-format", "json", "--allowedTools", ...tools, "--", prompt], {
      cwd: tmpdir(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => proc.kill("SIGTERM"), TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "La commande `claude` est introuvable." : String(err) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(parseOutput(stdout, stderr, code));
    });
  });
}

/** Exported for tests. */
export function parseOutput(stdout: string, stderr: string, code: number | null): RunResult {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `Réponse illisible de claude${code ? ` (code ${code})` : ""} : ${(stderr || stdout).slice(0, 300)}` };
  }
  const events: any[] = Array.isArray(parsed) ? parsed : [parsed];

  const final = [...events].reverse().find((e) => e?.type === "result");
  if (final?.is_error) return { ok: false, error: String(final.result ?? "Erreur de claude").slice(0, 400) };

  const names = new Map<string, string>();
  for (const e of events) {
    if (e?.type !== "assistant") continue;
    for (const block of e.message?.content ?? []) {
      if (block?.type === "tool_use") names.set(block.id, block.name);
    }
  }

  const results: ToolResult[] = [];
  for (const e of events) {
    if (e?.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block?.type !== "tool_result") continue;
      const raw = block.content;
      let text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((x: any) => x?.text ?? "").join("") : "";
      text = readPersisted(text) ?? text;
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      results.push({ name: names.get(block.tool_use_id) ?? "", isError: !!block.is_error, text, json });
    }
  }
  return { ok: true, results };
}

const MAX_PERSISTED_BYTES = 20 * 1024 * 1024;

/**
 * A tool result above the CLI's size limit is not returned: the CLI writes it to a file and returns a message
 * that names it. Two shapes, depending on the size:
 *   `<persisted-output> ... Full output saved to: <file>.json`            (the file holds the result's blocks)
 *   `Error: result (N characters ...) exceeds maximum allowed tokens. Output has been saved to <file>.txt.`
 *                                                                          (the file holds the result's text)
 * Only those two exact shapes are followed, and only to a file under ~/.claude (what the CLI itself wrote).
 * Exported for tests.
 */
export function readPersisted(text: string, claudeHome = join(homedir(), ".claude")): string | null {
  const persisted = text.startsWith("<persisted-output>");
  const tooLarge = text.startsWith("Error: result (") && text.includes("exceeds maximum allowed tokens");
  if (!persisted && !tooLarge) return null;
  const match = /saved to:? (\/\S+?\.(?:json|txt))(?=[.\s]|$)/.exec(text);
  if (!match) return null;
  const file = resolve(match[1]);
  if (!file.startsWith(resolve(claudeHome) + sep) || !existsSync(file) || statSync(file).size > MAX_PERSISTED_BYTES) return null;
  try {
    const raw = readFileSync(file, "utf8");
    if (!persisted) return raw;
    const content = JSON.parse(raw);
    return Array.isArray(content) ? content.map((x: any) => x?.text ?? "").join("") : raw;
  } catch {
    return null;
  }
}

const planioResults = (results: ToolResult[], tool: string) => results.filter((r) => r.name === TOOL_PREFIX + tool);

function failure(results: ToolResult[], tool: string): string {
  const err = planioResults(results, tool).find((r) => r.isError);
  return err ? `Planio a répondu par une erreur : ${err.text.slice(0, 300)}` : NOT_CONNECTED;
}

/** Exported for tests: raw Redmine issue -> what Overlord keeps. */
export function toTicket(issue: any): PlanioTicket | null {
  if (!Number.isInteger(issue?.id) || issue.id <= 0 || typeof issue.subject !== "string") return null;
  return {
    id: issue.id,
    subject: issue.subject,
    status: typeof issue.status?.name === "string" ? issue.status.name : "",
    project: typeof issue.project?.name === "string" ? issue.project.name : "",
    description: typeof issue.description === "string" ? issue.description : "",
  };
}

// A page is the full text of its tickets (about 2 KB each). One page of 100 is a single call; the result is
// then above the CLI's size limit and comes back as a file, which readPersisted() reads (see above).
// Bounded, so that a very large backlog cannot run for minutes.
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

/** Open tickets assigned to the user, most recently updated first. `total` is Planio's own count. */
export async function fetchMyOpenTickets(): Promise<{ ok: true; tickets: PlanioTicket[]; total: number } | { ok: false; error: string }> {
  const run = await runClaude(
    "Planio. 1) Appelle get_user pour connaître mon identifiant. 2) Appelle search_issues avec : tickets assignés à moi, " +
      `statut ouvert (open), triés par date de mise à jour décroissante, limit = ${PAGE_SIZE}, offset = 0. ` +
      `3) Tant que offset + ${PAGE_SIZE} < total_count, rappelle search_issues avec offset augmenté de ${PAGE_SIZE} ` +
      `(${MAX_PAGES} appels au plus au total). Un résultat très volumineux est enregistré dans un fichier : c'est normal, ` +
      "ne le lis pas, n'utilise aucun autre outil et passe à l'étape suivante. N'écris aucun commentaire : réponds seulement « ok »."
  );
  if (!run.ok) return run;

  const pages = planioResults(run.results, "search_issues").filter((r) => Array.isArray(r.json?.issues));
  if (pages.length === 0) return { ok: false, error: failure(run.results, "search_issues") };

  const seen = new Set<number>();
  const tickets: PlanioTicket[] = [];
  let total = 0;
  for (const page of pages) {
    total = Math.max(total, Number(page.json.total_count) || 0);
    for (const issue of page.json.issues) {
      const ticket = toTicket(issue);
      if (ticket && !seen.has(ticket.id)) {
        seen.add(ticket.id);
        tickets.push(ticket);
      }
    }
  }
  return { ok: true, tickets, total: Math.max(total, tickets.length) };
}

/** One ticket with its public notes. */
export async function fetchTicket(id: number): Promise<{ ok: true; ticket: PlanioTicketDetail } | { ok: false; error: string }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Numéro de ticket invalide." };
  const run = await runClaude(`Planio : appelle get_issue pour le ticket ${id} en incluant ses notes (journals). N'écris aucun commentaire : réponds seulement « ok ».`);
  if (!run.ok) return run;

  const found = planioResults(run.results, "get_issue").find((r) => r.json?.issue);
  const base = found ? toTicket(found.json.issue) : null;
  if (!found || !base) return { ok: false, error: failure(run.results, "get_issue") };

  const notes: PlanioNote[] = (found.json.issue.journals ?? [])
    // Private notes are internal to the team: they are not copied anywhere.
    .filter((j: any) => typeof j?.notes === "string" && j.notes.trim() && !j.private_notes)
    .map((j: any) => ({ author: String(j.user?.name ?? ""), date: String(j.created_on ?? ""), text: j.notes.trim() }))
    .slice(-MAX_NOTES);
  return { ok: true, ticket: { ...base, notes } };
}

/** Branch name in the user's convention: `6929-dedoublonner-les-appels-api`. */
export function ticketBranchName(id: number, subject: string): string {
  let slug = subject
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*(\[[^\]]*\]\s*)+/, "") // leading tags such as "[PROJET PRO]"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 50) {
    // Cut on a word boundary: `...auto-evaluatio` helps nobody.
    slug = slug.slice(0, 50);
    const cut = slug.lastIndexOf("-");
    if (cut > 10) slug = slug.slice(0, cut);
  }
  return slug ? `${id}-${slug}` : String(id);
}

export function ticketUrl(baseUrl: string | null, id: number | string): string | null {
  return baseUrl ? `${baseUrl}/issues/${id}` : null;
}

/** What the branch's agent is told about the ticket (injected as background context). */
export function buildTicketContext(ticket: PlanioTicketDetail, url: string | null): string {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[...]` : text);
  const lines = [
    `Ticket Planio #${ticket.id} : ${ticket.subject}`,
    `Projet : ${ticket.project || "?"} · Statut : ${ticket.status || "?"}${url ? ` · ${url}` : ""}`,
    "",
    "Description :",
    ticket.description.trim() ? cut(ticket.description.trim(), MAX_DESCRIPTION) : "(vide)",
  ];
  if (ticket.notes.length > 0) {
    lines.push("", "Notes (les plus récentes en dernier) :");
    for (const note of ticket.notes) lines.push(`- ${note.author}, ${note.date.slice(0, 10)} : ${cut(note.text, MAX_NOTE)}`);
  }
  return lines.join("\n");
}
