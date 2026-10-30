import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// The CLI keeps one <session-id>.jsonl per conversation under
// ~/.claude/projects/<project path with every non-alphanumeric char turned into "-">.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024;

export interface ClaudeSessionInfo {
  id: string;
  updatedAt: number;
  title: string;
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function sessionsDir(projectPath: string): string {
  return join(homedir(), ".claude", "projects", projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function sessionFileExists(projectPath: string, id: string): boolean {
  return isValidSessionId(id) && existsSync(join(sessionsDir(projectPath), `${id}.jsonl`));
}

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

// Title the CLI generated, else the first thing the user typed. Only the head of
// the file is read: sessions can be several MB.
function sessionTitle(file: string): string | null {
  let firstPrompt: string | null = null;
  const lines = readHead(file).split("\n");
  lines.pop(); // last line may be cut off
  for (const line of lines) {
    if (line.includes('"type":"ai-title"')) {
      try {
        const t = JSON.parse(line).aiTitle;
        if (typeof t === "string" && t.trim()) return t.trim();
      } catch {}
    } else if (firstPrompt === null && line.includes('"type":"user"')) {
      try {
        const content = JSON.parse(line).message?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.find((b: { type?: string }) => b.type === "text")?.text
              : null;
        if (typeof text === "string" && text.trim() && !text.trim().startsWith("<")) {
          firstPrompt = text.trim().replace(/\s+/g, " ").slice(0, 80);
        }
      } catch {}
    }
  }
  return firstPrompt;
}

/** Most recently modified first. Sessions with no prompt at all (empty stubs) are skipped. */
export function listClaudeSessions(projectPath: string, limit = 10): ClaudeSessionInfo[] {
  const dir = sessionsDir(projectPath);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && isValidSessionId(n.slice(0, -6)));
  } catch {
    return [];
  }
  const files = names
    .map((n) => ({ id: n.slice(0, -6), updatedAt: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const out: ClaudeSessionInfo[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const title = sessionTitle(join(dir, `${f.id}.jsonl`));
    if (title) out.push({ ...f, title });
  }
  return out;
}
