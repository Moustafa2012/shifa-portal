import Link from "next/link";
import { TriangleAlert, ShieldCheck, CircleHelp, Printer, Download } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { getAccess, getPatient, getSpecialties, getSpecialtyUsage } from "@/lib/data";
import { currentProfile, requireUser } from "@/lib/auth";
import { AppShell, globalNav } from "@/components/shell/AppShell";
import type { ShellItem, ShellNav } from "@/components/shell/nav";
import { ageLabel } from "@/lib/format";
import { ALLERGY_SEVERITY, lbl, SEX } from "@/lib/labels";
import { Chip } from "@/components/ui";
import { Avatar } from "@/components/Avatar";
import { getReminderCount } from "@/lib/care/server";

export default async function PatientLayout({ children, params }: { children: React.ReactNode; params: { pid: string } }) {
  const { lang, t } = i18n();
  // one wave of round trips instead of three in a row
  const dentId = (await getSpecialties()).find((x) => x.code === "dentistry")?.id ?? "00000000-0000-0000-0000-000000000000";
  const todayIso = new Date().toISOString().slice(0, 10);
  const [p, access, used, { data: allergies }, authed, profile, { data: mine }, { count: unassigned }, { count: openPlans }, { count: overdue }, { count: perioDraft }, reminderCount] = await Promise.all([
    getPatient(params.pid),
    getAccess(params.pid),
    getSpecialtyUsage(params.pid),
    createClient().from("allergies").select("substance, severity").eq("patient_id", params.pid).eq("status", "active").eq("record_status", "active").neq("certainty", "refuted").limit(6),
    requireUser(),
    currentProfile(),
    createClient().from("patients").select("id, full_name, full_name_en, mrn").order("full_name").limit(50),
    // counts shown in the dental sections of the menu
    createClient().from("conditions").select("id", { count: "exact", head: true }).eq("patient_id", params.pid).eq("record_status", "active")
      .eq("specialty_id", dentId).is("teeth", null).in("clinical_status", ["active", "recurrence"]).neq("certainty", "refuted"),
    createClient().from("treatment_plans").select("id", { count: "exact", head: true }).eq("patient_id", params.pid).eq("record_status", "active")
      .in("status", ["draft", "proposed", "accepted", "in_progress"]),
    createClient().from("recalls").select("id", { count: "exact", head: true }).eq("patient_id", params.pid).eq("record_status", "active")
      .eq("status", "active").lt("due_on", todayIso),
    createClient().from("perio_exams").select("id", { count: "exact", head: true }).eq("patient_id", params.pid).eq("record_status", "active").eq("status", "draft"),
    getReminderCount(),
  ]);
  const admin = profile?.role === "admin";
  const base = `/patients/${p.id}`;

  // the shell (Supabase-style): products on the rail, and the active product's pages in the menu next to it
  const P = (slug: string) => `${base}/${slug}`;
  const item = (slug: string, label: string, extra: Partial<ShellItem> = {}): ShellItem => ({ href: P(slug), label, icon: slug, ...extra });
  const usedItems: ShellItem[] = used.map((u) => ({
    href: u.code === "dentistry" ? P("dental") : P(`specialties/${u.code}`), label: lang === "ar" ? u.name_ar : u.name_en, specialtyIcon: u.icon,
  }));
  const follow = [item("vitals", t("القياسات (ضغط، سكر…)", "Vitals (BP, glucose…)")), item("labs", t("التحاليل المخبرية", "Lab results")),
    item("test-orders", t("الفحوصات المطلوبة", "Requested tests")), item("care-plans", t("خطط المتابعة", "Care plans")),
    item("symptoms", t("سجل الأعراض", "Symptom log")), item("reminders", t("التذكيرات", "Reminders"))];
  const records = [item("search", t("بحث داخل الملف", "Search this file")), item("conditions", t("الأمراض والتشخيصات", "Conditions")), item("allergies", t("الحساسية", "Allergies")), item("medications", t("الأدوية", "Medications")),
    item("visits", t("الزيارات", "Visits")), item("procedures", t("العمليات والإجراءات", "Procedures")), item("imaging", t("الأشعة والتصوير", "Imaging")),
    item("appointments", t("المواعيد", "Appointments")), item("notes", t("الملاحظات", "Notes")), item("immunizations", t("التطعيمات", "Immunizations")),
    item("family-history", t("التاريخ العائلي", "Family history"))];
  const docs = [
    item("reports", t("مركز وفهرس التقارير", "Reports center & index")),
    item("documents", t("المستندات المرفقة", "Attached documents")),
    ...(access.canShare ? [item("sharing", t("المشاركة مع طبيب", "Share with a doctor"))] : []),
    item("emergency", t("بطاقة الطوارئ", "Emergency card")),
    ...(access.canManage ? [item("members", t("الأعضاء والدعوات", "Members & invitations"))] : []),
    ...(access.canManage ? [item("audit", t("سجل التغييرات", "Change history"))] : [])
  ];
  const nav: ShellNav = {
    home: { href: "/patients", label: t("كل المرضى", "All patients") },
    products: [
      { key: "summary", label: t("الملخص", "Summary"), icon: "home", href: base, match: [`=${base}`], group: 0 },
      { key: "core", label: t("الملف الأساسي", "Core file"), icon: "core", href: P("profile"), match: [P("profile")], group: 1 },
      { key: "timeline", label: t("الخط الزمني", "Timeline"), icon: "timeline", href: P("timeline"), match: [P("timeline")], group: 1 },
      { key: "follow", label: t("المتابعة", "Follow-up"), icon: "follow", href: P("vitals"), match: follow.map((x) => x.href), group: 2,
        menu: { title: t("المتابعة", "Follow-up"), groups: [{ items: follow }] } },
      { key: "specialties", label: t("الأقسام الطبية", "Specialty files"), icon: "specialties", href: usedItems[0]?.href ?? P("specialties"), group: 2,
        match: [P("specialties"), P("dental")],
        menu: { title: t("الأقسام الطبية", "Specialty files"), groups: [
          ...(usedItems.length ? [{ label: t("المستخدمة في هذا الملف", "Used in this file"), items: usedItems }] : []),
          { items: [{ href: P("specialties"), label: usedItems.length ? t("فتح قسم آخر", "Open another specialty") : t("كل الأقسام", "All specialties"), icon: "other", exact: true }] },
          // inside the dental file, its own sections
          { label: t("ملف الأسنان", "Dental file"), onlyOn: P("dental"), items: [
            { href: `${P("dental")}?tab=chart`, tab: "chart", defaultTab: true, label: t("المخطط والفحوص", "Chart & exams"), icon: "chart" },
            { href: `${P("dental")}?tab=problems`, tab: "problems", icon: "problems",
              label: unassigned ? t(`المشكلات والتشخيصات (${unassigned} بلا سن)`, `Problems & diagnoses (${unassigned} without a tooth)`) : t("المشكلات والتشخيصات", "Problems & diagnoses") },
            { href: `${P("dental")}?tab=treatment`, tab: "treatment", icon: "treatment", label: t("العلاج", "Treatment"), badge: openPlans ? String(openPlans) : undefined },
            { href: `${P("dental")}?tab=perio`, tab: "perio", icon: "perio", label: t("مخطط اللثة", "Periodontal chart"), badge: perioDraft ? t("مسودة", "draft") : undefined },
            { href: `${P("dental")}?tab=followup`, tab: "followup", icon: "followup", label: t("المتابعة والفحص الدوري", "Follow-up & recalls"), badge: overdue ? String(overdue) : undefined },
            { href: `${P("dental")}?tab=care`, tab: "care", icon: "care", label: t("الزيارات والإجراءات", "Visits & procedures") },
            { href: `${P("dental")}?tab=imaging`, tab: "imaging", icon: "images", label: t("الصور والأشعة", "Images & X-rays") },
            { href: `${P("dental")}?tab=profile`, tab: "profile", icon: "profile", label: t("الملف السني", "Dental profile") },
          ] },
        ] } },
      { key: "records", label: t("السجلات", "Records"), icon: "records", href: P("conditions"), match: records.map((x) => x.href), group: 2,
        menu: { title: t("السجلات", "Records"), groups: [{ items: records }] } },
      { key: "docs", label: t("المستندات والمشاركة", "Documents & sharing"), icon: "docs", href: P("reports"), group: 3, match: [...docs.map((x) => x.href), P("documents"), P("delete")],
        menu: { title: t("المستندات والمشاركة", "Documents & sharing"), groups: [{ items: docs }] } },
    ],
    footer: globalNav(admin, t).footer,
  };
  const name = lang === "en" && p.full_name_en ? p.full_name_en : p.full_name;

  const list = allergies ?? [];
  return (
    <AppShell nav={nav} crumbs={[{ href: "/patients", label: t("المرضى", "Patients") }]}
      search={{ action: `${base}/search`, label: t("بحث داخل هذا الملف", "Search inside this file"), placeholder: t("بحث في الملف…", "Search this file…") }}
      switcher={{ current: name, addHref: "/patients/new", items: (mine ?? []).map((x) => ({ href: `/patients/${x.id}`, label: lang === "en" && x.full_name_en ? x.full_name_en : x.full_name, sub: x.mrn })) }}
      reminders={reminderCount}
      user={{ name: profile?.full_name ?? "", email: authed.email ?? "", admin, avatar: profile?.avatar_path ? `/api/avatar?v=${encodeURIComponent(profile.updated_at)}` : null }}>
      <header className="card patient-head" style={{ marginBlockEnd: "1.25rem" }}>
        <div className="row between">
          <div className="row" style={{ flexWrap: "nowrap", gap: ".9rem" }}>
            <Avatar name={name} src={p.photo_path ? `/api/avatar?p=${p.id}&v=${encodeURIComponent(p.updated_at)}` : null} />
          <div>
            <h1 style={{ marginBottom: ".1rem" }}>{name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              <span className="ltr">{p.mrn}</span> · {ageLabel(p.date_of_birth, lang)} · {lbl(SEX, p.sex, lang)}
              {p.nationality ? ` · ${p.nationality}` : ""}
            </p>
          </div>
          </div>
          <div className="row" style={{ gap: ".4rem" }}>
            <Link className="btn sm" href={`${base}/reports`}><Printer size={14} aria-hidden="true" />{t("التقارير الطبية", "PDF reports")}</Link>
            <a className="btn ghost sm" href={`/api/patients/${p.id}/report?scope=full`} target="_blank" rel="noopener" title={t("طباعة فورية للملف الكامل", "Print full dossier")}><Download size={14} aria-hidden="true" /></a>
            {p.blood_abo ? <Chip tone="info" title={p.blood_group_verified ? t("موثقة", "Verified") : t("غير موثقة", "Unverified")}>{t("الدم", "Blood")}: <span className="ltr">{p.blood_abo}{p.blood_rh ?? ""}</span>{p.blood_group_verified ? "" : " *"}</Chip> : <Chip tone="muted">{t("فصيلة الدم غير مسجلة", "Blood group not recorded")}</Chip>}
          </div>
        </div>
        <div style={{ marginBlockStart: ".75rem" }}>
          {list.length > 0 ? (
            <div className="banner bad" role="alert">
              <TriangleAlert size={18} aria-hidden="true" style={{ flex: "none", marginBlockStart: 3 }} />
              <div><strong>{t("حساسية موثقة", "Documented allergies")}:</strong>{" "}
                {list.map((a, i) => <span key={i}>{i ? "، " : ""}{a.substance} ({lbl(ALLERGY_SEVERITY, a.severity, lang)})</span>)}</div>
            </div>
          ) : p.allergy_assertion === "none_known" ? (
            <div className="banner ok"><ShieldCheck size={18} aria-hidden="true" /><div>{t("لا توجد حساسية معروفة (إقرار مسجل).", "No known allergies (recorded statement).")}</div></div>
          ) : (
            <div className="banner warn"><CircleHelp size={18} aria-hidden="true" /><div><strong>{t("حالة الحساسية غير معروفة", "Allergy status unknown")}</strong> — {t("لم تُسجَّل بعد؛ لا يعني ذلك عدم وجود حساسية.", "not recorded yet; this does not mean there are none.")}</div></div>
          )}
        </div>
      </header>
      {p.deletion_requested_at && (
        <div className="banner warn" role="alert" style={{ marginBlockEnd: "1rem" }}>
          <TriangleAlert size={18} aria-hidden="true" style={{ flex: "none", marginBlockStart: 3 }} />
          <div>
            <strong>{t("هذا الملف مجدول للحذف", "This file is scheduled for deletion")}</strong> — {t("للقراءة فقط. ", "read-only. ")}
            {access.canManage && <Link href={`${base}/delete`}>{t("استعادة أو حذف الآن", "Restore or delete now")}</Link>}
          </div>
        </div>
      )}
      <div className="stack" style={{ minWidth: 0 }}>{children}</div>
    </AppShell>
  );
}
