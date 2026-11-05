"use client";
import { Avatar } from "@/components/Avatar";
/* eslint-disable @next/next/no-img-element -- avatars are small private images served by /api/avatar */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Languages, Link2, LogOut, Moon, Settings, ShieldCheck, Sun, Users } from "lucide-react";
import { logout } from "@/app/actions/auth";
import { setLang, setTheme } from "@/app/actions/prefs";

export interface NavUserText {
  patients: string; shares: string; account: string; admin: string; signOut: string; menu: string;
  sectionAccount: string; sectionPrefs: string; roleLabel: string; langCode: string; langLabel: string; nextLang: "ar" | "en"; themeLabel: string; nextTheme: "light" | "dark"; dark: boolean;
  lang?: "ar" | "en"; theme?: "light" | "dark" | null; themeTitle?: string; themeDark?: string; themeLight?: string; themeSystem?: string; langTitle?: string;
}

const initials = (n: string) => Array.from(n.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] ?? "").join("") || "?").join("").toUpperCase();

/** Account menu in the top bar: profile header, shortcuts, language / theme, sign out. Keyboard and screen-reader friendly. */
export function NavUser({ name, email, admin, text, avatar }: { name: string; email: string; admin: boolean; text: NavUserText; avatar?: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  const menuId = useId();

  const items = useCallback(() => Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []), []);
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) trigger.current?.focus(); }, []);

  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("touchstart", onDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); };
  }, [open]);
  useEffect(() => { if (open) items()[0]?.focus(); }, [open, items]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (!open) return;
    const list = items(); const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  // Studio's UserDropdown: a round 32px avatar; the menu: name and e-mail, the account links, theme and language as
  // radio groups, sign out. Items are 12px text with 14px icons in the lighter foreground, like Supabase's dropdown-menu.
  const face = (cls: string) => <Avatar name={name || email} src={avatar} size={cls === "sm" ? "sm" : cls === "lg" ? "lg" : "md"} />;
  const radio = (on: boolean) => <span className={`dm-radio${on ? " on" : ""}`} aria-hidden="true" />;
  return (
    <div className="navuser" ref={root} onKeyDown={onKey}>
      <button ref={trigger} type="button" className="navuser-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`${text.menu}: ${name || email}`} title={name || email} onClick={() => setOpen((v) => !v)}>
        {face("sm")}
      </button>
      {open && <div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="menu dm" id={menuId} role="menu" aria-label={text.menu}>
          <div className="dm-head" role="presentation">
            <span className="dm-name" title={name || email}>{name || email}</span>
            {name && <span className="dm-mail ltr" title={email}>{email}</span>}
            <span className="dm-role">{admin ? <ShieldCheck size={12} aria-hidden="true" /> : null}{text.roleLabel}</span>
          </div>
          <div className="dm-sep" role="separator" />
          <Link role="menuitem" href="/patients" className="dm-item" tabIndex={-1}><Users size={14} strokeWidth={1.5} aria-hidden="true" />{text.patients}</Link>
          <Link role="menuitem" href="/shares" className="dm-item" tabIndex={-1}><Link2 size={14} strokeWidth={1.5} aria-hidden="true" />{text.shares}</Link>
          <Link role="menuitem" href="/account" className="dm-item" tabIndex={-1}><Settings size={14} strokeWidth={1.5} aria-hidden="true" />{text.account}</Link>
          {admin && <Link role="menuitem" href="/admin/specialties" className="dm-item" tabIndex={-1}><ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />{text.admin}</Link>}
          <div className="dm-sep" role="separator" />
          <div className="dm-label" role="presentation">{text.themeTitle}</div>
          {([["dark", text.themeDark], ["light", text.themeLight], ["system", text.themeSystem]] as const).map(([v, l]) => (
            <form action={setTheme} role="none" key={v}>
              <input type="hidden" name="theme" value={v} />
              <button role="menuitemradio" aria-checked={(text.theme ?? "system") === v} className="dm-item dm-radio-item" tabIndex={-1}>{radio((text.theme ?? "system") === v)}{l}</button>
            </form>
          ))}
          <div className="dm-label" role="presentation">{text.langTitle}</div>
          {([["ar", "العربية"], ["en", "English"]] as const).map(([v, l]) => (
            <form action={setLang} role="none" key={v}>
              <input type="hidden" name="lang" value={v} />
              <button role="menuitemradio" aria-checked={text.lang === v} className="dm-item dm-radio-item" tabIndex={-1} lang={v}>{radio(text.lang === v)}{l}</button>
            </form>
          ))}
          <div className="dm-sep" role="separator" />
          <form action={async () => { await logout(); window.location.assign("/login"); }} role="none">
            <button role="menuitem" className="dm-item" tabIndex={-1}><LogOut size={14} strokeWidth={1.5} aria-hidden="true" />{text.signOut}</button>
          </form>
        </div>
      )}
    </div>
  );
}
