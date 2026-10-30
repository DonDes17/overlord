import { useState } from "react";
import type { ComponentType } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolUseCard, formatInput, getToolInfo } from "./ToolUseCard.js";

export interface GroupedTool {
  id: string;
  name: string;
  input?: Record<string, any>;
  result?: string;
}

const MAX_ICONS = 3;

// A run of tool calls between two messages, folded into one line. While the agent is still working
// on it, the line shows what it is doing right now instead of the breakdown.
export function ToolGroup({
  tools,
  live,
  onAnswerQuestions,
}: {
  tools: GroupedTool[];
  /** The agent is working and this is the last thing in the chat. */
  live: boolean;
  onAnswerQuestions?: (answers: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Distinct tool kinds in order of first use, with how many times each was called.
  const kinds = new Map<string, { icon: ComponentType<{ className?: string }>; color: string; count: number }>();
  for (const tool of tools) {
    const info = getToolInfo(tool.name);
    const kind = kinds.get(info.label);
    if (kind) kind.count += 1;
    else kinds.set(info.label, { icon: info.icon, color: info.color, count: 1 });
  }
  const breakdown = [...kinds].map(([label, k]) => (k.count > 1 ? `${label} ×${k.count}` : label)).join(", ");

  const latest = tools[tools.length - 1];
  const latestSummary = formatInput(latest.name, latest.input);

  return (
    <div className="rounded-lg border border-border bg-secondary/30 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50"
      >
        {live ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span className="flex shrink-0 items-center gap-0.5">
            {[...kinds.values()].slice(0, MAX_ICONS).map((k, i) => {
              const Icon = k.icon;
              return <Icon key={i} className={cn("h-3.5 w-3.5", k.color)} />;
            })}
          </span>
        )}
        <span className="font-medium text-foreground/80">{tools.length} tool calls</span>
        <span className={cn("truncate text-muted-foreground", live && "font-mono")}>
          {live ? latestSummary ?? getToolInfo(latest.name).label : breakdown}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-border p-2">
          {tools.map((tool) => (
            <ToolUseCard key={tool.id} name={tool.name} input={tool.input} result={tool.result} onAnswerQuestions={onAnswerQuestions} />
          ))}
        </div>
      )}
    </div>
  );
}
