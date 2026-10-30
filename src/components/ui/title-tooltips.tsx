import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { tooltipSurface } from "./tooltip";

const DELAY_MS = 300;
const GAP = 8;
const MARGIN = 8;

interface Tip {
  text: string;
  rect: DOMRect;
}

interface Placement {
  left: number;
  top: number;
  below: boolean;
  arrowLeft: number;
}

/**
 * Gives every element that has a plain `title="…"` the same tooltip as <Tooltip>, instead of the
 * browser's own one. On first hover the text moves to `data-tooltip` (which silences the native
 * tooltip) and `aria-label` keeps the accessible name of icon-only elements. Mounted once, in App.
 */
export function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };

    const onMove = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[title], [data-tooltip]") as HTMLElement | null;
      if (!el) {
        if (current) hide();
        return;
      }
      const native = el.getAttribute("title");
      if (native) {
        el.setAttribute("data-tooltip", native);
        el.removeAttribute("title");
        if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", native);
      }
      const text = el.getAttribute("data-tooltip");
      if (!text) {
        if (current) hide();
        return;
      }
      if (el === current) return;
      hide();
      current = el;
      timer = window.setTimeout(() => {
        if (current === el) setTip({ text, rect: el.getBoundingClientRect() });
      }, DELAY_MS);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Measured after render, hidden until placed: above the element, below when there is no room.
  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setPlacement(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const centerX = tip.rect.left + tip.rect.width / 2;
    const left = Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, centerX - width / 2));
    const below = tip.rect.top - height - GAP < MARGIN;
    setPlacement({
      left,
      top: below ? tip.rect.bottom + GAP : tip.rect.top - height - GAP,
      below,
      arrowLeft: Math.max(10, Math.min(width - 10, centerX - left)),
    });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, visibility: placement ? "visible" : "hidden" }}
      className={cn("pointer-events-none fixed z-[300] max-w-xs animate-in fade-in-0 zoom-in-95", tooltipSurface)}
    >
      {tip.text}
      <span
        className={cn("absolute size-2 -translate-x-1/2 rotate-45 rounded-[2px] bg-foreground", placement?.below ? "-top-1" : "-bottom-1")}
        style={{ left: placement?.arrowLeft }}
      />
    </div>,
    document.body
  );
}
