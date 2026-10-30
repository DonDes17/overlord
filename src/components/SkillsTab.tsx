import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Sparkles, FolderKanban, Globe, Search, Copy, Check, X, Trash2 } from "lucide-react";
import { useConfirmation } from "@/hooks/useConfirmation";
import type { Project } from "../types.js";

interface Skill {
  name: string;
  description: string | null;
  scope: "project" | "global";
  source: string;
  type: "skill" | "command";
}

interface Props {
  project: Project;
}

export function SkillsTab({ project }: Props) {
  const [skills, setSkills] = useState<{ project: Skill[]; global: Skill[] }>({ project: [], global: [] });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const { confirm, ConfirmationDialog } = useConfirmation();

  const loadSkills = useCallback(() => {
    fetch(`/api/skills/${project.id}`)
      .then((r) => r.json())
      .then((data) => setSkills(data))
      .catch(() => {});
  }, [project.id]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const deleteSkill = useCallback(async (skill: Skill) => {
    const confirmed = await confirm({
      title: `Delete /${skill.name}?`,
      description: `This will permanently delete the ${skill.scope === "global" ? "global" : "local"} ${skill.type}.`,
      details: (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground">Source</span>
          <span className="break-all font-mono">{skill.source}</span>
        </div>
      ),
      confirmLabel: "Delete",
      cancelLabel: "Keep it",
      destructive: true,
    });
    if (!confirmed) return;

    const res = await fetch(`/api/skills/${project.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: skill.source }),
    });
    if (!res.ok) return;

    if (selected?.source === skill.source) {
      setSelected(null);
      setSkillContent(null);
    }
    loadSkills();
  }, [confirm, loadSkills, project.id, selected?.source]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filter = (list: Skill[]) =>
      !q ? list : list.filter((s) => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q));
    return { project: filter(skills.project), global: filter(skills.global) };
  }, [skills, search]);

  const openSkill = useCallback(async (skill: Skill) => {
    setSelected(skill);
    setSkillContent(null);
    const res = await fetch(`/api/skills/${project.id}/content?source=${encodeURIComponent(skill.source)}`);
    const data = await res.json();
    setSkillContent(data.content ?? data.error ?? "");
  }, [project.id]);

  const total = skills.project.length + skills.global.length;

  return (
    <div className="flex w-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Skills ({total})
        </h3>
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Project skills */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <FolderKanban className="h-4 w-4 text-emerald-400" />
            Project skills ({filtered.project.length})
            <span className="text-[10px] text-muted-foreground font-normal font-mono ml-1">.claude/</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.project.length === 0 ? (
            <p className="text-xs italic text-muted-foreground py-4 text-center">
              {skills.project.length === 0 ? "No local skills in .claude/skills or .claude/commands." : "No results."}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {filtered.project.map((s) => (
                <SkillCard
                  key={`p-${s.source}`}
                  skill={s}
                  onClick={() => openSkill(s)}
                  onDelete={() => deleteSkill(s)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Global skills */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Globe className="h-4 w-4 text-blue-400" />
            Global skills ({filtered.global.length})
            <span className="text-[10px] text-muted-foreground font-normal font-mono ml-1">~/.claude/</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.global.length === 0 ? (
            <p className="text-xs italic text-muted-foreground py-4 text-center">
              {skills.global.length === 0 ? "No global skills." : "No results."}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {filtered.global.map((s) => (
                <SkillCard
                  key={`g-${s.source}`}
                  skill={s}
                  onClick={() => openSkill(s)}
                  onDelete={() => deleteSkill(s)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Viewer */}
      {selected && (
        <SkillViewer
          skill={selected}
          content={skillContent}
          onDelete={() => deleteSkill(selected)}
          onClose={() => { setSelected(null); setSkillContent(null); }}
        />
      )}
      <ConfirmationDialog />
    </div>
  );
}

function SkillCard({ skill, onClick, onDelete }: { skill: Skill; onClick: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyCommand = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(`/${skill.name}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className="group/skill flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left hover:border-primary/30 transition-colors min-w-0"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-xs text-primary font-semibold truncate">/{skill.name}</span>
        <Badge variant="outline" className="text-[9px] py-0 px-1 shrink-0">
          {skill.type}
        </Badge>
        <span
          role="button"
          onClick={copyCommand}
          className="ml-auto shrink-0 opacity-0 group-hover/skill:opacity-100 transition-opacity flex h-5 w-5 items-center justify-center rounded hover:bg-secondary cursor-pointer"
          title="Copy command"
        >
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
        </span>
        <span
          role="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="shrink-0 opacity-0 group-hover/skill:opacity-100 transition-opacity flex h-5 w-5 items-center justify-center rounded hover:bg-destructive/10 cursor-pointer"
          title="Delete"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
        </span>
      </div>
      {skill.description && (
        <p className="text-[11px] text-muted-foreground leading-snug line-clamp-3">
          {skill.description}
        </p>
      )}
    </div>
  );
}

function SkillViewer({ skill, content, onDelete, onClose }: { skill: Skill; content: string | null; onDelete: () => void; onClose: () => void }) {
  return (
    <div
      className="desktop-titlebar-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[80vh] rounded-lg border border-border bg-card overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-sm text-primary">/{skill.name}</span>
            <Badge variant="outline" className="text-[10px]">{skill.scope}</Badge>
            <span className="text-[10px] text-muted-foreground font-mono truncate">{skill.source}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onDelete}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className={cn("flex h-7 w-7 items-center justify-center rounded-md hover:bg-secondary")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {content === null ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80 select-text">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
