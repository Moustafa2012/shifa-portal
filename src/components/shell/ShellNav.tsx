"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity, AlertTriangle, ArrowLeftRight, CalendarDays, ClipboardList, FileText, FlaskConical, FolderHeart, FolderOpen, HeartPulse, History, Home, Layers,
  Link2, Menu, NotebookPen, Pill, ScanLine, Scissors, Settings, Share2, ShieldCheck, Smile, Stethoscope, Syringe, TestTube2, UserRound, Users, X,
  LayoutGrid, Stethoscope as Visit, Image as ImageIcon, ListChecks, Wrench, Trash2, BellRing, PanelLeft, Ruler, Search, Thermometer, Siren, UserPlus, type LucideIcon,
} from "lucide-react";
import { SpecialtyIcon } from "@/components/Icon";
import { activeProduct, groupVisible, itemActive, type ShellItem, type ShellNav as Nav, type ShellProduct } from "./nav";

const ICONS: Record<string, LucideIcon> = {
  home: Home, core: UserRound, timeline: History, follow: Activity, specialties: Layers, records: FolderHeart, docs: FolderOpen,
  patients: Users, shares: Link2, account: Settings, admin: ShieldCheck, switch: ArrowLeftRight,
  vitals: Activity, labs: FlaskConical, "test-orders": TestTube2, "care-plans": ClipboardList, conditions: HeartPulse, allergies: AlertTriangle,
  medications: Pill, visits: Stethoscope, procedures: Scissors, imaging: ScanLine, appointments: CalendarDays, notes: NotebookPen,
  immunizations: Syringe, "family-history": Users, documents: FileText, sharing: Share2, audit: ShieldCheck, dental: Smile, other: LayoutGrid,
  symptoms: Thermometer, reminders: BellRing, emergency: Siren, members: UserPlus, search: Search, chart: Smile, problems: HeartPulse, treatment: ListChecks, perio: Ruler, followup: BellRing, care: Visit, images: ImageIcon, profile: Wrench, delete: Trash2,
};

function ItemIcon({ it, size = 16 }: { it: Pick<ShellItem, "icon" | "specialtyIcon">; size?: number }) {
  if (it.specialtyIcon) return <SpecialtyIcon name={it.specialtyIcon} size={size} />;
  const I = ICONS[it.icon ?? ""] ?? FolderHeart;
  return <I size={size} aria-hidden="true" />;
}

function useNav(nav: Nav) {
  const path = usePathname();
  const tab = useSearchParams().get("tab");
  return { path, tab, active: activeProduct(nav, path) };
}

export type Behaviour = "hover" | "open" | "closed";
/** Cookie holding the sidebar mode (read by getSidebarMode on the server, so the first paint already has the right width: no flash). */
const BEHAVIOUR_COOKIE = "sidebar";
const LEGACY_KEY = "shifa-sidebar";
const isBehaviour = (v: unknown): v is Behaviour => v === "hover" || v === "open" || v === "closed";

/**
 * The product rail (Studio's Sidebar): icons in groups divided by separators. Three modes, chosen in the footer menu:
 * expanded (13rem, labels), collapsed (3rem, icons with tooltips) and expand on hover (3rem at rest; on hover or keyboard
 * focus it widens). The rail is a column of the shell, never an overlay: when it widens, the menu and the page move aside.
 */
