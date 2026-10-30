import React, { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  FileText, FolderSearch, Terminal, Pencil, FilePlus,
  Search, Globe, ChevronDown, ChevronRight, Eye, ExternalLink,
  HelpCircle, Send
} from "lucide-react";

interface Props {
  name: string;
  input?: Record<string, any>;
  result?: string;
  onAnswerQuestions?: (answer: string) => void;
}

interface EditorInfo {
  id: string;
  name: string;
  cmd: string;
}

export const ASK_USER_QUESTION = "AskUserQuestion";

// Tools that change things (Edit, Write, Command) are drawn brighter than the read-only ones: the
// difference is brightness and icon, not a different hue per tool.
const TOOL_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string }> = {
  AskUserQuestion: { icon: HelpCircle, label: "Questions",     color: "text-primary" },
  Read:       { icon: Eye,          label: "Read",          color: "text-muted-foreground" },
  Edit:       { icon: Pencil,       label: "Edit",          color: "text-foreground" },
  Write:      { icon: FilePlus,     label: "Write",         color: "text-foreground" },
  Bash:       { icon: Terminal,     label: "Command",       color: "text-foreground" },
  Glob:       { icon: FolderSearch, label: "Search",        color: "text-muted-foreground" },
  Grep:       { icon: Search,       label: "Search",        color: "text-muted-foreground" },
  WebFetch:   { icon: Globe,        label: "Web",           color: "text-muted-foreground" },
  WebSearch:  { icon: Globe,        label: "Web search",    color: "text-muted-foreground" },
};

export function getToolInfo(name: string) {
  const shortName = name.includes("__") ? name.split("__").pop() ?? name : name;
  return TOOL_CONFIG[shortName] ?? { icon: FileText, label: shortName, color: "text-muted-foreground" };
}

function shortenPath(p: string): string {
  const match = p.match(/(?:Developer|Projects|repos|workspace|code|home\/\w+)\/(.*)/i);
  if (match) return match[1];
  const parts = p.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : p;
}

export function formatInput(name: string, input?: Record<string, any>): string | null {
  if (!input) return null;
  if (name === "Read" && input.file_path) return shortenPath(input.file_path);
  if (name === "Edit" && input.file_path) return shortenPath(input.file_path);
  if (name === "Write" && input.file_path) return shortenPath(input.file_path);
  if (name === "Bash" && input.command) return input.command;
  if (name === "Glob" && input.pattern) return input.pattern;
  if (name === "Grep" && input.pattern) return input.pattern;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length < 200) return v;
  }
  return null;
}

function hasFilePath(name: string): boolean {
  return ["Read", "Edit", "Write"].includes(name);
}

// ─── Editor Picker ───────────────────────────────────────────

let editorsCache: EditorInfo[] | null = null;

const MAC_FALLBACK_EDITORS: EditorInfo[] = [
  { id: "cursor", name: "Cursor", cmd: "cursor" },
  { id: "vscode", name: "VS Code", cmd: "code" },
];

function getFallbackEditors() {
  return navigator.platform.toLowerCase().includes("mac") ? MAC_FALLBACK_EDITORS : [];
}

function useEditors() {
  const [editors, setEditors] = useState<EditorInfo[]>(editorsCache ?? []);

  useEffect(() => {
    if (editorsCache) return;
    fetch("/api/editors")
      .then((r) => r.json())
      .then((data) => {
        const nextEditors = Array.isArray(data) && data.length > 0 ? data : getFallbackEditors();
        editorsCache = nextEditors;
        setEditors(nextEditors);
      })
      .catch(() => setEditors(getFallbackEditors()));
  }, []);

  return editors;
}

function getPreferredEditor(): string | null {
  return localStorage.getItem("overlord:editor");
}

function setPreferredEditor(id: string) {
  localStorage.setItem("overlord:editor", id);
}

