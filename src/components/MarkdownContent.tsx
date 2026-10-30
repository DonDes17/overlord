import React, { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react";

interface Props {
  content: string;
  className?: string;
}

function CodeBlock({ children, className: langClass, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="group/code relative">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-secondary/80 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-secondary"
        title="Copy code"
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      <code className={langClass} {...props}>
        {children}
      </code>
    </div>
  );
}

export const MarkdownContent = React.memo(function MarkdownContent({ content, className }: Props) {
  return (
    <div
      className={cn(
        "prose prose-invert prose-sm max-w-none select-text",
        "prose-headings:text-foreground prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2",
        "prose-h1:text-lg prose-h2:text-base prose-h3:text-sm",
        "prose-a:text-primary prose-a:underline prose-a:underline-offset-2 hover:prose-a:text-primary/80",
        "prose-code:text-foreground prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-secondary prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:p-3",
        "prose-li:text-foreground/80 prose-ul:my-1 prose-ol:my-1",
        "prose-table:text-xs prose-th:text-foreground prose-td:text-foreground/70 prose-th:border-border prose-td:border-border",
        "prose-blockquote:border-primary/40 prose-blockquote:text-muted-foreground",
        "prose-strong:text-foreground prose-em:text-foreground/80",
        "prose-p:my-1.5 prose-p:leading-relaxed",
        // Prose keeps a comfortable line length; code blocks, tables and tool rows use the full column.
        "prose-p:max-w-[72ch] prose-li:max-w-[72ch] prose-headings:max-w-[72ch]",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          ),
          pre: ({ children, ...props }) => (
            <pre className="overflow-x-auto text-xs leading-relaxed" {...props}>
              {children}
            </pre>
          ),
          code: ({ children, className: langClass, ...props }) => {
            // Inline code vs code block
            const isBlock = langClass || String(children).includes("\n");
            if (isBlock) {
              return <CodeBlock className={langClass} {...props}>{children}</CodeBlock>;
            }
            return <code className={langClass} {...props}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
