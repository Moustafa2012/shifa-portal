import Link from "next/link";
import { Download, ExternalLink, FileText, Printer, Activity, FlaskConical, Smile, Siren, FileCheck, Stethoscope, Pill } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { getAccess, getPatient, getObsTypes } from "@/lib/data";
import { getTz } from "@/lib/auth";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { ENCOUNTER_KIND, lbl } from "@/lib/labels";
import { PLAN_STATUS } from "@/lib/treatment";
import { CONSENT_KIND, CONSENT_STATUS } from "@/lib/consent";
import { RX_STATUS } from "@/lib/prescription";
import { Chip, Empty, PageHead } from "@/components/ui";

type SP = Record<string, string | undefined>;

export default async function ReportsPage({ params, searchParams }: { params: { pid: string }; searchParams: SP }) {
  const { lang, t } = i18n();
  const tz = getTz();
  const p = await getPatient(params.pid);
  const access = await getAccess(p.id);
  const supabase = createClient();

  const reportLang: "ar" | "en" = searchParams.lang === "en" || searchParams.lang === "ar" ? searchParams.lang : lang;
  const range = searchParams.range ?? "90";
  const base = `/patients/${p.id}/reports`;

  const [obsTypes, { data: plansData }, { data: periosData }, { data: rxsData }, { data: consentsData }, { data: encsData }] = await Promise.all([
    getObsTypes(),
    supabase.from("treatment_plans").select("id, title, status, version, presented_on, accepted_on").eq("patient_id", p.id).eq("record_status", "active").order("version", { ascending: false }).limit(20),
    supabase.from("perio_exams").select("id, exam_date, status, examiner_name").eq("patient_id", p.id).eq("record_status", "active").order("exam_date", { ascending: false }).limit(20),
    supabase.from("prescriptions").select("id, issued_on, prescriber_name, status, notes").eq("patient_id", p.id).eq("record_status", "active").order("issued_on", { ascending: false }).limit(20),
    supabase.from("consents").select("id, title, kind, status, version, signer_name, signed_at").eq("patient_id", p.id).eq("record_status", "active").order("signed_at", { ascending: false }).limit(20),
    supabase.from("encounters").select("id, started_at, kind, reason, practitioner_name, facility_name").eq("patient_id", p.id).eq("record_status", "active").order("started_at", { ascending: false }).limit(25),
  ]);

  const plans = (plansData ?? []) as { id: string; title: string; status: string; version: number; presented_on: string | null; accepted_on: string | null }[];
  const perios = (periosData ?? []) as { id: string; exam_date: string; status: string; examiner_name: string | null }[];
  const rxs = (rxsData ?? []) as { id: string; issued_on: string; prescriber_name: string; status: string; notes: string | null }[];
  const consents = (consentsData ?? []) as { id: string; title: string; kind: string; status: string; version: number; signer_name: string; signed_at: string }[];
  const encs = (encsData ?? []) as { id: string; started_at: string; kind: string; reason: string | null; practitioner_name: string | null; facility_name: string | null }[];

  const langQuery = reportLang !== lang ? `&lang=${reportLang}` : "";
  const coreReports = [
    {
      id: "full",
      title: t("التقرير الطبي الشامل", "Complete Medical Record"),
      desc: t(
        "ملف متكامل يشمل بيانات المريض، إشارات السلامة، الحساسيات، الأمراض، الأدوية، القياسات، نتائج المختبر، العمليات، الأشعة، التطعيمات، خطط الرعاية والمستندات.",
        "Comprehensive health dossier including patient identity, safety alerts, allergies, conditions, medications, vitals, labs, procedures, imaging, immunizations, care plans, and attached documents."
      ),
      icon: FileText,
      badge: t("شامل ومرجعي", "Complete & Referenced"),
      badgeTone: "info" as const,
      previewUrl: `/api/patients/${p.id}/report?scope=full${langQuery}`,
      downloadUrl: `/api/patients/${p.id}/report?scope=full&dl=1${langQuery}`,
    },
    {
      id: "summary",
      title: t("الملخص الصحي التنفيذي", "Executive Health Summary"),
      desc: t(
        "ملخص موجز للملف الطبي يبرز إشارات السلامة الحيوية، الحساسيات، الأمراض المزمنة، الأدوية الفعالة، وآخر قراءات القياسات والتحاليل.",
        "Concise clinical overview highlighting critical safety flags, allergies, chronic illnesses, active medicines, and latest vital/lab readings."
      ),
      icon: Activity,
      badge: t("ملخص فوري", "Fast Summary"),
      badgeTone: "ok" as const,
      previewUrl: `/api/patients/${p.id}/report?scope=summary${langQuery}`,
      downloadUrl: `/api/patients/${p.id}/report?scope=summary&dl=1${langQuery}`,
    },
    {
      id: "vitals",
      title: t("تقرير القياسات الحيوية والرسوم البيانية", "Vital Signs & Trends Report"),
      desc: t(
        `تقرير جدولي وبياني لتطور الضغط، السكر، النبض، الوزن وباقي القياسات مع المتوسطات والحدود الطبيعية لفترة ${range === "all" ? t("كل الفترة", "all time") : t(`آخر ${range} يوماً`, `last ${range} days`)}.`,
        `Tabular and charted report showing BP, glucose, heart rate, weight trends, means, and reference intervals for ${range === "all" ? "all time" : `last ${range} days`}.`
      ),
      icon: Activity,
      badge: t("مخططات بيانية", "Visual Charts"),
      badgeTone: "ok" as const,
      previewUrl: `/api/patients/${p.id}/report?scope=vitals&range=${range}${langQuery}`,
      downloadUrl: `/api/patients/${p.id}/report?scope=vitals&range=${range}&dl=1${langQuery}`,
    },
    {
      id: "labs",
      title: t("تقرير التحاليل المخبرية المعتمدة", "Laboratory Results Report"),
      desc: t(
        "تقرير تحاليل موثق مرتب حسب المجموعات المخبرية (صورة الدم، وظائف الكلى، الدهون…) مع المجالات المرجعية وتصنيفات النتائج غير الطبيعية.",
        "Verified laboratory testing report organized by panel (CBC, renal, metabolic, lipids) with lab reference intervals and flags."
      ),
      icon: FlaskConical,
      badge: t("لوحات مخبرية", "Lab Panels"),
      badgeTone: "info" as const,
      previewUrl: `/api/patients/${p.id}/report?scope=labs${langQuery}`,
      downloadUrl: `/api/patients/${p.id}/report?scope=labs&dl=1${langQuery}`,
    },
    {
      id: "dental-summary",
      title: t("ملخص طب الأسنان الشامل", "Dental Summary Report"),
      desc: t(
        "المخطط السني الحالي، الأسنان المفقودة والمرممة، حالة اللثة والجيوب، اختبارات حيوية العصب، قراءات العظم الشعاعي ومواعيد الفحص الدوري.",
        "Full odontogram state, missing and restored teeth, periodontal status, pulp vitality tests, radiographic bone assessment, and recall timers."
      ),
      icon: Smile,
      badge: t("ملف الأسنان", "Dental File"),
      badgeTone: "ok" as const,
      previewUrl: `/api/patients/${p.id}/dental/summary/pdf?${langQuery ? `lang=${reportLang}&` : ""}`.replace(/\?$/, ""),
      downloadUrl: `/api/patients/${p.id}/dental/summary/pdf?dl=1${langQuery}`,
    },
    {
      id: "emergency",
      title: t("بطاقة الطوارئ الطبية السريعة", "Medical Emergency Card"),
      desc: t(
        "بطاقة مدمجة للمحفظة أو شاشة الهاتف تحوي فصيلة الدم، الحساسيات الحرجة، الأجهزة المزروعة وسلامة الرنين المغناطيسي، وجهات الطوارئ مع رمز QR.",
        "Compact wallet card with blood group, severe allergies, implants with MRI safety, ICE emergency contacts, and live verification QR code."
      ),
      icon: Siren,
      badge: t("حالات الطوارئ", "Emergency"),
      badgeTone: "bad" as const,
      previewUrl: `/api/patients/${p.id}/emergency/pdf?${langQuery ? `lang=${reportLang}&` : ""}`.replace(/\?$/, ""),
      downloadUrl: `/api/patients/${p.id}/emergency/pdf?dl=1${langQuery}`,
    },
  ];

  return (
    <>
      <PageHead
        title={t("مركز وفهرس التقارير الطبية", "Medical Reports Index & Center")}
        sub={t(
          "فهرس متكامل لجميع التقارير الطبية بصيغة PDF عالية الدقة القابلة للتحميل والطباعة ومطابقة المعايير الطبية المعتمدة.",
          "Complete index of all high-resolution medical PDF reports ready for instant preview, printing, and regulatory download."
        )}
        actions={
          <div className="row" style={{ gap: ".5rem" }}>
            <a className="btn primary sm" href={`/api/patients/${p.id}/report?scope=full${langQuery}`} target="_blank" rel="noopener">
              <Printer size={15} aria-hidden="true" />
              {t("توليد التقرير الشامل (PDF)", "Generate Full File (PDF)")}
            </a>
          </div>
        }
      />

      {/* Control bar: Language switcher & Range selector */}
      <div className="card" style={{ padding: ".75rem 1.25rem", marginBlockEnd: "1rem" }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: ".8rem" }}>
          <div className="row" style={{ gap: ".6rem" }}>
            <span className="small muted"><strong>{t("لغة التقرير:", "Report Language:")}</strong></span>
            <Link className={`btn sm ${reportLang === "ar" ? "primary" : "ghost"}`} href={`${base}?lang=ar&range=${range}`}>
              العربية
            </Link>
            <Link className={`btn sm ${reportLang === "en" ? "primary" : "ghost"}`} href={`${base}?lang=en&range=${range}`}>
              English
            </Link>
          </div>
          <div className="row" style={{ gap: ".4rem" }}>
            <span className="small muted"><strong>{t("نطاق القياسات:", "Vitals Window:")}</strong></span>
            {[
              { val: "30", label: t("30 يوماً", "30 days") },
              { val: "90", label: t("90 يوماً", "90 days") },
              { val: "365", label: t("سنة", "1 year") },
              { val: "all", label: t("الكل", "All") },
            ].map((r) => (
              <Link key={r.val} className={`btn sm ${range === r.val ? "secondary" : "ghost"}`} href={`${base}?lang=${reportLang}&range=${r.val}`}>
                {r.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Core Reports Grid */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "1.25rem .75rem" }}>
        {t("التقارير الطبية الرسمية الشاملة", "Core Medical Dossiers & Reports")}
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "1rem" }}>
        {coreReports.map((rep) => {
          const Icon = rep.icon;
          return (
            <div className="card" key={rep.id} style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div className="row between" style={{ marginBlockEnd: ".5rem" }}>
                  <div className="row" style={{ gap: ".5rem" }}>
                    <Icon size={18} className="brand-fg" aria-hidden="true" />
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>{rep.title}</h3>
                  </div>
                  <Chip tone={rep.badgeTone}>{rep.badge}</Chip>
                </div>
                <p className="small muted" style={{ marginBlockEnd: "1rem", lineHeight: 1.5 }}>
                  {rep.desc}
                </p>
              </div>
              <div className="row between" style={{ borderTop: "1px solid var(--border)", paddingTop: ".75rem" }}>
                <a className="btn sm" href={rep.previewUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden="true" />
                  {t("معاينة PDF", "Preview PDF")}
                </a>
                <a className="btn sm ghost" href={rep.downloadUrl} download>
                  <Download size={14} aria-hidden="true" />
                  {t("تحميل مباشر", "Download")}
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Section: Individual Treatment Plans */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "2rem .75rem" }}>
        {t("خطط علاج الأسنان المعتمدة", "Dental Treatment Plans")} ({plans.length})
      </h2>
      {plans.length === 0 ? (
        <Empty>{t("لا توجد خطط علاج مسجلة لهذا الملف بعد.", "No treatment plans recorded for this file yet.")}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t("خطة العلاج", "Plan Title")}</th>
                <th>{t("النسخة", "Version")}</th>
                <th>{t("الحالة", "Status")}</th>
                <th>{t("التاريخ", "Date")}</th>
                <th style={{ textAlign: "end" }}>{t("إجراءات التقرير", "Report Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((pl) => (
                <tr key={pl.id}>
                  <td><strong>{pl.title}</strong></td>
                  <td>v{pl.version}</td>
                  <td>
                    <Chip tone={pl.status === "accepted" || pl.status === "in_progress" ? "ok" : pl.status === "completed" ? "info" : "muted"}>
                      {lbl(PLAN_STATUS, pl.status, lang)}
                    </Chip>
                  </td>
                  <td className="small muted">{pl.accepted_on ? fmtDate(pl.accepted_on, lang, tz) : pl.presented_on ? fmtDate(pl.presented_on, lang, tz) : "—"}</td>
                  <td style={{ textAlign: "end" }}>
                    <span className="row" style={{ justifyContent: "flex-end", gap: ".4rem" }}>
                      <a className="btn sm" href={`/api/patients/${p.id}/treatment-plans/${pl.id}/pdf${langQuery ? `?lang=${reportLang}` : ""}`} target="_blank" rel="noopener">
                        <Printer size={13} aria-hidden="true" />
                        {t("الخطة والإقرار", "Plan & Consent")}
                      </a>
                      <a className="btn sm ghost" href={`/api/patients/${p.id}/treatment-plans/${pl.id}/pdf?costs=1${langQuery}`} target="_blank" rel="noopener" title={t("مع التكاليف", "with costs")}>
                        {t("بالتكلفة", "With costs")}
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Section: Periodontal Charts */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "2rem .75rem" }}>
        {t("مخططات وفحوصات اللثة", "Periodontal Charts & Staging")} ({perios.length})
      </h2>
      {perios.length === 0 ? (
        <Empty>{t("لا توجد فحوصات لثة مسجلة بعد.", "No periodontal exams recorded yet.")}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t("تاريخ الفحص", "Exam Date")}</th>
                <th>{t("الفاحص", "Examiner")}</th>
                <th>{t("الحالة", "Status")}</th>
                <th style={{ textAlign: "end" }}>{t("تقرير فحص اللثة (PDF)", "Perio Chart (PDF)")}</th>
              </tr>
            </thead>
            <tbody>
              {perios.map((pe) => (
                <tr key={pe.id}>
                  <td><strong>{fmtDate(pe.exam_date, lang, tz)}</strong></td>
                  <td className="muted small">{pe.examiner_name || "—"}</td>
                  <td>
                    <Chip tone={pe.status === "final" ? "ok" : "warn"}>
                      {pe.status === "final" ? t("معتمد", "Final") : t("مسودة", "Draft")}
                    </Chip>
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <span className="row" style={{ justifyContent: "flex-end", gap: ".4rem" }}>
                      <a className="btn sm" href={`/api/patients/${p.id}/perio/${pe.id}/pdf${langQuery ? `?lang=${reportLang}` : ""}`} target="_blank" rel="noopener">
                        <Printer size={13} aria-hidden="true" />
                        {t("تقرير المخطط (PDF)", "Print Chart")}
                      </a>
                      <a className="btn sm ghost" href={`/api/patients/${p.id}/perio/${pe.id}/pdf?dl=1${langQuery}`} download>
                        <Download size={13} aria-hidden="true" />
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Section: Prescriptions */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "2rem .75rem" }}>
        {t("الوصفات الطبية الصادرة", "Issued Prescriptions")} ({rxs.length})
      </h2>
      {rxs.length === 0 ? (
        <Empty>{t("لا توجد وصفات طبية مسجلة بعد.", "No prescriptions recorded yet.")}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t("تاريخ الصرف", "Issued Date")}</th>
                <th>{t("الطبيب الواصف", "Prescriber")}</th>
                <th>{t("الحالة", "Status")}</th>
                <th>{t("ملاحظات", "Notes")}</th>
                <th style={{ textAlign: "end" }}>{t("الوصفة الطبية (PDF)", "Prescription PDF")}</th>
              </tr>
            </thead>
            <tbody>
              {rxs.map((rx) => (
                <tr key={rx.id}>
                  <td><strong>{fmtDate(rx.issued_on, lang, tz)}</strong></td>
                  <td>{rx.prescriber_name}</td>
                  <td>
                    <Chip tone={rx.status === "active" ? "ok" : "bad"}>
                      {lbl(RX_STATUS, rx.status, lang)}
                    </Chip>
                  </td>
                  <td className="small muted">{rx.notes || "—"}</td>
                  <td style={{ textAlign: "end" }}>
                    <span className="row" style={{ justifyContent: "flex-end", gap: ".4rem" }}>
                      <a className="btn sm" href={`/api/patients/${p.id}/prescriptions/${rx.id}/pdf${langQuery ? `?lang=${reportLang}` : ""}`} target="_blank" rel="noopener">
                        <Pill size={13} aria-hidden="true" />
                        {t("طباعة الوصفة", "Print Rx")}
                      </a>
                      <a className="btn sm ghost" href={`/api/patients/${p.id}/prescriptions/${rx.id}/pdf?dl=1${langQuery}`} download>
                        <Download size={13} aria-hidden="true" />
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Section: Signed Consents */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "2rem .75rem" }}>
        {t("إقرارات الموافقة الموقعة", "Signed Informed Consents")} ({consents.length})
      </h2>
      {consents.length === 0 ? (
        <Empty>{t("لا توجد إقرارات موافقة موقعة بعد.", "No signed consents recorded yet.")}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t("عنوان الإقرار", "Consent Title")}</th>
                <th>{t("النوع", "Kind")}</th>
                <th>{t("الموقّع", "Signer")}</th>
                <th>{t("وقت التوقيع", "Signed At")}</th>
                <th>{t("الحالة", "Status")}</th>
                <th style={{ textAlign: "end" }}>{t("المستند الموقع (PDF)", "Signed PDF")}</th>
              </tr>
            </thead>
            <tbody>
              {consents.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.title}</strong> (v{c.version})</td>
                  <td>{lbl(CONSENT_KIND, c.kind, lang)}</td>
                  <td>{c.signer_name}</td>
                  <td className="small muted">{fmtDateTime(c.signed_at, lang, tz)}</td>
                  <td>
                    <Chip tone={c.status === "signed" ? "ok" : c.status === "withdrawn" ? "bad" : "muted"}>
                      {lbl(CONSENT_STATUS, c.status, lang)}
                    </Chip>
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <span className="row" style={{ justifyContent: "flex-end", gap: ".4rem" }}>
                      <a className="btn sm" href={`/api/patients/${p.id}/consents/${c.id}/pdf${langQuery ? `?lang=${reportLang}` : ""}`} target="_blank" rel="noopener">
                        <FileCheck size={13} aria-hidden="true" />
                        {t("عرض الإقرار والتوقيع", "View Signed")}
                      </a>
                      <a className="btn sm ghost" href={`/api/patients/${p.id}/consents/${c.id}/pdf?dl=1${langQuery}`} download>
                        <Download size={13} aria-hidden="true" />
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Section: Clinical Visits / Encounters */}
      <h2 style={{ fontSize: "1.1rem", marginBlock: "2rem .75rem" }}>
        {t("تقارير الزيارات السريرية والعيادات", "Clinical Encounters & Notes")} ({encs.length})
      </h2>
      {encs.length === 0 ? (
        <Empty>{t("لا توجد زيارات سريرية مسجلة بعد.", "No clinical visits recorded yet.")}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t("تاريخ الزيارة", "Visit Date")}</th>
                <th>{t("النوع والسبب", "Type / Reason")}</th>
                <th>{t("الطبيب / المنشأة", "Practitioner / Facility")}</th>
                <th style={{ textAlign: "end" }}>{t("تقرير الزيارة (PDF)", "Encounter Note (PDF)")}</th>
              </tr>
            </thead>
            <tbody>
              {encs.map((e) => (
                <tr key={e.id}>
                  <td><strong>{fmtDateTime(e.started_at, lang, tz)}</strong></td>
                  <td>
                    {lbl(ENCOUNTER_KIND, e.kind, lang)}
                    {e.reason ? ` — ${e.reason}` : ""}
                  </td>
                  <td className="small muted">
                    {[e.practitioner_name, e.facility_name].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <span className="row" style={{ justifyContent: "flex-end", gap: ".4rem" }}>
                      <a className="btn sm" href={`/api/patients/${p.id}/visits/${e.id}/pdf${langQuery ? `?lang=${reportLang}` : ""}`} target="_blank" rel="noopener">
                        <Stethoscope size={13} aria-hidden="true" />
                        {t("تقرير الزيارة", "Visit Note")}
                      </a>
                      <a className="btn sm ghost" href={`/api/patients/${p.id}/visits/${e.id}/pdf?dl=1${langQuery}`} download>
                        <Download size={13} aria-hidden="true" />
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
