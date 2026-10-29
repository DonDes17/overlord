import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { html as renderDiff } from "diff2html";
import type { ColorSchemeType } from "diff2html/lib/types";
import { X, Columns2, Rows2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DiffFileStat {
  path: string;
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
  fromSha,
  toSha,
  onClose,
}: {
  projectId: number;
  fromSha: string;
  toSha?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [layout, setLayout] = useState<Layout>(readLayout);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, fromSha, toSha }),
    })
      .then((r) => r.json())
      .then((d: DiffResponse) => !cancelled && setData(d))
      .catch((err) => !cancelled && setData({ ok: false, error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, fromSha, toSha]);

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
    <div className="fixed inset-0 z-50 flex bg-black/60 p-4" onMouseDown={onClose}>
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
            <button
              onClick={() => setLayout("side-by-side")}
              className={cn("flex h-7 items-center gap-1 rounded px-2 text-xs hover:bg-secondary", layout === "side-by-side" && "bg-secondary")}
              title="Side by side"
            >
              <Columns2 className="h-3.5 w-3.5" /> Split
            </button>
            <button
              onClick={() => setLayout("line-by-line")}
              className={cn("flex h-7 items-center gap-1 rounded px-2 text-xs hover:bg-secondary", layout === "line-by-line" && "bg-secondary")}
              title="Unified"
            >
              <Rows2 className="h-3.5 w-3.5" /> Unified
            </button>
            <button onClick={onClose} className="ml-2 flex h-7 w-7 items-center justify-center rounded hover:bg-secondary" title="Close (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

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
                <button
                  key={f.path}
                  onClick={() => !f.lockfile && !f.binary && scrollToFile(f.path)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-secondary"
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
              <div className="overlord-diff text-xs" dangerouslySetInnerHTML={{ __html: rendered }} />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
