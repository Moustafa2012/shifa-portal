"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

/**
 * The search box of the top bar (a plain GET form to the search page). Studio-style: 32px, the icon inside at the start,
 * a "/" hint; pressing "/" outside a field focuses it. It reserves 14rem and grows over its neighbours on focus, so nothing
 * around it moves. On small screens it is an icon button that opens the box across the top bar.
 */
export function ShellSearchBox({ action, label, placeholder, openLabel, closeLabel }: { action: string; label: string; placeholder: string; openLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      e.preventDefault();
      setOpen(true);
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // on a phone the opened box covers the top bar: focus it, and close on Escape
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };

  return (
    <div className="shell-search-wrap no-print" data-open={open ? "true" : "false"}>
      <button ref={button} type="button" className="shell-search-btn" aria-label={openLabel} aria-expanded={open} onClick={() => setOpen(true)}>
        <Search size={18} aria-hidden="true" />
      </button>
      <form action={action} method="get" role="search" className="shell-search" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
        <Search size={14} aria-hidden="true" className="shell-search-icon" />
        <input ref={input} type="search" name="q" minLength={2} maxLength={100} placeholder={placeholder} aria-label={label} autoComplete="off" aria-keyshortcuts="/" />
        <kbd className="shell-search-kbd" aria-hidden="true">/</kbd>
        <button type="button" className="shell-search-close" aria-label={closeLabel} onClick={close}><X size={16} aria-hidden="true" /></button>
      </form>
    </div>
  );
}
