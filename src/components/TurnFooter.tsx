import { useEffect, useRef, useState } from "react";
import { FileDiff, Undo2 } from "lucide-react";
import { TurnDiffModal } from "./TurnDiffModal.js";

interface FileStat {
  path: string;
  added: number;
  deleted: number;
}

// Summary line under the last message of a turn that changed files: what changed, and the two things you
// can do about it, without having to hover the message above to find the icons.
export function TurnFooter({
  projectId,
  channel,
  fromSha,
  toSha,
  settled,
  onGrow,
}: {
  projectId: number;
  channel: string;
  fromSha: string;
  /** Snapshot of the next message; absent for the latest turn (its diff goes to the working tree). */
  toSha?: string;
  /** The agent is idle: the latest turn is finished and its numbers will not move any more. */
  settled: boolean;
  /** Called when the footer appears or changes height, so the chat can stay pinned to the bottom. */
  onGrow?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [files, setFiles] = useState<FileStat[] | null>(null);
  const [reload, setReload] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Numbers are fetched once the footer is on screen: a long history must not run one git diff per turn.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "300px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !settled) return;
    let cancelled = false;
    fetch("/api/agent/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, channel, fromSha, toSha, statsOnly: true }),
    })
      .then((r) => r.json())
      .then((d) => !cancelled && setFiles(d.ok ? d.files : []))
      .catch(() => !cancelled && setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [visible, settled, projectId, channel, fromSha, toSha, reload]);

  // The confirmation disarms itself, like the other undo buttons.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const undoTurn = async () => {
    if (!confirming) {
      setConfirming(true);
      setError(null);
      return;
    }
    setConfirming(false);
    setBusy(true);
    try {
      const r = await fetch("/api/agent/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, channel, fromSha, toSha }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error ?? "Undo failed.");
      else if (toSha) setUndone(true); // a past turn's diff is between two fixed snapshots: it will not change
      else setReload((n) => n + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = !!files && files.length > 0;
  useEffect(() => {
    if (shown) onGrow?.();
  }, [shown, undone, error, onGrow]);

  if (!files || files.length === 0) return <div ref={ref} />;

  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {files.length} file{files.length === 1 ? "" : "s"} changed <span className="text-success">+{added}</span>{" "}
        <span className="text-destructive">−{deleted}</span>
      </span>
      <button onClick={() => setShowDiff(true)} className="flex items-center gap-1 hover:text-foreground">
        <FileDiff className="h-3.5 w-3.5" /> View diff
      </button>
      {undone ? (
        <span>✓ Undone</span>
      ) : (
        <button
          onClick={undoTurn}
          disabled={busy}
          className={confirming ? "flex items-center gap-1 text-destructive" : "flex items-center gap-1 hover:text-foreground disabled:opacity-50"}
        >
          <Undo2 className="h-3.5 w-3.5" /> {confirming ? "Click again to confirm" : "Undo turn"}
        </button>
      )}
      {error && <span className="whitespace-pre-wrap text-destructive">{error}</span>}
      {showDiff && (
        <TurnDiffModal
          projectId={projectId}
          channel={channel}
          fromSha={fromSha}
          toSha={toSha}
          onClose={() => setShowDiff(false)}
          onReverted={() => (toSha ? undefined : setReload((n) => n + 1))}
        />
      )}
    </div>
  );
}
