import { useState, useMemo, useCallback, useId } from "react";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { patch, post, useApi } from "../hooks/useApi.js";
import type { Project } from "../types.js";
import type { AgentStatusMap } from "../App.js";
import { Star, EyeOff, Eye, FolderPlus, FolderSearch, Loader2, Check, X, FolderCog, ExternalLink } from "lucide-react";

const AGENT_STATUS_STYLES: Record<string, string> = {
  none:    "bg-muted-foreground/40",
  idle:    "bg-muted-foreground",
  running: "bg-warning shadow-[0_0_4px_color-mix(in_oklab,var(--warning)_40%,transparent)] animate-pulse",
  done:    "bg-success shadow-[0_0_4px_color-mix(in_oklab,var(--success)_40%,transparent)]",
  error:   "bg-destructive shadow-[0_0_4px_color-mix(in_oklab,var(--destructive)_40%,transparent)]",
};

type SortKey = "name" | "created" | "updated";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "A → Z" },
  { value: "created", label: "Création" },
  { value: "updated", label: "Maj récente" },
];

// Alphabetical ascending; dates newest-first (the useful default for both).
function sortProjects(list: Project[], key: SortKey): Project[] {
  const sorted = [...list];
  if (key === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const field = key === "created" ? "createdAt" : "updatedAt";
    sorted.sort((a, b) => (b[field] ?? "").localeCompare(a[field] ?? ""));
  }
  return sorted;
}

