import { useState, useCallback, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Check, Trash2, BookOpen, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { Project, Learning } from "../types.js";
import { useApi, patch } from "../hooks/useApi.js";
import { MarkdownContent } from "./MarkdownContent.js";

interface ProjectWithSummary extends Project {
  summary: string | null;
  lastSummaryAt: string | null;
}

interface Conversation {
  id: number;
  title: string | null;
  createdAt: string;
}

interface Props {
  project: Project;
}

export function SummaryTab({ project }: Props) {
  const { data: fullProject } = useApi<ProjectWithSummary>(
    `/projects/${project.id}`
  );
  const { data: conversations } = useApi<Conversation[]>(
    `/conversations/${project.id}`
  );

  const summary = fullProject?.summary;
  const lastSummaryAt = fullProject?.lastSummaryAt;

  return (
    <div className="flex w-full flex-col gap-4 p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Project summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Project Summary</CardTitle>
              {lastSummaryAt && (
                <CardDescription className="text-xs">
                  Updated on{" "}
                  {new Date(lastSummaryAt).toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              {summary ? (
                <p className="max-h-[260px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
                  {summary}
                </p>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  No summary available. The summary will be generated automatically after your next conversation with Claude.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent Conversations</CardTitle>
            </CardHeader>
            <CardContent>
              {conversations && conversations.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {conversations.slice(0, 5).map((c) => (
                    <div
                      key={c.id}
                      className="flex gap-3 border-b border-border py-2 last:border-0"
                    >
                      <span className="min-w-[120px] shrink-0 text-xs text-muted-foreground">
                        {new Date(c.createdAt).toLocaleDateString("en-US", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="truncate text-sm text-foreground/70">
                        {c.title ?? "Untitled session"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  No conversations.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex w-full flex-col gap-4 xl:w-[360px] xl:shrink-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Project Path</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="break-all font-mono text-xs leading-relaxed text-foreground/70">
                {project.path}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Project Stats</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Conversations</span>
                  <span>{conversations?.length ?? 0}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Created on</span>
                  <span className="text-right text-foreground/70">
                    {new Date(project.createdAt).toLocaleDateString("en-US", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Session learnings */}
      <LearningsSection project={project} />
    </div>
  );
}

function LearningsSection({ project }: { project: Project }) {
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const fetchLearnings = useCallback(async () => {
    const res = await fetch(`/api/learnings/${project.id}`);
    setLearnings(await res.json());
  }, [project.id]);

  useEffect(() => {
    fetchLearnings();
    // Poll-less approach: listen to learnings:done via WS is already done in ChatTab.
    // Re-fetch periodically while on this tab (every 30s) in case user doesn't switch tabs.
    const interval = setInterval(fetchLearnings, 30000);
    return () => clearInterval(interval);
  }, [fetchLearnings]);

  const handleMarkReviewed = useCallback(async (id: number, reviewed: boolean) => {
    await patch(`/learnings/${id}`, { reviewed });
    fetchLearnings();
  }, [fetchLearnings]);

  const handleDelete = useCallback(async (id: number) => {
    await fetch(`/api/learnings/${id}`, { method: "DELETE" });
    fetchLearnings();
  }, [fetchLearnings]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const res = await fetch(`/api/learnings/${project.id}/export`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setExportResult(`Exported to .claude/skills/project-learnings/`);
      } else {
        setExportResult(`Error: ${data.error}`);
      }
    } finally {
      setExporting(false);
      fetchLearnings();
    }
  }, [project.id, fetchLearnings]);

  const unreviewedCount = learnings.filter((l) => !l.reviewed).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            Session learnings
            {unreviewedCount > 0 && (
              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                {unreviewedCount} new
              </Badge>
            )}
          </CardTitle>
          {learnings.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              onClick={handleExport}
              disabled={exporting}
            >
              <Download className="h-3 w-3" />
              {exporting ? "Exporting..." : "Export as skill"}
            </Button>
          )}
        </div>
        <CardDescription className="text-xs">
          Auto-generated learnings after each session: dead ends, missing context, and recommendations for your CLAUDE.md/skills.
        </CardDescription>
        {exportResult && (
          <p className="text-[11px] text-muted-foreground mt-1">{exportResult}</p>
        )}
      </CardHeader>
      <CardContent>
        {learnings.length === 0 ? (
          <p className="text-xs italic text-muted-foreground py-4 text-center">
            No learnings yet. They will be generated automatically after each meaningful session.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {learnings.map((l) => (
              <LearningCard
                key={l.id}
                learning={l}
                onMarkReviewed={handleMarkReviewed}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LearningCard({
  learning,
  onMarkReviewed,
  onDelete,
}: {
  learning: Learning;
  onMarkReviewed: (id: number, reviewed: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(!learning.reviewed);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-secondary/30"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="text-xs text-muted-foreground">
          {new Date(learning.createdAt).toLocaleDateString("en-US", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        {!learning.reviewed && (
          <Badge variant="outline" className="text-[9px] border-border text-muted-foreground">
            new
          </Badge>
        )}
        {learning.exported && (
          <Badge variant="outline" className="text-[9px] border-success/40 text-success">
            <Sparkles className="h-2.5 w-2.5 mr-0.5" />
            exported
          </Badge>
        )}
        <span className="ml-auto flex gap-1">
          {!learning.reviewed && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onMarkReviewed(learning.id, true); }}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-secondary cursor-pointer"
              title="Mark as reviewed"
            >
              <Check className="h-3 w-3 text-muted-foreground" />
            </span>
          )}
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onDelete(learning.id); }}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive cursor-pointer"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <MarkdownContent content={learning.rawReport} />
        </div>
      )}
    </div>
  );
}
