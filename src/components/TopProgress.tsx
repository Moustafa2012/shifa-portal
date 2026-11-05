"use client";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Thin progress bar at the top of the page for anything that takes time:
 * page navigations, server-action submissions, refreshes and file uploads.
 * It watches same-origin fetches (Next uses fetch for RSC navigations and server actions),
 * link clicks (instant feedback) and form submits (full-page POSTs such as uploads).
 */
export function TopProgress() {
  const [value, setValue] = useState(0);        // 0..1
  const [active, setActive] = useState(false);
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = usePathname();
  const search = useSearchParams();

  const finish = useRef(() => {});
  const start = useRef(() => {});
  finish.current = () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (safety.current) { clearTimeout(safety.current); safety.current = null; }
    setValue((v) => (v > 0 ? 1 : v));
    if (doneTimer.current) clearTimeout(doneTimer.current);
    doneTimer.current = setTimeout(() => { setActive(false); setValue(0); }, 260);
  };
  start.current = () => {
    if (doneTimer.current) { clearTimeout(doneTimer.current); doneTimer.current = null; }
    if (!timer.current) {
      setActive(true); setValue((v) => (v > 0 && v < 1 ? v : 0.08));
      timer.current = setInterval(() => setValue((v) => Math.min(0.92, v + (1 - v) * 0.08)), 220);
    }
    if (safety.current) clearTimeout(safety.current);
    safety.current = setTimeout(() => finish.current(), 15000);   // never hang
  };

  // navigation committed; if its data is still streaming the fetch tracker keeps the bar going
  useEffect(() => { if (inflight.current === 0) finish.current(); }, [path, search]);

  useEffect(() => {
    const orig = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let track = false;
      try {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
        track = url.origin === location.origin && !headers.has("next-router-prefetch") && !url.pathname.startsWith("/_next/static");
      } catch { /* ignore */ }
      if (!track) return orig.call(window, input, init);
      inflight.current++; start.current();
      return orig.call(window, input, init).finally(() => {
        inflight.current = Math.max(0, inflight.current - 1);
        if (inflight.current === 0) setTimeout(() => { if (inflight.current === 0) finish.current(); }, 120);
      });
    } as typeof window.fetch;

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;
      start.current();
    };
    // form posts that are not server actions (e.g. the document upload) navigate the whole page
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement;
      if (!e.defaultPrevented && typeof f.action === "string" && /\/api\//.test(f.action)) start.current();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => { window.fetch = orig; document.removeEventListener("click", onClick, true); document.removeEventListener("submit", onSubmit, true); };
  }, []);

  return (
    <div className="topprogress" role="progressbar" aria-hidden={!active} aria-label="loading" data-active={active || undefined}>
      <ProgressPrimitive.Root
        className="relative h-0.5 w-full overflow-hidden bg-transparent"
        value={value * 100}
      >
        <ProgressPrimitive.Indicator
          className="topprogress-bar h-full w-full flex-1 bg-primary transition-all duration-200"
          style={{ transform: `scaleX(${value})`, transformOrigin: "start" }}
        />
      </ProgressPrimitive.Root>
    </div>
  );
}
