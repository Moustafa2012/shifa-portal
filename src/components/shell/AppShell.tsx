import Link from "next/link";
import { Suspense } from "react";
import { Bell, ChevronsUpDown, Plus } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { getTheme } from "@/lib/auth";
import { LogoMark } from "@/components/Logo";
import { NavUser } from "@/components/NavUser";
import { Footer } from "@/components/Footer";
import { getSidebarMode } from "@/lib/auth";
import { ShellSearchBox } from "./ShellSearch";
import { ShellCrumbTail, ShellMobile, ShellProductMenu, ShellRail, ShellSubnav } from "./ShellNav";
import type { Crumb, ShellNav } from "./nav";

export interface ShellUser { name: string; email: string; avatar?: string | null; admin: boolean }
export interface Switcher { current: string; items: { href: string; label: string; sub?: string }[]; addHref?: string }

/**
 * The signed-in app (Supabase-style): a rail of products on the side, the active product's menu next to it, a slim
 * top bar with the path (and a patient switcher), and the page.
 */
/** `search`: a box in the top bar that opens a search page (GET ?q=) */
export interface ShellSearch { action: string; label: string; placeholder: string }

/** `reminders`: the number on the bell (overdue and soon-due reminders across the account's files); the bell links to the reminders centre */
export function AppShell({ nav, crumbs, switcher, user, search, reminders, children }: { nav: ShellNav; crumbs: Crumb[]; switcher?: Switcher; user: ShellUser; search?: ShellSearch; reminders?: number; children: React.ReactNode }) {
  const { lang, t } = i18n();
  const dark = getTheme() === "dark";
  return (
    <div className="shell">
      <header className="shell-top no-print">
        <Suspense fallback={null}><ShellMobile nav={nav} label={t("التنقل", "Navigation")} openLabel={t("فتح القائمة", "Open the menu")} closeLabel={t("إغلاق", "Close")} /></Suspense>
        <Link href="/patients" className="shell-brand" aria-label={t("بوابة شفاء — المرضى", "Shifa Portal — patients")}><LogoMark size={26} /></Link>
        <ol className="crumbs" aria-label={t("المسار", "Path")}>
          {crumbs.map((c, i) => (
            <li key={i}>{c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>}</li>
          ))}
          {switcher && (
            <li className="crumb-switch">
              <details className="switcher">
                <summary aria-label={t("تبديل المريض", "Switch patient")}><strong>{switcher.current}</strong><ChevronsUpDown size={14} aria-hidden="true" /></summary>
                <div className="switcher-menu" role="menu">
                  {switcher.items.map((it) => (
                    <Link key={it.href} href={it.href} role="menuitem"><span>{it.label}</span>{it.sub && <span className="muted small ltr">{it.sub}</span>}</Link>
                  ))}
                  {switcher.addHref && <Link href={switcher.addHref} role="menuitem" className="switcher-add"><Plus size={14} aria-hidden="true" />{t("ملف مريض جديد", "New patient file")}</Link>}
                </div>
              </details>
            </li>
          )}
          <Suspense fallback={null}><ShellCrumbTail nav={nav} /></Suspense>
        </ol>
        <div className="spacer" />
        {search && <ShellSearchBox action={search.action} label={search.label} placeholder={search.placeholder} openLabel={t("بحث", "Search")} closeLabel={t("إغلاق البحث", "Close search")} />}
        <Link href="/reminders" className="shell-bell" data-testid="reminder-bell"
          aria-label={reminders ? t(`التذكيرات: ${reminders} تحتاج انتباهاً`, `Reminders: ${reminders} need attention`) : t("التذكيرات", "Reminders")}>
          <Bell size={18} aria-hidden="true" />{reminders ? <span className="bell-badge" data-testid="reminder-count">{reminders > 99 ? "99+" : reminders}</span> : null}
        </Link>
        <NavUser name={user.name} email={user.email} avatar={user.avatar} admin={user.admin} text={{
          patients: t("المرضى", "Patients"), shares: t("سجل المشاركات", "Share register"), account: t("حسابي", "My account"), admin: t("الإدارة", "Admin"), signOut: t("تسجيل الخروج", "Sign out"), menu: t("قائمة الحساب", "Account menu"), sectionAccount: t("الحساب", "Account"), sectionPrefs: t("التفضيلات", "Preferences"), roleLabel: user.admin ? t("مدير النظام", "Administrator") : t("مستخدم", "Member"), langCode: lang === "ar" ? "AR" : "EN",
          langLabel: lang === "ar" ? "English" : "العربية", nextLang: lang === "ar" ? "en" : "ar",
          themeLabel: dark ? t("المظهر الفاتح", "Light mode") : t("المظهر الداكن", "Dark mode"), nextTheme: dark ? "light" : "dark", dark,
            lang, theme: getTheme(), themeTitle: t("المظهر", "Theme"), themeDark: t("داكن", "Dark"), themeLight: t("فاتح", "Light"), themeSystem: t("حسب النظام", "System"), langTitle: t("اللغة", "Language"),
        }} />
      </header>
      {/* below the full-width top bar: the rail's column (it widens, pushing what is next to it) and the rest */}
      <div className="shell-below">
        <Suspense fallback={<nav className="rail no-print" />}><ShellRail nav={nav} label={t("الأقسام الرئيسية", "Main sections")} initialMode={getSidebarMode()}
          behaviourLabels={{ title: t("الشريط الجانبي", "Sidebar"), open: t("مفتوح دائماً", "Expanded"), closed: t("مطوي", "Collapsed"), hover: t("يتوسع عند المرور", "Expand on hover") }} /></Suspense>
        <div className="shell-col">
          <Suspense fallback={null}><ShellSubnav nav={nav} /></Suspense>
          <div className="shell-body">
            <Suspense fallback={null}><ShellProductMenu nav={nav} /></Suspense>
            <main id="main" className="shell-content">
              <div className="shell-page">{children}</div>
              <Footer />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The products outside a patient file: patients, the share register, the account, the administration. */
export function globalNav(admin: boolean, t: (a: string, e: string) => string): ShellNav {
  return {
    products: [
      { key: "patients", label: t("المرضى", "Patients"), icon: "patients", href: "/patients", match: ["/patients"] },
      { key: "reminders", label: t("التذكيرات", "Reminders"), icon: "reminders", href: "/reminders", match: ["/reminders"] },
      { key: "shares", label: t("سجل المشاركات", "Share register"), icon: "shares", href: "/shares", match: ["/shares"] },
    ],
    footer: [
      ...(admin ? [{ key: "admin", label: t("الإدارة", "Admin"), icon: "admin", href: "/admin/specialties", match: ["/admin"],
        menu: { title: t("الإدارة", "Admin"), groups: [{ items: [{ href: "/admin/specialties", label: t("الأقسام الطبية", "Specialties"), icon: "specialties" },
          { href: "/admin/safety-rules", label: t("قواعد تنبيهات السلامة", "Safety alert rules"), icon: "audit" }] }] } }] : []),
      { key: "account", label: t("حسابي", "My account"), icon: "account", href: "/account", match: ["/account"] },
    ],
  };
}