function SortSelect({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SortKey)}
      onClick={(e) => e.stopPropagation()}
      title="Trier les projets"
      className="ml-auto rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
    >
      {SORT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

type AppInfo = {
  version: string;
  githubUrl: string;
};

function OverlordStar({ active }: { active: boolean }) {
  const gradientId = useId();

  if (!active) {
    return <Star className="size-4 text-sidebar-foreground/50" />;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 opacity-90 drop-shadow-[0_0_3px_rgba(165,180,252,0.25)]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="52%" stopColor="#67e8f9" />
          <stop offset="100%" stopColor="#ffffff" />
        </linearGradient>
      </defs>
      <path
        d="M11.48 3.5a.56.56 0 0 1 1.04 0l2.2 5.31a.56.56 0 0 0 .48.35l5.73.46a.56.56 0 0 1 .32.98l-4.36 3.74a.56.56 0 0 0-.18.56l1.33 5.6a.56.56 0 0 1-.84.61l-4.91-3a.56.56 0 0 0-.58 0l-4.91 3a.56.56 0 0 1-.84-.61l1.33-5.6a.56.56 0 0 0-.18-.56L2.85 10.6a.56.56 0 0 1 .32-.98l5.73-.46a.56.56 0 0 0 .48-.35l2.1-5.31Z"
        fill={`url(#${gradientId})`}
        stroke={`url(#${gradientId})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  projects: Project[];
  selected: Project | null;
  agentStatuses: AgentStatusMap;
  onSelect: (p: Project) => void;
  onScan: () => void | Promise<void>;
  onProjectUpdate: () => void;
  onOpenWorkspaceSettings: () => void;
}

export function ProjectSidebar({
  projects,
  selected,
  agentStatuses,
  onSelect,
  onScan,
  onProjectUpdate,
  onOpenWorkspaceSettings,
}: Props) {
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  // Independent sort state for favorites vs the main project list, persisted.
  const [favSort, setFavSort] = useState<SortKey>(
    () => (localStorage.getItem("overlord:favSort") as SortKey) || "name"
  );
  const [projSort, setProjSort] = useState<SortKey>(
    () => (localStorage.getItem("overlord:projSort") as SortKey) || "name"
  );
  const changeFavSort = useCallback((v: SortKey) => {
    setFavSort(v);
    localStorage.setItem("overlord:favSort", v);
  }, []);
  const changeProjSort = useCallback((v: SortKey) => {
    setProjSort(v);
    localStorage.setItem("overlord:projSort", v);
  }, []);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const { data: appInfo } = useApi<AppInfo>("/settings/about");

  const handleCreateProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    setCreateError(null);
    const result = await post<Project & { error?: string }>("/projects/create", { name, initGit: true });
    if (result.error) {
      setCreateError(result.error);
      return;
    }
    setNewProjectName("");
    setCreating(false);
    onProjectUpdate();
    if (result.id) onSelect(result);
  }, [newProjectName, onProjectUpdate, onSelect]);

  const filtered = useMemo(() => {
    let list = projects;
    if (!showHidden) list = list.filter((p) => !p.hidden);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [projects, search, showHidden]);

  const favorites = useMemo(
    () => sortProjects(filtered.filter((p) => p.favorite), favSort),
    [filtered, favSort]
  );
  const others = useMemo(
    () => sortProjects(filtered.filter((p) => !p.favorite), projSort),
    [filtered, projSort]
  );
  const visibleProjectCount = useMemo(
    () => projects.filter((p) => !p.hidden).length,
    [projects]
  );

  const toggleFavorite = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      await patch(`/projects/${project.id}`, { favorite: !project.favorite });
      onProjectUpdate();
    },
    [onProjectUpdate]
  );

  const toggleHidden = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      await patch(`/projects/${project.id}`, { hidden: !project.hidden });
      onProjectUpdate();
    },
    [onProjectUpdate]
  );

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      await onScan();
    } finally {
      setScanning(false);
    }
  }, [onScan]);

  const renderProject = (p: Project) => (
    <SidebarMenuItem key={p.id} className="group/project">
      <SidebarMenuButton
        isActive={selected?.id === p.id}
        onClick={() => onSelect(p)}
        tooltip={p.path}
        className={cn("pr-12", p.hidden && "opacity-40")}
      >
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            AGENT_STATUS_STYLES[agentStatuses[p.id] ?? "none"]
          )}
        />
        <span className="truncate">{p.name}</span>
      </SidebarMenuButton>

      {/* Action buttons, visible on hover */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
        <Tooltip>
          <TooltipTrigger>
            <span
              role="button"
              onClick={(e) => toggleHidden(e, p)}
              className="flex h-5 w-5 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-sidebar-accent group-hover/project:opacity-100 cursor-pointer"
            >
              {p.hidden ? (
                <Eye className="h-3 w-3 text-sidebar-foreground/50" />
              ) : (
                <EyeOff className="h-3 w-3 text-sidebar-foreground/50" />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {p.hidden ? "Show" : "Hide"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <span
              role="button"
              onClick={(e) => toggleFavorite(e, p)}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-sm transition-opacity hover:bg-sidebar-accent cursor-pointer",
                p.favorite ? "opacity-100" : "opacity-0 group-hover/project:opacity-100"
              )}
            >
              <OverlordStar active={p.favorite} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {p.favorite ? "Remove from favorites" : "Favorite"}
          </TooltipContent>
        </Tooltip>
      </div>
    </SidebarMenuItem>
  );

  return (
    <Sidebar>
      <SidebarHeader className="desktop-sidebar-header">
        <div className="flex items-center gap-2">
          <img
            src="/favicons/favicon-128.png"
            alt=""
            className="h-8 w-8 shrink-0"
          />
          <h1 className="font-['Montserrat'] text-[14px] font-semibold tracking-[3px] text-primary">
            OVERLORD
          </h1>
        </div>
        <SidebarInput
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </SidebarHeader>

      <SidebarContent>
        {favorites.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center">
              Favoris <span className="ml-1 text-muted-foreground">({favorites.length})</span>
              <SortSelect value={favSort} onChange={changeFavSort} />
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">{favorites.map(renderProject)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center">
            Projets <span className="ml-1 text-muted-foreground">({visibleProjectCount})</span>
            <SortSelect value={projSort} onChange={changeProjSort} />
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {others.map(renderProject)}
              {filtered.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No projects found
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2">
        {/* New project inline form */}
        {creating && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                placeholder="my-new-project"
                value={newProjectName}
                onChange={(e) => { setNewProjectName(e.target.value); setCreateError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateProject();
                  if (e.key === "Escape") { setCreating(false); setNewProjectName(""); setCreateError(null); }
                }}
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button
                size="icon-sm"
                className="h-7 w-7 shrink-0"
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 shrink-0"
                onClick={() => { setCreating(false); setNewProjectName(""); setCreateError(null); }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {createError && (
              <p className="text-[10px] text-destructive">{createError}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-4 divide-x divide-sidebar-border overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/30">
          <Tooltip>
            <TooltipTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-full rounded-none border-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={() => setCreating(true)}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              New project
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-full rounded-none border-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={onOpenWorkspaceSettings}
              >
                <FolderCog className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Change workspace folder
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-full rounded-none border-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {showHidden ? "Hide hidden projects" : "Show hidden projects"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-full rounded-none border-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={handleScan}
                disabled={scanning}
              >
                {scanning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderSearch className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {scanning ? "Scanning..." : "Scan projects"}
            </TooltipContent>
          </Tooltip>
        </div>
        {appInfo && (
          <div className="flex items-center justify-between px-1 text-[10px] text-sidebar-foreground/40">
            <span>v{appInfo.version}</span>
            <a
              href={appInfo.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-sidebar-foreground/70"
            >
              <ExternalLink className="h-3 w-3" />
              GitHub
            </a>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