function EditorButton({ filePath }: { filePath: string }) {
  const editors = useEditors();
  const [showPicker, setShowPicker] = useState(false);
  const preferred = getPreferredEditor();

  const openInEditor = useCallback(
    (editorId: string) => {
      setPreferredEditor(editorId);
      setShowPicker(false);
      fetch("/api/editor/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, editor: editorId }),
      });
    },
    [filePath]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (preferred) {
        openInEditor(preferred);
      } else {
        setShowPicker(true);
      }
    },
    [preferred, openInEditor]
  );

  if (editors.length === 0) return null;

  return (
    <div className="relative">
      <span
        role="button"
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowPicker(true);
        }}
        className="flex h-5 w-5 items-center justify-center rounded hover:bg-secondary cursor-pointer"
        title={preferred ? `Open in ${editors.find((e) => e.id === preferred)?.name ?? preferred}` : "Open in editor"}
      >
        <ExternalLink className="h-3 w-3 text-muted-foreground" />
      </span>

      {showPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setShowPicker(false); }} />
          <div className="absolute right-0 top-6 z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-lg">
            {editors.map((ed) => (
              <button
                key={ed.id}
                onClick={(e) => { e.stopPropagation(); openInEditor(ed.id); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent",
                  preferred === ed.id && "text-primary font-medium"
                )}
              >
                {ed.name}
                {preferred === ed.id && <span className="ml-auto text-[10px] text-muted-foreground">default</span>}
              </button>
            ))}
            <div className="border-t border-border mt-1 pt-1 px-2 py-1 text-[10px] text-muted-foreground">
              Right-click to change
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Diff View ───────────────────────────────────────────────

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <div className="mt-2 rounded-md border border-border bg-secondary/50 p-2 font-mono text-[11px] leading-relaxed overflow-x-auto select-text">
      {oldStr && (
        <div className="text-destructive/80">
          {oldStr.split("\n").map((line, i) => (
            <div key={`old-${i}`}>- {line}</div>
          ))}
        </div>
      )}
      {newStr && (
        <div className="text-success/80 mt-1">
          {newStr.split("\n").map((line, i) => (
            <div key={`new-${i}`}>+ {line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

interface PastedFormBlock {
  id: string;
  content: string;
  lineCount: number;
}

interface QuestionDef {
  question: string;
  header?: string;
  multiSelect?: boolean;
  multi_select?: boolean;
  options?: { label: string; description?: string }[];
}

function QuestionsForm({
  input,
  onSubmit,
  answered,
}: {
  input: Record<string, any>;
  onSubmit: (answer: string) => void;
  answered: boolean;
}) {
  const questions: QuestionDef[] = input?.questions ?? [];
  const [selectedOptions, setSelectedOptions] = useState<string[][]>(questions.map(() => []));
  const [freeTexts, setFreeTexts] = useState<string[]>(questions.map(() => ""));
  const [pastedBlocks, setPastedBlocks] = useState<PastedFormBlock[][]>(questions.map(() => []));
  const [submitted, setSubmitted] = useState(answered);
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const toggleOption = useCallback((idx: number, label: string, multi: boolean) => {
    setSelectedOptions((prev) =>
      prev.map((list, i) => {
        if (i !== idx) return list;
        if (multi) {
          return list.includes(label) ? list.filter((x) => x !== label) : [...list, label];
        }
        return list.includes(label) ? [] : [label];
      })
    );
  }, []);

  const setFreeText = useCallback((idx: number, value: string) => {
    setFreeTexts((prev) => prev.map((t, i) => (i === idx ? value : t)));
  }, []);

  const handlePaste = useCallback((idx: number, e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text");
    const lineCount = pasted.split("\n").length;
    if (lineCount <= 5) return; // default behavior
    e.preventDefault();
    const id = crypto.randomUUID();
    const placeholder = `{{paste:${id}}}`;
    const el = e.currentTarget;
    const start = el.selectionStart ?? freeTexts[idx].length;
    const end = el.selectionEnd ?? freeTexts[idx].length;
    const current = freeTexts[idx];
    const nextText = current.slice(0, start) + placeholder + current.slice(end);
    setFreeText(idx, nextText);
    setPastedBlocks((prev) => prev.map((list, i) =>
      i === idx ? [...list, { id, content: pasted, lineCount }] : list
    ));
    setTimeout(() => {
      const pos = start + placeholder.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }, [freeTexts, setFreeText]);

  const removeBlock = useCallback((idx: number, blockId: string) => {
    setFreeText(idx, freeTexts[idx].replace(`{{paste:${blockId}}}`, ""));
    setPastedBlocks((prev) => prev.map((list, i) =>
      i === idx ? list.filter((b) => b.id !== blockId) : list
    ));
  }, [freeTexts, setFreeText]);

  // Expand placeholders to actual content for sending
  const getExpandedFreeText = useCallback((idx: number) => {
    const blocksById = new Map(pastedBlocks[idx].map((b) => [b.id, b]));
    return freeTexts[idx].replace(/\{\{paste:([^}]+)\}\}/g, (_, id) => {
      const b = blocksById.get(id);
      return b ? `\n${b.content}\n` : "";
    }).trim();
  }, [freeTexts, pastedBlocks]);

  const getCombinedAnswer = useCallback(
    (idx: number) => {
      return [...selectedOptions[idx], getExpandedFreeText(idx)].filter((s) => s && s.trim()).join(", ");
    },
    [selectedOptions, getExpandedFreeText]
  );

  const handleSubmit = useCallback(() => {
    const formatted = questions
      .map((q, i) => {
        const answer = getCombinedAnswer(i);
        return `Q: ${q.question}\nA: ${answer || "(no answer)"}`;
      })
      .join("\n\n");
    onSubmit(formatted);
    setSubmitted(true);
  }, [questions, getCombinedAnswer, onSubmit]);

  const hasAnswer = useCallback((idx: number) => {
    return selectedOptions[idx].length > 0 || getExpandedFreeText(idx).length > 0;
  }, [selectedOptions, getExpandedFreeText]);

  const allAnswered = questions.every((_, i) => hasAnswer(i));

  if (submitted) {
    return (
      <div className="p-3 text-xs text-muted-foreground italic">
        Answers sent.
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-card p-3 flex flex-col gap-3">
      {questions.map((q, idx) => (
        <div key={idx} className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-foreground">
            {q.header && <span className="text-primary mr-1.5">[{q.header}]</span>}
            {q.question}
          </label>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const isSelected = selectedOptions[idx].includes(opt.label);
                const multi = q.multiSelect ?? q.multi_select ?? false;
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggleOption(idx, opt.label, multi)}
                    className={cn(
                      "inline-flex items-center rounded-md px-2.5 py-1 text-xs transition-colors",
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground hover:text-foreground border border-border"
                    )}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
          {pastedBlocks[idx].length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pastedBlocks[idx].map((block) => (
                <span
                  key={block.id}
                  className="relative inline-flex items-center gap-1 rounded-md bg-secondary border border-border px-2 py-0.5 text-[11px] text-muted-foreground font-mono group/paste"
                >
                  [{block.lineCount} copied line{block.lineCount > 1 ? "s" : ""}]
                  <button
                    onClick={() => removeBlock(idx, block.id)}
                    className="text-muted-foreground/50 hover:text-destructive ml-0.5"
                  >
                    x
                  </button>
                  <div className="absolute bottom-full left-0 mb-1 w-80 max-h-48 overflow-auto rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg z-50 font-mono whitespace-pre-wrap hidden group-hover/paste:block">
                    {block.content.slice(0, 2000)}
                    {block.content.length > 2000 && "\n..."}
                  </div>
                </span>
              ))}
            </div>
          )}
          <Textarea
            ref={(el) => { textareaRefs.current[idx] = el; }}
            value={freeTexts[idx]}
            onChange={(e) => setFreeText(idx, e.target.value)}
            onPaste={(e) => handlePaste(idx, e)}
            placeholder={q.options?.length ? "Or write a free-form answer..." : "Your answer..."}
            className="min-h-[60px] text-xs"
            autoFocus={idx === 0}
          />
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!allAnswered}
          className="gap-1.5"
        >
          <Send className="h-3 w-3" />
          Send answers
        </Button>
      </div>
    </div>
  );
}

export const ToolUseCard = React.memo(function ToolUseCard({ name, input, result, onAnswerQuestions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const info = getToolInfo(name);
  const Icon = info.icon;
  const summary = formatInput(name, input);

  const isQuestions = name === ASK_USER_QUESTION && input?.questions?.length > 0;
  // Auto-expand questions form so user sees it immediately
  const [questionsExpanded, setQuestionsExpanded] = useState(isQuestions);
  useEffect(() => {
    if (isQuestions) setQuestionsExpanded(true);
  }, [isQuestions]);

  const hasDiff = name === "Edit" && input?.old_string && input?.new_string;
  const hasContent = name === "Write" && input?.content;
  const hasCommand = name === "Bash" && input?.command;
  const hasDetails = hasDiff || hasContent || hasCommand || result || isQuestions;
  const showOpenBtn = hasFilePath(name) && input?.file_path;

  return (
    <div className="rounded-lg border border-border bg-secondary/30 text-xs">
      <button
        onClick={() => {
          if (isQuestions) setQuestionsExpanded(!questionsExpanded);
          else if (hasDetails) setExpanded(!expanded);
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          hasDetails && "cursor-pointer hover:bg-secondary/50"
        )}
      >
        <Icon className={cn("h-3.5 w-3.5 shrink-0", info.color)} />
        <span className="font-medium text-foreground/80">{info.label}</span>
        {isQuestions && (
          <span className="truncate text-muted-foreground">
            {input!.questions.length} question{input!.questions.length > 1 ? "s" : ""}
          </span>
        )}
        {!isQuestions && summary && (
          <span className="truncate font-mono text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {showOpenBtn && <EditorButton filePath={input!.file_path} />}
          {hasDetails && (
            <span className="text-muted-foreground">
              {(isQuestions ? questionsExpanded : expanded) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </span>
          )}
        </span>
      </button>

      {isQuestions && questionsExpanded && onAnswerQuestions && (
        <QuestionsForm
          input={input!}
          onSubmit={onAnswerQuestions}
          answered={!!result}
        />
      )}

      {!isQuestions && expanded && (
        <div className="border-t border-border px-3 py-2">
          {hasDiff && (
            <DiffView oldStr={input.old_string} newStr={input.new_string} />
          )}

          {hasContent && (
            <div className="mt-1 rounded-md border border-border bg-secondary/50 p-2 font-mono text-[11px] leading-relaxed overflow-x-auto max-h-48 overflow-y-auto text-success/80 select-text">
              {input.content.split("\n").map((line: string, i: number) => (
                <div key={i}>+ {line}</div>
              ))}
            </div>
          )}

          {hasCommand && !hasDiff && !hasContent && (
            <pre className="rounded-md bg-secondary/50 p-2 font-mono text-[11px] text-foreground/70 overflow-x-auto select-text">
              $ {input.command}
            </pre>
          )}

          {result && (
            <pre className="mt-2 rounded-md bg-secondary/50 p-2 font-mono text-[11px] text-muted-foreground overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap select-text">
              {result.slice(0, 2000)}{result.length > 2000 ? "\n..." : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
