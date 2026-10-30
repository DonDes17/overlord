import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { patch } from "../hooks/useApi.js";
import type { Project, MarketingAsset } from "../types.js";
import { ChatTab } from "./ChatTab.js";
import {
  Upload, Trash2, Copy, Check, FileText, Save, ChevronDown, ChevronRight,
} from "lucide-react";

interface Props {
  project: Project;
  input: string;
  onInputChange: (value: string) => void;
  activeWorkspaces: string[];
  onToggleWorkspace: (path: string) => void;
}

export function MarketingTab({
  project,
  input,
  onInputChange,
  activeWorkspaces,
  onToggleWorkspace,
}: Props) {
  const [infoCollapsed, setInfoCollapsed] = useState(false);

  return (
    <div className="flex h-full">
      {/* Side panel: project context */}
      <aside className="w-72 shrink-0 border-r border-border overflow-y-auto bg-card/50">
        <div className="p-3">
          <button
            onClick={() => setInfoCollapsed((v) => !v)}
            className="flex items-center gap-1 w-full text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground mb-4"
          >
            {infoCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Context
          </button>
          {!infoCollapsed && (
            <div className="flex flex-col gap-3">
              <ProjectInfoCard project={project} />
              <AssetsCard project={project} />
            </div>
          )}
        </div>
      </aside>

      {/* Main chat */}
      <div className="flex-1 min-h-0 min-w-0">
        <ChatTab
          project={project}
          input={input}
          onInputChange={onInputChange}
          activeWorkspaces={activeWorkspaces}
          onToggleWorkspace={onToggleWorkspace}
          channel="marketing"
        />
      </div>
    </div>
  );
}

// ─── Project info (tagline, descriptions, links) ─────────────

function ProjectInfoCard({ project }: { project: Project }) {
  const [tagline, setTagline] = useState(project.tagline ?? "");
  const [shortDesc, setShortDesc] = useState(project.shortDescription ?? "");
  const [longDesc, setLongDesc] = useState(project.longDescription ?? "");
  const [links, setLinks] = useState(project.links ?? "");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setTagline(project.tagline ?? "");
    setShortDesc(project.shortDescription ?? "");
    setLongDesc(project.longDescription ?? "");
    setLinks(project.links ?? "");
    setDirty(false);
  }, [project.id]);

  const handleSave = useCallback(async () => {
    await patch(`/projects/${project.id}`, {
      tagline: tagline || null,
      shortDescription: shortDesc || null,
      longDescription: longDesc || null,
      links: links || null,
    });
    setSaved(true);
    setDirty(false);
    setTimeout(() => setSaved(false), 2000);
  }, [project.id, tagline, shortDesc, longDesc, links]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Project info</CardTitle>
        <Button size="sm" onClick={handleSave} disabled={!dirty && !saved}>
          {saved ? <><Check className="h-3 w-3 mr-1" /> Saved</> : <><Save className="h-3 w-3 mr-1" /> Save</>}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 block">Tagline</label>
          <Input
            value={tagline}
            onChange={(e) => { setTagline(e.target.value); setDirty(true); }}
            placeholder="A one-line summary of the project"
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 block">Short description</label>
          <Textarea
            value={shortDesc}
            onChange={(e) => { setShortDesc(e.target.value); setDirty(true); }}
            placeholder="Short description (2-3 sentences), used for the press kit, social media..."
            className="min-h-[70px]"
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 block">Long description</label>
          <Textarea
            value={longDesc}
            onChange={(e) => { setLongDesc(e.target.value); setDirty(true); }}
            placeholder="Full description for the landing page, store..."
            className="min-h-[120px]"
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 block">Links</label>
          <Textarea
            value={links}
            onChange={(e) => { setLinks(e.target.value); setDirty(true); }}
            placeholder="One link per line: twitter:https://..., website:https://..., steam:https://..."
            className="min-h-[80px] font-mono text-xs"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Assets ──────────────────────────────────────────────────

function AssetsCard({ project }: { project: Project }) {
  const [assets, setAssets] = useState<MarketingAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAssets = useCallback(async () => {
    const res = await fetch(`/api/marketing/assets/${project.id}`);
    setAssets(await res.json());
  }, [project.id]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      setUploading(true);
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("type", file.type.startsWith("image/") ? "screenshot" : file.type.startsWith("video/") ? "video" : "other");
        await fetch(`/api/marketing/assets/${project.id}`, { method: "POST", body: formData });
      }
      setUploading(false);
      fetchAssets();
    },
    [project.id, fetchAssets]
  );

  const handleDelete = useCallback(async (id: number) => {
    await fetch(`/api/marketing/assets/${id}`, { method: "DELETE" });
    fetchAssets();
  }, [fetchAssets]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Assets ({assets.length})</CardTitle>
        <CardAction>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload className="h-3 w-3 mr-1" />
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {assets.length === 0 ? (
          <p
            className="text-xs italic text-muted-foreground py-6 text-center border border-dashed border-border rounded-md cursor-pointer hover:bg-secondary/30"
            onClick={() => fileInputRef.current?.click()}
            onDrop={(e) => { e.preventDefault(); handleUpload(e.dataTransfer.files); }}
            onDragOver={(e) => e.preventDefault()}
          >
            Upload logos, screenshots, videos... (drag & drop or click)
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssetCard({ asset, onDelete }: { asset: MarketingAsset; onDelete: (id: number) => void }) {
  const isImage = asset.mimeType?.startsWith("image/");
  const [copied, setCopied] = useState(false);

  const copyUrl = () => {
    navigator.clipboard.writeText(`${window.location.origin}/api/marketing/assets/file/${asset.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/asset relative aspect-square rounded-md border border-border bg-secondary overflow-hidden">
      {isImage ? (
        <img src={`/api/marketing/assets/file/${asset.id}`} alt={asset.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2">
          <FileText className="h-8 w-8 text-muted-foreground" />
          <span className="text-[10px] text-center text-muted-foreground truncate w-full">{asset.name}</span>
        </div>
      )}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/asset:opacity-100 transition-opacity flex items-center justify-center gap-1">
        <button
          onClick={copyUrl}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary hover:bg-primary"
          title="Copy URL"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </button>
        <button
          onClick={() => onDelete(asset.id)}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary hover:bg-destructive"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5">
        <div className="text-[9px] text-white truncate">{asset.name}</div>
      </div>
    </div>
  );
}
