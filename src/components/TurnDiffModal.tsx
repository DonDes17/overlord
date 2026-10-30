import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { html as renderDiff } from "diff2html";
import type { ColorSchemeType } from "diff2html/lib/types";
import { X, Columns2, Rows2, Loader2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DiffFileStat {
  path: string;
  oldPath?: string;
  added: number;
  deleted: number;
  binary: boolean;
  lockfile: boolean;
}

interface DiffResponse {
  ok: boolean;
  error?: string;
  files?: DiffFileStat[];
  patch?: string;
  truncated?: boolean;
  toWorkingTree?: boolean;
}

type Layout = "side-by-side" | "line-by-line";
const LAYOUT_KEY = "overlord:diff-layout";

function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === "side-by-side" || v === "line-by-line") return v;
  } catch {}
  return "side-by-side";
}

export function TurnDiffModal({
  projectId,
  channel,
  fromSha,
  toSha,
  onClose,
  onReverted,
}: {
  projectId: number;
  /** Conversation the turn belongs to: a branch may work in its own worktree. */
  channel: string;
  fromSha: string;
  toSha?: string;
  onClose: () => void;
  /** Called after any successful undo (turn, file or block), so the caller can refresh its numbers. */
  onReverted?: () => void;
}) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [layout, setLayout] = useState<Layout>(readLayout);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [reload, setReload] = useState(0);
  // Undo needs a second click: holds "turn" or the path waiting for confirmation.
  const [confirm, setConfirm] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, channel, fromSha, toSha }),
    })
      .then((r) => r.json())
      .then((d: DiffResponse) => !cancelled && setData(d))
      .catch((err) => !cancelled && setData({ ok: false, error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, channel, fromSha, toSha, reload]);

  // Blocks already undone: for a past turn the diff is between two fixed snapshots and does not
  // change after an undo, so the button must say so instead of offering the same undo again.
  const undoneHunks = useRef(new Set<string>());
  const armed = useRef<{ btn: HTMLButtonElement; timer: number } | null>(null);

  const disarm = () => {
    if (!armed.current) return;
    window.clearTimeout(armed.current.timer);
    armed.current.btn.dataset.confirm = "";
    armed.current.btn.textContent = "↶ Undo block";
    armed.current.btn.classList.remove("hunk-undo-confirm");
    armed.current = null;
  };

  const undoHunk = async (btn: HTMLButtonElement) => {
    const { path, index, header } = btn.dataset;
    disarm();
    setUndoing(true);
    setUndoError(null);
    try {
      const r = await fetch("/api/agent/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, channel, fromSha, toSha, hunk: { path, index: Number(index), header } }),
      });
      const d = await r.json();
      if (!d.ok) setUndoError(d.error ?? "Undo failed.");
      else {
        undoneHunks.current.add(`${path}#${header}`);
        setReload((n) => n + 1);
        onReverted?.();
      }
    } catch (err) {
      setUndoError(String(err));
    } finally {
      setUndoing(false);
    }
  };

  const onDiffClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".hunk-undo");
    if (!btn || btn.disabled || undoing) return;
    if (btn.dataset.confirm === "1") {
      void undoHunk(btn);
      return;
    }
    // First click arms the button; it disarms itself after a few seconds.
    disarm();
    btn.dataset.confirm = "1";
    btn.textContent = "Click again to confirm";
    btn.classList.add("hunk-undo-confirm");
    armed.current = { btn, timer: window.setTimeout(disarm, 4000) };
  };

  const undo = async (key: string, paths?: string[]) => {
    if (confirm !== key) {
      setConfirm(key);
      setUndoError(null);
      return;
    }
    setConfirm(null);
    setUndoing(true);
    try {
      const r = await fetch("/api/agent/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, channel, fromSha, toSha, paths }),
      });
      const d = await r.json();
      if (!d.ok) setUndoError(d.error ?? "Undo failed.");
      else {
        setReload((n) => n + 1);
        onReverted?.();
      }
    } catch (err) {
      setUndoError(String(err));
    } finally {
      setUndoing(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {}
  }, [layout]);

  const rendered = useMemo(() => {
    if (!data?.patch) return "";
    const dark = document.documentElement.classList.contains("dark");
    return renderDiff(data.patch, {
      outputFormat: layout,
      drawFileList: false,
      matching: "lines",
      diffStyle: "word",
      colorScheme: (dark ? "dark" : "light") as ColorSchemeType,
    });
  }, [data?.patch, layout]);

  // diff2html cannot add buttons to its hunk headers, so they are injected after each render.
  // A block is addressed by its position in the file and its header; the server checks both.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    // Renamed files show "old → new" in the header and are not in this list: no per-block undo for them.
    const known = new Set((data?.files ?? []).filter((f) => !f.binary && !f.lockfile).map((f) => f.path));
    root.querySelectorAll<HTMLElement>(".d2h-file-wrapper").forEach((wrapper) => {
      const path = wrapper.querySelector(".d2h-file-name")?.textContent?.trim() ?? "";
      if (!known.has(path)) return;
      // Side by side draws two tables with the same headers: the first one is enough.
      const table = wrapper.querySelector(".d2h-file-side-diff, .d2h-file-diff");
      table?.querySelectorAll<HTMLElement>("td.d2h-info:not([class*=linenumber]) :is(.d2h-code-line, .d2h-code-side-line)").forEach((line, index) => {
        let btn = line.querySelector<HTMLButtonElement>(".hunk-undo");
        if (!btn) {
          const header = line.textContent?.trim() ?? "";
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = "hunk-undo";
          btn.title = "Revert this block only";
          btn.textContent = "↶ Undo block";
          Object.assign(btn.dataset, { path, index: String(index), header });
          line.appendChild(btn);
        }
        if (undoneHunks.current.has(`${path}#${btn.dataset.header}`)) {
          btn.disabled = true;
          btn.textContent = "✓ Undone";
        }
      });
    });
  }, [rendered, data?.files]);

  const files = data?.files ?? [];
  const totals = files.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), { added: 0, deleted: 0 });

  // diff2html gives each file wrapper an id, but not one we can predict from the
  // path, so jump by matching the file name shown in each header.
  const scrollToFile = (path: string) => {
    const root = bodyRef.current;
    if (!root) return;
    const headers = Array.from(root.querySelectorAll<HTMLElement>(".d2h-file-wrapper"));
    const target = headers.find((el) => el.querySelector(".d2h-file-name")?.textContent?.trim().endsWith(path));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return createPortal(
    <div className="desktop-titlebar-no-drag fixed inset-0 z-50 flex bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-[1600px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold">Changes in this turn</span>
          {data?.ok && (
            <span className="text-xs text-muted-foreground">
              {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
              <span className="text-green-500">+{totals.added}</span>{" "}
              <span className="text-red-500">−{totals.deleted}</span>
              {data.toWorkingTree && " · up to the current working tree"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {files.length > 0 && (
              <button
                onClick={() => undo("turn")}
                disabled={undoing}
                className={cn(
                  "mr-2 flex h-8 items-center gap-1.5 rounded px-3 text-xs hover:bg-secondary disabled:opacity-50",
                  confirm === "turn" && "bg-destructive text-destructive-foreground hover:bg-destructive"
                )}
                title="Revert every file of this turn"
              >
                <Undo2 className="h-3.5 w-3.5" /> {confirm === "turn" ? "Click again to confirm" : "Undo turn"}
              </button>
            )}
            <button
              onClick={() => setLayout("side-by-side")}
              className={cn("flex h-8 items-center gap-1.5 rounded px-3 text-xs hover:bg-secondary", layout === "side-by-side" && "bg-secondary")}
              title="Side by side"
            >
              <Columns2 className="h-3.5 w-3.5" /> Split
            </button>
            <button
              onClick={() => setLayout("line-by-line")}
              className={cn("flex h-8 items-center gap-1.5 rounded px-3 text-xs hover:bg-secondary", layout === "line-by-line" && "bg-secondary")}
              title="Unified"
            >
              <Rows2 className="h-3.5 w-3.5" /> Unified
            </button>
            <button onClick={onClose} className="ml-2 flex h-8 w-8 items-center justify-center rounded hover:bg-secondary" title="Close (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {undoError && (
          <p className="whitespace-pre-wrap border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">{undoError}</p>
        )}

        {!data && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Computing diff…
          </div>
        )}

        {data && !data.ok && (
          <div className="flex-1 p-6 text-sm text-destructive">{data.error ?? "Could not compute the diff."}</div>
        )}

        {data?.ok && files.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No file changes in this turn.</div>
        )}

        {data?.ok && files.length > 0 && (
          <div className="flex min-h-0 flex-1">
            <aside className="w-72 shrink-0 overflow-y-auto border-r border-border py-2 text-xs">
              {files.map((f) => (
                <div key={f.path} className="group flex items-center hover:bg-secondary">
                <button
                  onClick={() => !f.lockfile && !f.binary && scrollToFile(f.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                  title={f.path}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    <span className="text-muted-foreground">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : ""}</span>
                    {f.path.slice(f.path.lastIndexOf("/") + 1)}
                  </span>
                  {f.binary ? (
                    <span className="text-muted-foreground">bin</span>
                  ) : (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-green-500">+{f.added}</span> <span className="text-red-500">−{f.deleted}</span>
                    </span>
                  )}
                </button>
                <button
                  onClick={() => undo(f.path, f.oldPath ? [f.oldPath, f.path] : [f.path])}
                  disabled={undoing}
                  className={cn(
                    "flex min-w-9 shrink-0 self-stretch items-center justify-center px-2 text-[11px] opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50",
                    confirm === f.path && "bg-destructive text-destructive-foreground opacity-100 hover:bg-destructive"
                  )}
                  title="Revert this file"
                >
                  {confirm === f.path ? "Confirm?" : <Undo2 className="h-3 w-3" />}
                </button>
                </div>
              ))}
              {files.some((f) => f.lockfile) && (
                <p className="px-3 pt-3 text-[11px] text-muted-foreground">Lockfiles are counted but not shown.</p>
              )}
            </aside>
            <div ref={bodyRef} className="min-w-0 flex-1 overflow-auto p-3">
              {data.truncated && (
                <p className="mb-3 rounded border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground">
                  The diff is too large and was cut. Open the project in your editor to see the rest.
                </p>
              )}
              <div className="overlord-diff text-xs" onClick={onDiffClick} dangerouslySetInnerHTML={{ __html: rendered }} />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