export function ShellRail({ nav, label, behaviourLabels, initialMode = "hover" }: { nav: Nav; label: string; behaviourLabels?: { title: string; open: string; closed: string; hover: string }; initialMode?: Behaviour }) {
  const { active } = useNav(nav);
  const [mode, setMode] = useState<Behaviour>(initialMode);
  const [menu, setMenu] = useState(false);
  const [place, setPlace] = useState<{ bottom: number; start: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => { document.documentElement.dataset.sidebar = mode; }, [mode]);
  // a choice made before the cookie existed lived in localStorage: carry it over once
  useEffect(() => {
    try {
      const old = localStorage.getItem(LEGACY_KEY);
      if (old === null) return;
      localStorage.removeItem(LEGACY_KEY);
      if (!document.cookie.split("; ").some((c) => c.startsWith(`${BEHAVIOUR_COOKIE}=`)) && isBehaviour(old)) { setMode(old); writeCookie(old); }
    } catch { /* storage may be blocked */ }
  }, []);
  const choose = (m: Behaviour) => { setMode(m); setMenu(false); writeCookie(m); trigger.current?.focus(); };

  // the menu is drawn in a portal (the rail clips its content), above the button; it closes on Escape and on a click outside
  useEffect(() => {
    if (!menu) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPlace({ bottom: window.innerHeight - r.top + 4, start: document.dir === "rtl" ? window.innerWidth - r.right : r.left });
    const onDown = (e: MouseEvent | TouchEvent) => {
      const n = e.target as Node;
      if (!pop.current?.contains(n) && !trigger.current?.contains(n)) setMenu(false);
    };
    document.addEventListener("mousedown", onDown); document.addEventListener("touchstart", onDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); };
  }, [menu]);
  useEffect(() => { if (menu && place) (pop.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? pop.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus(); }, [menu, place]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(false); trigger.current?.focus(); return; }
    const list = Array.from(pop.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") setMenu(false);
  };
  const link = (p: ShellProduct) => (
    <Link key={p.key} href={p.href} className="rail-link" aria-current={active?.key === p.key ? "page" : undefined} title={p.label} data-product={p.key}>
      <ItemIcon it={{ icon: p.icon }} size={18} /><span className="rail-label">{p.label}</span>
    </Link>
  );
  const groups: ShellProduct[][] = [];
  for (const p of nav.products) {
    const g = p.group ?? 0;
    const last = groups[groups.length - 1];
    if (last && (last[0].group ?? 0) === g) last.push(p); else groups.push([p]);
  }
  return (
    <nav className={`rail no-print${menu ? " menu-open" : ""}`} aria-label={label} data-mode={mode}>
      <div className="rail-in">
        {nav.home && (
          <>
            <Link href={nav.home.href} className="rail-link" title={nav.home.label}>
              <ItemIcon it={{ icon: "patients" }} size={18} /><span className="rail-label">{nav.home.label}</span>
            </Link>
            <div className="rail-sep" role="separator" />
          </>
        )}
        <div className="rail-items">
          {groups.map((g, i) => (
            <div key={i} className="rail-group">
              {i > 0 && <div className="rail-sep" role="separator" />}
              {g.map(link)}
            </div>
          ))}
        </div>
        <div className="rail-foot">
          {nav.footer.map(link)}
          {behaviourLabels && (
            <div className="rail-behaviour">
              <button ref={trigger} type="button" className="rail-link" aria-haspopup="menu" aria-expanded={menu} title={behaviourLabels.title} data-testid="rail-behaviour" onClick={() => setMenu((v) => !v)}>
                <PanelLeft size={18} aria-hidden="true" /><span className="rail-label">{behaviourLabels.title}</span>
              </button>
              {menu && createPortal(
                <div ref={pop} className="menu dm rail-behaviour-menu" role="menu" aria-label={behaviourLabels.title} onKeyDown={onMenuKey}
                  style={place ? { insetBlockEnd: place.bottom, insetInlineStart: place.start } : { visibility: "hidden" }}>
                  <div className="dm-label" role="presentation">{behaviourLabels.title}</div>
                  {([["open", behaviourLabels.open], ["closed", behaviourLabels.closed], ["hover", behaviourLabels.hover]] as const).map(([m, l]) => (
                    <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} className="dm-item dm-radio-item" data-mode={m} onClick={() => choose(m)}>
                      <span className={`dm-radio${mode === m ? " on" : ""}`} aria-hidden="true" />{l}
                    </button>
                  ))}
                </div>, document.body,
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

function writeCookie(m: Behaviour) {
  try { document.cookie = `${BEHAVIOUR_COOKIE}=${m}; path=/; max-age=31536000; samesite=lax`; } catch { /* cookies may be blocked */ }
}

function MenuGroups({ product, path, tab, onNavigate }: { product: ShellProduct; path: string; tab: string | null; onNavigate?: () => void }) {
  return (
    <>
      {product.menu!.groups.filter((g) => groupVisible(g, path)).map((g, gi) => (
        <div className="pm-group" key={gi}>
          {g.label && <div className="pm-group-label">{g.label}</div>}
          <ul>
            {g.items.map((it) => (
              <li key={it.href + (it.tab ?? "")}>
                <Link href={it.href} aria-current={itemActive(it, path, tab) ? "page" : undefined} onClick={onNavigate}>
                  <ItemIcon it={it} /><span>{it.label}</span>{it.badge && <span className="pm-badge">{it.badge}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The menu of the active product (Studio's ProductMenuBar): a header strip with the title, then groups of text items. */
export function ShellProductMenu({ nav }: { nav: Nav }) {
  const { path, tab, active } = useNav(nav);
  if (!active?.menu) return null;
  return (
    <nav className="product-menu no-print" aria-label={active.menu.title}>
      <div className="pm-head"><h4 className="pm-title">{active.menu.title}</h4></div>
      <div className="pm-body"><MenuGroups product={active} path={path} tab={tab} /></div>
    </nav>
  );
}

/** Small screens: a horizontal strip of the active product's pages, and a drawer with every product. */
export function ShellMobile({ nav, label, openLabel, closeLabel }: { nav: Nav; label: string; openLabel: string; closeLabel: string }) {
  const { path, tab, active } = useNav(nav);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path, tab]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);
  return (
    <>
      <button type="button" className="btn ghost sm shell-burger no-print" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} aria-label={openLabel}>
        <Menu size={20} aria-hidden="true" />
      </button>
      {/* in a portal: the top bar's backdrop filter would otherwise confine a fixed drawer to the bar */}
      {open && createPortal(
        <div className="drawer-wrap no-print" onClick={() => setOpen(false)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
            <div className="row between drawer-head">
              <strong>{label}</strong>
              <button type="button" className="btn ghost sm" onClick={() => setOpen(false)} aria-label={closeLabel}><X size={18} aria-hidden="true" /></button>
            </div>
            {nav.home && <Link className="drawer-link" href={nav.home.href}><ItemIcon it={{ icon: "patients" }} size={18} />{nav.home.label}</Link>}
            {[...nav.products, ...nav.footer].map((p) => (
              <div key={p.key} className="drawer-product">
                <Link className="drawer-link" href={p.href} aria-current={active?.key === p.key ? "page" : undefined}><ItemIcon it={{ icon: p.icon }} size={18} />{p.label}</Link>
                {active?.key === p.key && p.menu && <div className="drawer-sub"><MenuGroups product={p} path={path} tab={tab} onNavigate={() => setOpen(false)} /></div>}
              </div>
            ))}
          </div>
        </div>, document.body,
      )}
    </>
  );
}

/** The active product's pages as a scrollable strip under the top bar (small screens only). */
export function ShellSubnav({ nav }: { nav: Nav }) {
  const { path, tab, active } = useNav(nav);
  if (!active?.menu) return null;
  const groups = active.menu.groups.filter((g) => groupVisible(g, path));
  // inside a specialty with its own sections, the strip shows those sections
  const own = groups.find((g) => g.onlyOn);
  const items = own ? own.items : groups.flatMap((g) => g.items);
  return (
    <nav className="shell-subnav no-print" aria-label={active.menu.title}>
      {items.map((it) => (
        <Link key={it.href + (it.tab ?? "")} href={it.href} aria-current={itemActive(it, path, tab) ? "page" : undefined}>
          <ItemIcon it={it} size={15} />{it.label}{it.badge ? ` (${it.badge})` : ""}
        </Link>
      ))}
    </nav>
  );
}

/** The end of the path in the top bar: the active product, and the page within it. */
export function ShellCrumbTail({ nav }: { nav: Nav }) {
  const { path, tab, active } = useNav(nav);
  if (!active) return null;
  // the page, and inside a specialty with its own sections also the specialty: Specialty files / Dentistry / Chart & exams
  const hits = (active.menu?.groups ?? []).filter((g) => groupVisible(g, path)).flatMap((g) => g.items).filter((it) => itemActive(it, path, tab) && it.label !== active.label);
  const trail = [...hits.filter((it) => it.tab === undefined).slice(0, 1), ...hits.filter((it) => it.tab !== undefined).slice(0, 1)];
  return (
    <>
      <li>{trail.length ? <Link href={active.href}>{active.label}</Link> : <span aria-current="page">{active.label}</span>}</li>
      {trail.map((it, i) => (
        <li key={it.href}>{i < trail.length - 1 ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}</li>
      ))}
    </>
  );
}
