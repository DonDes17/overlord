import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { GitBranch, Loader2 } from "lucide-react";

const WORKTREE_KEY = "overlord:branch-worktree";

function readWorktreeDefault(): boolean {
  try {
    return localStorage.getItem(WORKTREE_KEY) === "1";
  } catch {
    return false;
  }
}

interface Props {
  title: string;
  /** Resolves with an error message to show in the dialog, or null when the branch was created. */
  onConfirm: (opts: { worktree: false } | { worktree: { name: string } }) => Promise<string | null>;
  onCancel: () => void;
}

// Asked before spinning off a branch: optionally give it its own git worktree, so it can run in
// parallel with other branches without touching the same files.
export function NewBranchDialog({ title, onConfirm, onCancel }: Props) {
  const [worktree, setWorktree] = useState(readWorktreeDefault);
  const [name, setName] = useState(title.slice(0, 40));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(WORKTREE_KEY, worktree ? "1" : "0");
    } catch {}
    const err = await onConfirm(worktree ? { worktree: { name: name.trim() || title } } : { worktree: false });
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} className="flex max-w-md flex-col gap-4 p-5 sm:max-w-md">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">New branch</h2>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
            className="mt-1 h-4 w-4 accent-primary"
          />
          <span>
            Isoler dans un worktree
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Dossier et branche git dédiés : cette branche peut tourner en parallèle d'une autre sans modifier les mêmes fichiers.
            </span>
          </span>
        </label>

        {worktree && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="worktree-name">Nom de la branche git (overlord/…)</label>
            <Input id="worktree-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && submit()} autoFocus />
          </div>
        )}

        {error && <p className="whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
