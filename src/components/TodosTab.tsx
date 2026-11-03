import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useApi, post, patch } from "../hooks/useApi.js";
import type { Project, SubConversation, Todo } from "../types.js";
import { Play, Trash2, Check, Plus, RefreshCw, GitBranch, ExternalLink, Loader2 } from "lucide-react";

interface Props {
  project: Project;
  onSendToChat: (message: string) => void;
  /** A ticket was started in its own worktree: the new branch conversation. */
  onTicketStarted?: (conversation: SubConversation) => void;
}

interface SyncResult {
  ok: boolean;
  error?: string;
  needsMapping?: boolean;
  available?: { name: string; count: number }[];
  imported?: number;
  updated?: number;
  gone?: number;
  partial?: boolean;
  fetched?: number;
  total?: number;
}

export function TodosTab({ project, onSendToChat, onTicketStarted }: Props) {
  const { data: todos, refetch } = useApi<Todo[]>(`/todos/${project.id}`);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [startError, setStartError] = useState<string | null>(null);

  const handleAdd = useCallback(async () => {
    if (!newTitle.trim()) return;
    await post("/todos", {
      projectId: project.id,
      title: newTitle.trim(),
      description: newDesc.trim() || null,
    });
    setNewTitle("");
    setNewDesc("");
    setShowForm(false);
    refetch();
  }, [newTitle, newDesc, project.id, refetch]);

  const handleToggle = useCallback(
    async (todo: Todo) => {
      await patch(`/todos/${todo.id}`, { done: !todo.done });
      refetch();
    },
    [refetch]
  );

  const handleDelete = useCallback(
    async (id: number) => {
      await fetch(`/api/todos/${id}`, { method: "DELETE" });
      refetch();
    },
    [refetch]
  );

  const handleLaunch = useCallback(
    (todo: Todo) => {
      const message = todo.description
        ? `${todo.title}\n\n${todo.description}`
        : todo.title;
      onSendToChat(message);
    },
    [onSendToChat]
  );

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSync(null);
    try {
      const res = await post<SyncResult>("/planio/sync", { projectId: project.id });
      setSync(res);
      setChosen(new Set());
      refetch();
    } catch (err) {
      setSync({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSyncing(false);
    }
  }, [project.id, refetch]);

  const saveMapping = useCallback(async () => {
    await patch(`/projects/${project.id}`, { planioProject: [...chosen].join(", ") });
    runSync();
  }, [chosen, project.id, runSync]);

  const startTicket = useCallback(
    async (todo: Todo) => {
      setStarting(todo.id);
      setStartError(null);
      try {
        const res = await post<{ ok: boolean; error?: string; warning?: string; conversation?: any }>("/planio/start", { todoId: todo.id });
        if (!res.ok || !res.conversation) {
          setStartError(res.error ?? "Impossible de démarrer le ticket.");
          return;
        }
        if (res.warning) setStartError(res.warning);
        const c = res.conversation;
        onTicketStarted?.({
          id: c.id,
          projectId: c.projectId,
          title: c.title ?? null,
          contextText: c.contextText ?? null,
          parentConversationId: c.parentConversationId ?? null,
          createdAt: c.createdAt,
          unread: false,
          running: false,
          hasEvents: false,
          preview: "",
          worktreeBranch: c.worktreeBranch ?? null,
          worktreePath: c.worktreePath ?? null,
          worktree: null,
          ticketId: c.ticketId ?? null,
          ticketSubject: c.ticketSubject ?? null,
          ticketUrl: c.ticketUrl ?? null,
        });
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
      } finally {
        setStarting(null);
      }
    },
    [onTicketStarted]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAdd();
    }
  };

  const pending = todos?.filter((t) => !t.done) ?? [];
  const done = todos?.filter((t) => t.done) ?? [];

  return (
    <div className="flex w-full flex-col gap-4 p-6">
      {/* Header + Add button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Todos ({pending.length} pending)
        </h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs"
            onClick={runSync}
            disabled={syncing}
            title="Importe mes tickets Planio ouverts (lecture seule, via le connecteur Claude)"
          >
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {syncing ? "Synchronisation…" : "Sync Planio"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs"
            onClick={() => setShowForm((v) => !v)}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>
      </div>

      {sync && (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4 text-xs">
            {!sync.ok ? (
              <p className="text-destructive">{sync.error ?? "Échec de la synchronisation."}</p>
            ) : sync.needsMapping ? (
              <>
                <p>
                  Quels projets Planio correspondent à <span className="font-medium">{project.name}</span> ? Seuls leurs tickets seront importés.
                </p>
                <div className="flex flex-col gap-1.5">
                  {(sync.available ?? []).map((p) => (
                    <label key={p.name} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={chosen.has(p.name)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(p.name);
                          else next.delete(p.name);
                          setChosen(next);
                        }}
                      />
                      <span>{p.name}</span>
                      <span className="text-muted-foreground">({p.count})</span>
                    </label>
                  ))}
                </div>
                <div>
                  <Button size="sm" className="text-xs" disabled={chosen.size === 0} onClick={saveMapping}>
                    Importer
                  </Button>
                </div>
              </>
            ) : (
              <p>
                {sync.imported} importé(s), {sync.updated} mis à jour
                {sync.gone ? `, ${sync.gone} plus dans mes tickets ouverts` : ""}.
              </p>
            )}
            {sync.ok && sync.partial && (
              <p className="text-amber-500">
                Liste partielle : {sync.fetched} tickets lus sur {sync.total}. Les plus récemment modifiés sont d'abord.
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {startError && <p className="text-xs text-amber-500">{startError}</p>}

      {/* New todo form */}
      {showForm && (
        <Card>
          <CardContent className="pt-4 flex flex-col gap-3">
            <Input
              placeholder="Task title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <Textarea
              placeholder="Description / details (optional)..."
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              className="min-h-[80px] resize-none"
            />
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={!newTitle.trim()}
              >
                Add
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Pending todos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pending ({pending.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {pending.length === 0 ? (
              <p className="text-sm italic text-muted-foreground py-8 text-center">
                No tasks. Add ideas and todos for this project.
              </p>
            ) : (
              pending.map((todo) => (
                <Card key={todo.id} className="group">
                  <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => handleToggle(todo)}
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border hover:bg-accent"
                    >
                      {todo.done && <Check className="h-3 w-3" />}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{todo.title}</div>
                      {todo.source === "planio" && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono">#{todo.externalId}</span>
                          {todo.externalStatus ? (
                            <span>{todo.externalStatus}</span>
                          ) : (
                            <span className="text-amber-500">plus dans mes tickets ouverts</span>
                          )}
                          {todo.externalUrl && (
                            <a href={todo.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                              <ExternalLink className="h-3 w-3" />
                              Planio
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      {todo.source === "planio" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 px-2.5 text-xs"
                          onClick={() => startTicket(todo)}
                          disabled={starting !== null}
                          title="Crée un worktree et une branche nommée d'après le ticket"
                        >
                          {starting === todo.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                          Worktree
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 gap-1.5 px-2.5 text-xs"
                        onClick={() => handleLaunch(todo)}
                        title="Send to chat"
                      >
                        <Play className="h-3 w-3" />
                        Start
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(todo.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                    {todo.description && (
                      <>
                        <p
                          className={cn(
                            "mt-2 ml-8 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words",
                            !expanded.has(todo.id) && "line-clamp-3"
                          )}
                        >
                          {todo.description}
                        </p>
                        {(todo.description.length > 200 || todo.description.split("\n").length > 3) && (
                          <button
                            className="mt-1 ml-8 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (!next.delete(todo.id)) next.add(todo.id);
                                return next;
                              })
                            }
                          >
                            {expanded.has(todo.id) ? "Réduire" : "Voir plus"}
                          </button>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </CardContent>
        </Card>

        {/* Done todos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Done ({done.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {done.length === 0 ? (
              <p className="text-sm italic text-muted-foreground py-8 text-center">
                No completed tasks yet.
              </p>
            ) : (
              done.map((todo) => (
                <Card key={todo.id} className="group opacity-50">
                  <CardContent className="flex items-start gap-3 py-3 px-4">
                    <button
                      onClick={() => handleToggle(todo)}
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-primary/20"
                    >
                      <Check className="h-3 w-3 text-primary" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm line-through">{todo.title}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                      onClick={() => handleDelete(todo.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
