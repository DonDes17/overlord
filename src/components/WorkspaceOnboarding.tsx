import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type WorkspaceOnboardingProps = {
  initialPath: string;
  onComplete: () => void | Promise<void>;
  onCancel?: () => void;
};

type OverlordDesktopBridge = {
  isDesktop: boolean;
  selectDirectory?: () => Promise<string | null>;
};

function getDesktopBridge() {
  return (window as Window & { overlordDesktop?: OverlordDesktopBridge }).overlordDesktop;
}

export function WorkspaceOnboarding({ initialPath, onComplete, onCancel }: WorkspaceOnboardingProps) {
  const [path, setPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = useMemo(getDesktopBridge, []);

  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  async function chooseFolder() {
    const selected = await desktop?.selectDirectory?.();
    if (selected) {
      setPath(selected);
      setError(null);
    }
  }

  async function saveWorkspace() {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/settings/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Unable to save workspace path.");
        return;
      }

      await onComplete();
    } catch {
      setError("Unable to save workspace path.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="desktop-titlebar-no-drag fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-6 backdrop-blur-xl">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-6 flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-secondary">
            <FolderOpen className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Choose your global workspace</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Overlord will scan this folder to find projects and create new ones.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-root">
            Workspace path
          </label>
          <div className="flex gap-2">
            <Input
              id="workspace-root"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setError(null);
              }}
              placeholder="/Users/you/Developer"
              className="h-9"
              autoFocus
            />
            {desktop?.selectDirectory && (
              <Button type="button" variant="outline" className="h-9" onClick={chooseFolder}>
                Browse
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="button" onClick={saveWorkspace} disabled={saving || !path.trim()}>
            {saving ? "Saving..." : onCancel ? "Save workspace" : "Start using Overlord"}
          </Button>
        </div>
      </div>
    </div>
  );
}
