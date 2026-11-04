import { TriangleAlert, ShieldCheck, CircleHelp, FileText, LogOut, Printer, Timer, Clock, Compass } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ExamExtras } from "@/components/dental/ExamExtras";
import { baselineExam, openSoftTissueAlert } from "@/lib/dental-exam";
import { i18n } from "@/lib/i18n";
import { getTz } from "@/lib/auth";
import { fmtDate, fmtDateTime, fmtPartialDate } from "@/lib/format";
import { ANESTHESIA_KIND, RECALL_KIND, ALLERGY_SEVERITY, CERTAINTY, CLINICAL_STATUS, CONDITION_CATEGORY, DOC_TYPE, ENCOUNTER_KIND, IMAGING_MODALITY, lbl, MED_ORIGIN, PROCEDURE_KIND, SEX, SHARE_MODULES, FAMILY_RELATION, CARE_PLAN_STATUS, LAB_GROUP, IMMUNIZATION_STATUS } from "@/lib/labels";
import { buildSeries, stats } from "@/lib/clinical/series";
import { REF_LINES } from "@/lib/clinical/refs";
import type { Bundle, ShareDental, ShareExtras, ShareMyNote, ShareRecall, SharePerio } from "@/lib/share-types";
import { SharePerioCard } from "@/components/share/SharePerio";
import { DentalSummary } from "@/components/dental/DentalSummary";
import { buildDentalSummary } from "@/lib/dental-summary";
import { DentalChart, type ToothAddForm } from "@/components/dental/DentalChart";
import { ClinicalContext } from "@/components/ClinicalContext";
import type { ClinicalContextData } from "@/lib/clinical-context";
import { chartDentition, DENTAL_DIAGNOSES, EXAM_KIND, deriveChart } from "@/lib/dental";
import { localDate } from "@/lib/format";
import type { ObservationRow, ObservationType } from "@/lib/types";
import { Banner, Card, Chip, Empty, InterpChip, KV } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui/client";
import { TrendChart } from "@/components/observations/TrendChart";
import { endShare, addShareNote, contributeTreatment, retractContribution, shareAddAnnotation, shareSetCost, shareTreatmentStatus } from "@/app/actions/share-viewer";
import { TreatmentItemForm, TreatmentPlans } from "@/components/dental/TreatmentPlans";
import { OPEN_ITEM, OPEN_PLAN, type CatalogItem } from "@/lib/treatment";
import type { ContribState } from "@/lib/share-contrib";
import { canAdd, ContribAdd, ContribForm, ContributorCard, ContribSummary, contribLabel } from "@/components/share/Contribute";
import { Prescriptions } from "@/components/rx/Prescriptions";
import { RxForm } from "@/components/rx/RxForm";
import { ConsentList } from "@/components/rx/Consents";
import { ConsentForm, type ConsentTarget } from "@/components/rx/ConsentForm";
import { SafetyAlerts } from "@/components/SafetyAlerts";
import { alertsByItem, type SafetyAlert } from "@/lib/safety-rules";
import type { Rx } from "@/lib/prescription";
import { consentTemplate, type ConsentRow } from "@/lib/consent";
import { contributePrescription, presentConsent, retractPrescription } from "@/app/actions/share-rx";

type R = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v));

export function ShareViewer({ b, token, contrib, dental, perio, ctx, uploaded, uploadError, catalog = [], extras, myNotes = [], recalls = [], templates = [], rx, safety = [] }: {
  b: Bundle; token: string; contrib?: ContribState | null; dental?: ShareDental | null; perio?: SharePerio | null; ctx?: (ClinicalContextData & { specialties: string[] | null }) | null; uploaded?: boolean; uploadError?: string;
  catalog?: CatalogItem[]; extras?: ShareExtras | null; myNotes?: ShareMyNote[]; recalls?: ShareRecall[]; templates?: { id: string; title: string; body: string }[];
  /** prescriptions and consents within the share's scope (public.share_rx_extras), when the patient allowed them */
  rx?: { prescriptions: Rx[]; consents: ConsentRow[] } | null;
  /** safety alerts the reviewable rules raise for this file and the plan shown here */
  safety?: SafetyAlert[];
}) {
  const { lang, t } = i18n();
  const tz = getTz();
  const inc = new Set(b.meta.include);
  const spec = (id: unknown) => { const x = b.specialties.find((y) => y.id === id); return x ? (lang === "ar" ? x.name_ar : x.name_en) : ""; };
  const d = (v: unknown, prec?: unknown) => (prec ? fmtPartialDate(s(v), prec, lang, tz) : fmtDate(s(v), lang, tz));
  const dt = (v: unknown) => fmtDateTime(s(v), lang, tz);
  const p = b.patient;
  const obs = (b.observations ?? []) as R[];

  // charts per observation type with 2+ numeric points
  const byType = new Map<string, R[]>();
  for (const o of obs) byType.set(s(o.type_code), [...(byType.get(s(o.type_code)) ?? []), o]);
  const types = Array.from(byType.entries()).map(([code, list]) => {
    const f = list[0];
    const ty = { code, value_kind: f.value_kind, name_ar: f.name_ar, name_en: f.name_en, default_unit: s(f.unit) || null, decimals: 1 } as unknown as ObservationType;
    const rows = list.map((o) => ({ ...o, id: o.id, status: o.status, interpretation: o.interpretation, unit: o.unit, type_id: code } as unknown as ObservationRow));
    return { code, ty, list, series: buildSeries(ty, rows), cat: s(f.category), group: s(f.lab_group) };
  });

  // the clinician adds where the information belongs: each "add" form sits in its section, the tooth forms in the panel of
  // the chosen tooth; what has no section on this page gathers in "other additions"
  const dentition = dental ? chartDentition(dental.profile as { dentition?: string } | null, dental.exams) : "permanent";
  const known = dental ? [...deriveChart(dental.exams, dental.findings).values()].filter((v) => v.status).map((v) => ({ tooth: v.tooth, status: v.status! })) : [];
  // the dental images the link shows: a finding read on one names it, and a file can be attached to one
  const studyOptions = (dental?.imaging ?? []).map((i) => ({ id: i.id, label: `${lbl(IMAGING_MODALITY, i.modality, lang)}${i.performed_on ? ` ${fmtPartialDate(i.performed_on, i.date_precision ?? "day", lang, tz)}` : ""}` }));
  const add = (table: string) => (contrib ? <ContribAdd token={token} st={contrib} table={table} dentition={dentition} uploadError={uploadError} templates={templates}
    knownStates={known} noBaseline={Boolean(dental) && !dental!.exams.some((e) => e.is_baseline)} images={studyOptions} /> : null);
  const placed = new Set<string>();
  const place = (table: string, shown: boolean) => { if (shown) placed.add(table); return shown; };
  const showEnc = place("encounters", inc.has("encounters"));
  const showCond = place("conditions", inc.has("other_conditions"));
  const showProc = place("procedures", inc.has("procedures"));
  const showImg = place("imaging_studies", inc.has("imaging") && ((b.imaging ?? []).length > 0 || canAdd(contrib, "imaging_studies")));
  const showNotes = place("clinical_notes", inc.has("notes") && ((b.notes ?? []).length > 0 || canAdd(contrib, "clinical_notes")));
  const showDocs = place("medical_documents", inc.has("documents"));
  if (dental) { placed.add("dental_exams"); placed.add("treatment_plans"); }
  if (perio) placed.add("perio_exams");
  placed.add("prescriptions"); placed.add("consents");          // their own cards below
  const safetyByItem = alertsByItem(safety);
  const consentTargets: ConsentTarget[] = dental ? (dental.plans ?? []).filter((pl) => OPEN_PLAN.has(pl.status)).flatMap((pl) => [
    { id: `plan:${pl.id}`, kind: "plan" as const, label: pl.title, plan_id: pl.id },
    ...pl.items.filter((i) => OPEN_ITEM.has(i.status)).map((i) => ({ id: `item:${i.id}`, kind: "item" as const, plan_id: pl.id, label: `${i.name}${i.teeth?.length ? ` (${i.teeth.join(", ")})` : ""}` })),
  ]) : [];
  const rxOn = Boolean(rx) && (contrib?.modules ?? []).includes("prescriptions");
  const consentsOn = Boolean(rx) && (contrib?.modules ?? []).includes("consents");
  const others = (contrib?.modules ?? []).filter((m) => !placed.has(m) && canAdd(contrib, m));
  // treatment plans in the dental workspace: the dentist proposes, moves treatments along and notes their own cost
  const plans = dental?.plans ?? [];
  const myId = contrib?.contributor?.id;
  const myProposals = plans.filter((p) => p.contributed_by && p.contributed_by === myId && (p.status === "draft" || p.status === "proposed"));
  const openProblems = (dental?.diagnoses ?? []).filter((x) => (x.clinical_status === "active" || x.clinical_status === "recurrence") && x.certainty !== "refuted")
    .map((x) => ({ id: x.id, name: x.name, teeth: x.teeth }));
  const planned = plans.filter((p) => OPEN_PLAN.has(p.status)).flatMap((p) => p.items.filter((i) => OPEN_ITEM.has(i.status) && i.teeth?.length)
    .map((i) => ({ id: i.id, name: i.name, status: i.status, plan: p.title, plan_id: p.id, teeth: i.teeth })));
  const txWrite = canAdd(contrib, "treatment_plans");
  const toothAdd: ToothAddForm[] = contrib && dental ? ([
    canAdd(contrib, "conditions") && { id: "ctooth-dx", label: t("تشخيص لهذا السن", "A diagnosis for this tooth"), node: (
      <ContribForm token={token} st={contrib} table="conditions" formId="ctooth-dx" fixed={{ category: "diagnosis" }} external={["teeth"]}
        pick={["name", "clinical_status", "certainty", "evidence", "onset_date", "notes"]} defaults={{ certainty: "confirmed" }}
        suggest={{ name: DENTAL_DIAGNOSES.map((x) => (lang === "ar" ? x.ar : x.en)) }} submitLabel={t("إضافة التشخيص", "Add the diagnosis")} />) },
    canAdd(contrib, "procedures") && { id: "ctooth-px", label: t("إجراء على هذا السن", "A procedure on this tooth"), node: (
      <ContribForm token={token} st={contrib} table="procedures" formId="ctooth-px" fixed={{ kind: "dental" }} external={["teeth"]}
        pick={["name", "performed_on", "outcome", "notes"]} submitLabel={t("إضافة الإجراء", "Add the procedure")} />) },
    canAdd(contrib, "imaging_studies") && { id: "ctooth-img", label: t("صورة أو أشعة لهذا السن", "An image or X-ray of this tooth"), node: (
      <ContribForm token={token} st={contrib} table="imaging_studies" formId="ctooth-img" external={["teeth"]} defaults={{ modality: "dental_xray" }}
        pick={["modality", "performed_on", "findings", "impression"]} submitLabel={t("إضافة الصورة", "Add the image")} />) },
    canAdd(contrib, "treatment_plans") && { id: "ctooth-tx", label: t("علاج مقترح لهذا السن", "A treatment for this tooth"), node: (
      <TreatmentItemForm action={contributeTreatment} hidden={{ _t: token }} catalog={catalog} problems={openProblems} lang={lang} idPrefix="ctooth-tx" formId="ctooth-tx"
        plans={myProposals.map((p) => ({ id: p.id, title: p.title }))} externalTeeth submitLabel={t("اقتراح العلاج", "Propose the treatment")} />) },
  ] as (ToothAddForm | false)[]).filter((x): x is ToothAddForm => Boolean(x)) : [];

  return (
    <div className="stack">
      {!b.meta.allow_print && <style>{`@media print { body * { display: none !important; } }`}</style>}
      <div className="card no-print" style={{ padding: ".75rem 1.15rem" }}>
        <div className="row between">
          <div className="row" style={{ gap: ".6rem" }}>
            <span className="chip info">
              <Timer size={14} aria-hidden="true" />
              {t("جلسة مصرحة ومؤقتة", "Authorized clinical session")}
            </span>
            <span className="muted small">
              {t("انتهاء المشاركة", "Share expires")}: <strong>{dt(b.meta.expires_at)}</strong>
            </span>
          </div>
          <div className="row" style={{ gap: ".5rem" }}>
            {b.meta.allow_print ? (
              <a className="btn sm" href={`/s/${token}/pdf`} target="_blank" rel="noopener noreferrer">
                <Printer size={14} aria-hidden="true" />
                {t("طباعة (PDF)", "Print (PDF)")}
              </a>
            ) : (
              <Chip tone="muted">{t("الطباعة غير مسموحة", "Printing disabled")}</Chip>
            )}
            <form action={endShare}>
              <input type="hidden" name="_t" value={token} />
              <button type="submit" className="btn sm danger">
                <LogOut size={14} aria-hidden="true" />
                {t("إنهاء الجلسة", "End session")}
              </button>
            </form>
          </div>
        </div>
      </div>

      <section className="card patient-head">
        <div className="row between">
          <div className="row" style={{ flexWrap: "nowrap", gap: ".9rem", alignItems: "center" }}>
            <Avatar name={lang === "en" && p.full_name_en ? p.full_name_en : p.full_name} size="md" />
            <div>
              <h1 style={{ margin: "0 0 .15rem 0", fontSize: "1.35rem" }}>
                {lang === "en" && p.full_name_en ? p.full_name_en : p.full_name}
              </h1>
              <p className="muted" style={{ margin: 0, fontSize: ".9rem" }}>
                <span className="ltr">{p.mrn}</span> · {p.age_years} {t("سنة", "y")} · {lbl(SEX, p.sex, lang)} · {t("الميلاد", "DOB")} {d(p.date_of_birth)}
                {p.nationality ? ` · ${p.nationality}` : ""}
              </p>
            </div>
          </div>
          <div className="row">
            {p.blood_group ? (
              <Chip tone="info">
                {t("الدم", "Blood")}: <span className="ltr">{p.blood_group}</span>
                {p.blood_group_verified ? "" : ` (${t("غير موثقة", "unverified")})`}
              </Chip>
            ) : (
              <Chip tone="muted">{t("فصيلة الدم غير مسجلة", "Blood group not recorded")}</Chip>
            )}
            {p.phone && <Chip tone="muted"><span className="ltr">{p.phone}</span></Chip>}
          </div>
        </div>

        <div className="card-foot" style={{ flexWrap: "wrap", justifyContent: "space-between", gap: ".6rem", marginBlockStart: ".75rem" }}>
          <div>
            <strong>{t("الغرض", "Purpose")}:</strong> {b.meta.title}
            {b.meta.recipient_label ? ` — ${b.meta.recipient_label}` : ""}
          </div>
          <div className="small muted">
            {t("النطاق", "Scope")}:{" "}
            <span className="chip muted" style={{ fontSize: ".78rem" }}>
              {b.meta.scope_kind === "specialty"
                ? b.meta.specialties.map((x) => (lang === "ar" ? x.name_ar : x.name_en)).join("، ")
                : b.meta.scope_kind === "full"
                ? t("الملف الكامل", "Whole file")
                : t("سجلات مختارة", "Selected records")}
            </span>
            {b.meta.date_from || b.meta.date_to ? ` · ${b.meta.date_from ?? "…"} → ${b.meta.date_to ?? "…"}` : ""}
            {" · "}
            {t("يتضمن", "includes")}: {b.meta.include.map((m) => SHARE_MODULES.find((x) => x.value === m)?.[lang]).filter(Boolean).join("، ") || t("الأساسيات فقط", "essentials only")}
          </div>
        </div>
      </section>

      <nav className="row no-print" aria-label={t("أقسام الملف", "Record sections")} style={{ gap: ".4rem", overflowX: "auto", paddingBottom: ".25rem" }}>
        <span className="small muted row" style={{ gap: ".3rem", marginInlineEnd: ".25rem" }}>
          <Compass size={14} aria-hidden="true" />
          {t("انتقال سريع:", "Quick jump:")}
        </span>
        <a href="#sec-safety" className="pill">{t("معلومات السلامة", "Safety info")}</a>
        {dental && <a href="#dental-summary" className="pill">{t("ملخص الأسنان", "Dental summary")}</a>}
        {dental && <a href="#dental" className="pill">{t("مخطط الأسنان", "Tooth chart")}</a>}
        {(plans.length > 0 || txWrite) && <a href="#treatment" className="pill">{t("خطط العلاج", "Treatment")}</a>}
        {perio && <a href="#perio" className="pill">{t("مخطط اللثة", "Periodontal")}</a>}
        {rxOn && rx && <a href="#sec-prescriptions" className="pill">{t("الوصفات", "Prescriptions")}</a>}
        {consentsOn && rx && <a href="#sec-consents" className="pill">{t("الموافقات", "Consents")}</a>}
        {inc.has("observations") && <a href="#sec-observations" className="pill">{t("القياسات والتحاليل", "Labs & vitals")}</a>}
        {showEnc && <a href="#sec-encounters" className="pill">{t("الزيارات", "Visits")}</a>}
        {showCond && <a href="#sec-conditions" className="pill">{t("التشخيصات", "Conditions")}</a>}
        {showProc && <a href="#sec-procedures" className="pill">{t("الإجراءات", "Procedures")}</a>}
        {showImg && <a href="#sec-imaging" className="pill">{t("التصوير", "Imaging")}</a>}
        {showNotes && <a href="#sec-notes" className="pill">{t("الملاحظات", "Notes")}</a>}
        {showDocs && <a href="#sec-documents" className="pill">{t("المستندات", "Documents")}</a>}
        {b.meta.allow_notes && <a href="#sec-note-patient" className="pill">{t("ملاحظة للمريض", "Note to patient")}</a>}
      </nav>

      {ctx ? <div id="sec-safety"><ClinicalContext ctx={ctx} lang={lang} tz={tz} codes={ctx.specialties ?? "all"} title={t("السياق الصحي ومعلومات السلامة", "Health context & safety information")} /></div> : (
        <section className="card" id="sec-safety" aria-label={t("معلومات السلامة", "Safety information")}>
        <h2>{t("معلومات السلامة", "Safety information")}</h2>
        {b.allergies.length > 0 ? (
          <div className="banner bad" role="alert"><TriangleAlert size={18} aria-hidden="true" style={{ flex: "none", marginBlockStart: 3 }} />
            <div><strong>{t("حساسية موثقة", "Documented allergies")}:</strong> {b.allergies.map((a, i) => <span key={i}>{i ? "، " : ""}{s(a.substance)} — {lbl(ALLERGY_SEVERITY, s(a.severity), lang)}{a.reaction ? ` (${s(a.reaction)})` : ""}</span>)}</div></div>
        ) : b.allergy_assertion === "none_known" ? <div className="banner ok"><ShieldCheck size={18} aria-hidden="true" /><div>{t("لا توجد حساسية معروفة (إقرار المريض).", "No known allergies (patient’s statement).")}</div></div>
          : <div className="banner warn"><CircleHelp size={18} aria-hidden="true" /><div><strong>{t("حالة الحساسية غير معروفة", "Allergy status unknown")}</strong> — {t("لم يُسجَّل شيء؛ لا يعني ذلك غياب الحساسية.", "nothing recorded; this does not mean none exist.")}</div></div>}
        <div className="grid cols-2" style={{ marginBlockStart: ".9rem" }}>
          <div><h3>{t("الأمراض المزمنة والعيوب الخلقية", "Chronic & congenital conditions")}</h3>
            {b.chronic_conditions.length === 0 ? <p className="muted small">{t("لا شيء مسجل (لا يعني عدم وجود).", "None recorded (not proof of none).")}</p> : b.chronic_conditions.map((c, i) => (
              <div key={i}><strong>{s(c.name)}</strong> <Chip tone={c.certainty === "confirmed" ? "ok" : "muted"}>{lbl(CERTAINTY, s(c.certainty), lang)}</Chip> <span className="muted small">{lbl(CONDITION_CATEGORY, s(c.category), lang)} · {lbl(CLINICAL_STATUS, s(c.clinical_status), lang)}{c.onset_date ? ` · ${d(c.onset_date, c.date_precision)}` : ""}</span></div>))}</div>
          <div><h3>{t("الأدوية الحالية", "Current medications")}</h3>
            {b.medications.length === 0 ? <p className="muted small">{t("لا شيء مسجل (لا يعني عدم تناول أدوية).", "None recorded (not proof none are taken).")}</p> : b.medications.map((m, i) => (
              <div key={i}><strong>{[s(m.name_generic), m.name_brand && `(${s(m.name_brand)})`, s(m.strength)].filter(Boolean).join(" ")}</strong> <span className="muted small">{[s(m.dose), s(m.frequency), s(m.route)].filter(Boolean).join(" · ")} · {lbl(MED_ORIGIN, s(m.origin), lang)}{m.indication ? ` · ${s(m.indication)}` : ""}</span></div>))}</div>
        </div>
      </section>
      )}

      <SafetyAlerts alerts={safety} lang={lang} />

      {inc.has("contact") && (b.emergency_contacts ?? []).length > 0 && (
        <Card title={t("جهات الطوارئ", "Emergency contacts")}>{(b.emergency_contacts ?? []).map((c, i) => <div key={i}>{s(c.full_name)} {c.relation ? `(${s(c.relation)})` : ""} <span className="ltr">{s(c.phone)}</span></div>)}</Card>
      )}

      {contrib && <ContributorCard token={token} st={contrib} uploaded={uploaded} uploadError={uploadError} />}

      {dental && (
        <DentalSummary lang={lang} tz={tz} idPrefix="ssum" s={buildDentalSummary({
          today: localDate(new Date(), tz), exams: dental.exams, findings: dental.findings, pulp: dental.pulp, images: dental.imaging, perio: perio?.exams ?? [],
          plans: dental.plans, recalls, safety })}
          links={{ chart: "#dental", perio: perio ? "#perio" : undefined, treatment: plans.length > 0 ? "#treatment" : undefined, imaging: "#dental",
            pdf: b.meta.allow_print ? `/s/${token}/dental/pdf` : undefined }} />
      )}

      {dental && (
        <Card title={t("مخطط الأسنان", "Tooth chart")} id="dental">
          <p className="small muted" style={{ marginBlockStart: 0 }}>{canAdd(contrib, "conditions") || canAdd(contrib, "procedures") ? t("اختر سناً لعرض تاريخه وصوره، وللإضافة إليه مباشرة.", "Choose a tooth to see its history and images, and to add to it directly.") : t("اختر سناً لعرض تاريخه وصوره.", "Choose a tooth to see its history and images.")}</p>
          {(() => {
            const soft = openSoftTissueAlert(dental.exams);
            const base = baselineExam(dental.exams);
            return (<>
              {soft?.sections?.soft_tissue && (
                <Banner tone="bad" title={t("آفة مشتبهة في الأنسجة الرخوة", "Suspicious soft-tissue lesion")}>
                  {t(`سُجّلت في فحص ${d(soft.exam_date)}${soft.examiner_name ? ` (${soft.examiner_name})` : ""}.`, `Recorded at the exam of ${d(soft.exam_date)}${soft.examiner_name ? ` (${soft.examiner_name})` : ""}.`)}
                  {soft.sections.soft_tissue.note ? ` ${s(soft.sections.soft_tissue.note)}` : ""}
                </Banner>
              )}
              {base && <p className="small baseline-line">{t("الحالة الابتدائية: الفحص الأساسي الشامل في", "Baseline: the comprehensive exam of")} {d(base.exam_date)}{base.examiner_name ? ` — ${base.examiner_name}` : ""}</p>}
            </>);
          })()}
          <DentalChart dentition={chartDentition(dental.profile as { dentition?: string } | null, dental.exams)} exams={dental.exams} findings={dental.findings}
            diagnoses={dental.diagnoses} contributors={{}} lang={lang} canWrite={false} today={localDate(new Date(), tz)}
            procedures={dental.procedures ?? []} images={dental.imaging ?? []} toothAdd={toothAdd} planned={planned}
            viewer={{ docBase: `/s/${token}/doc/`, annotations: {
              rows: dental.annotations ?? [],
              ...(canAdd(contrib, "imaging_studies") && contrib?.covers_dentistry
                ? { add: shareAddAnnotation, addHidden: { _t: token }, remove: retractContribution, removeHidden: { _t: token, _table: "imaging_annotations" }, removeMineOnly: true }
                : {}),
            } }} />
          {canAdd(contrib, "dental_exams") && <div style={{ marginBlockStart: ".75rem" }}>{add("dental_exams")}</div>}
          {(plans.length > 0 || txWrite) && (<>
            <h3 id="treatment">{t("خطط العلاج", "Treatment plans")}</h3>
            <p className="small muted" style={{ marginBlockStart: 0 }}>{txWrite
              ? t("اقترح العلاج من لوحة السن أو من النموذج أدناه؛ يعتمده المريض، ثم تسجّل أنت إنجازه فيُضاف الإجراء ويُحدَّث المخطط. تكاليف المريض لا تظهر لك.",
                  "Propose treatment from a tooth's panel or the form below; the patient accepts it, then you record it done and the procedure and chart are updated. The patient's costs are not shown to you.")
              : t("خطط العلاج الحالية (بلا تكاليف).", "Current treatment plans (without costs).")}</p>
            <TreatmentPlans plans={plans} costs={dental.my_costs ?? []} catalog={catalog} problems={openProblems} lang={lang} today={localDate(new Date(), tz)} safety={safetyByItem}
              actions={txWrite ? { hidden: { _t: token }, status: shareTreatmentStatus, clinician: true, addCost: shareSetCost, addItem: contributeTreatment,
                canAddTo: (p) => myProposals.some((m) => m.id === p.id) } : { hidden: {} }} />
            {txWrite && (
              <details className="fold" id="contrib-treatment">
                <summary>{t("إضافة: اقتراح علاج", "Add: Propose treatment")}</summary>
                <div className="fold-body">
                  <TreatmentItemForm action={contributeTreatment} hidden={{ _t: token }} catalog={catalog} problems={openProblems} lang={lang} idPrefix="cx-tx"
                    plans={myProposals.map((p) => ({ id: p.id, title: p.title }))} submitLabel={t("اقتراح العلاج", "Propose the treatment")} />
                </div>
              </details>
            )}
          </>)}
          {dental.diagnoses.some((x) => !(x.teeth?.length) && (x.clinical_status === "active" || x.clinical_status === "recurrence")) && (<>
            <h3>{t("مشكلات سنية بلا سن محدد", "Dental problems without a tooth")}</h3>
            <ul>{dental.diagnoses.filter((x) => !(x.teeth?.length) && (x.clinical_status === "active" || x.clinical_status === "recurrence"))
              .map((x) => <li key={x.id}>{x.name} <Chip tone="muted">{lbl(CLINICAL_STATUS, x.clinical_status, lang)}</Chip></li>)}</ul>
          </>)}
          {recalls.length > 0 && (<>
            <h3>{t("الفحص الدوري", "Recalls")}</h3>
            <ul>{recalls.map((r, i) => <li key={i}>{r.kind === "other" ? s(r.label) : lbl(RECALL_KIND, r.kind, lang)} — {t(`كل ${r.interval_months} أشهر`, `every ${r.interval_months} months`)} · {t("الموعد", "due")} {d(r.due_on)}{r.last_done_on ? ` · ${t("آخر مرة", "last")} ${d(r.last_done_on)}` : ""}{r.status === "paused" ? ` (${t("موقوف مؤقتاً", "paused")})` : ""}</li>)}</ul>
          </>)}
          {dental.exams.length > 0 && (<>
            <h3>{t("الفحوص", "Exams")}</h3>
            {dental.exams.map((e) => (
              <article className="rec share-exam" key={e.id}>
                <div className="row between"><span>{lbl(EXAM_KIND, e.kind, lang)}{e.examiner_name ? ` · ${e.examiner_name}` : ""}{e.facility_name ? ` · ${e.facility_name}` : ""}
                  {e.is_baseline && <Chip tone="ok">{t("فحص أساسي", "Baseline")}</Chip>}
                  {e.contributed_by ? <Chip tone="info">{t("سجّله طبيب عبر رابط", "Recorded by a doctor via a link")}</Chip> : e.verification === "reported" ? <Chip tone="muted">{t("إفادة المريض", "Patient-reported")}</Chip> : null}</span>
                  <span className="muted small">{d(e.exam_date)}</span></div>
                {e.chief_complaint && <p className="small" style={{ margin: ".2rem 0" }}>{t("الشكوى", "Complaint")}: {s(e.chief_complaint)}</p>}
                <ExamExtras sections={e.sections} pulp={dental.pulp?.[e.id]} lang={lang} />
                {e.notes && <p className="small" style={{ margin: ".2rem 0" }}>{s(e.notes)}</p>}
              </article>
            ))}
          </>)}
        </Card>
      )}


      {perio && <SharePerioCard token={token} perio={perio} contrib={contrib ?? null} />}
      {rxOn && rx && (
        <Card title={t("الوصفات الطبية", "Prescriptions")} id="sec-prescriptions">
          <p className="small muted" style={{ marginBlockStart: 0 }}>{t("الوصفات ضمن نطاق المشاركة. وصفتك تُحفظ باسمك كما حدّده المريض في الرابط، وتُضاف أدويتها إلى ملفه.",
            "Prescriptions within the share's scope. Yours is saved under your name as the patient gave it on the link, and its medicines are added to their file.")}</p>
          <Prescriptions rxs={rx.prescriptions} lang={lang} tz={tz} idPrefix="srx"
            actions={{ hidden: { _t: token }, retract: retractPrescription, pdfHref: b.meta.allow_print ? (r) => `/s/${token}/rx/${r.id}/pdf` : undefined }}
            alerts={safety} empty={t("لا وصفات ضمن النطاق بعد.", "No prescriptions in scope yet.")} />
          {canAdd(contrib, "prescriptions") && contrib?.contributor && (
            <details className="fold" id="contrib-prescription">
              <summary>{t("إضافة: وصفة طبية مفصلة", "Add: a detailed prescription")}</summary>
              <div className="fold-body">
                <RxForm action={contributePrescription} hidden={{ _t: token }} lang={lang} today={localDate(new Date(), tz)} idPrefix="cx-rx"
                  prescriber={contrib.contributor.full_name} submitLabel={t("حفظ الوصفة", "Save the prescription")} />
              </div>
            </details>
          )}
        </Card>
      )}

      {consentsOn && rx && (
        <Card title={t("الموافقات الموقّعة", "Signed consents")} id="sec-consents">
          <p className="small muted" style={{ marginBlockStart: 0 }}>{t("قدّم الموافقة للمريض ليقرأها ويوقّع بنفسه على شاشتك؛ يُحفظ التوقيع في ملفه. لا يمكنك تعديل موافقة موقّعة، والمريض هو من يسحبها.",
            "Present the consent to the patient to read and sign on your screen; the signature is stored in their file. You cannot edit a signed consent; the patient is the one who withdraws it.")}</p>
          <ConsentList consents={rx.consents} lang={lang} tz={tz} idPrefix="scn" actions={{
            hidden: { _t: token },
            newVersion: (c) => canAdd(contrib, "consents") && c.mine && contrib?.contributor ? (
              <ConsentForm action={presentConsent} hidden={{ _t: token }} lang={lang} idPrefix={`scv-${c.id.slice(0, 8)}`} targets={consentTargets} presenter={contrib.contributor.full_name}
                signerName={c.signer_name} submitLabel={t("توقيع النسخة الجديدة", "Sign the new version")}
                supersede={{ id: c.id, kind: c.kind, title: `${c.title} (v${c.version + 1})`, body: consentTemplate(c.kind, lang).body, target: c.treatment_item_id ? `item:${c.treatment_item_id}` : c.treatment_plan_id ? `plan:${c.treatment_plan_id}` : null }} />
            ) : null,
          }} empty={t("لا موافقات ضمن النطاق بعد.", "No consents in scope yet.")} />
          {canAdd(contrib, "consents") && contrib?.contributor && (
            <details className="fold" id="contrib-consent">
              <summary>{t("إضافة: موافقة يوقّعها المريض على شاشتك", "Add: a consent the patient signs on your screen")}</summary>
              <div className="fold-body">
                <ConsentForm action={presentConsent} hidden={{ _t: token }} lang={lang} idPrefix="cx-cn" targets={consentTargets} presenter={contrib.contributor.full_name}
                  signerName={p.full_name} submitLabel={t("توقيع وحفظ الموافقة", "Sign and save the consent")} />
              </div>
            </details>
          )}
        </Card>
      )}

      {inc.has("observations") && (
        <Card title={t("القياسات والتحاليل عبر الزمن", "Measurements & lab results over time")} id="sec-observations">
          {obs.length === 0 ? <Empty>{t("لا توجد قياسات ضمن النطاق.", "No measurements in scope.")}</Empty> : (
            <>
              <Banner tone="info">{t("التصنيفات مؤشرات فحص عامة أو من المختبر وليست تشخيصاً. الوحدات والمجالات المرجعية كما سُجّلت.", "Flags are general screening prompts or lab flags, not a diagnosis. Units and reference ranges are as recorded.")}</Banner>
              <div className="table-wrap" style={{ marginBlockStart: ".6rem" }}><table className="t">
                <thead><tr><th>{t("القياس", "Measure")}</th><th>{t("آخر قيمة", "Latest")}</th><th>{t("التاريخ", "Date")}</th><th>{t("المرجع", "Ref.")}</th><th>{t("التصنيف", "Flag")}</th><th>{t("العدد", "n")}</th></tr></thead>
                <tbody>{types.sort((a, b2) => a.cat.localeCompare(b2.cat) || a.group.localeCompare(b2.group)).map(({ code, list }) => {
                  const l = list[0];
                  const ref = l.ref_low != null || l.ref_high != null ? `${s(l.ref_low)} – ${s(l.ref_high)}` : s(l.ref_text);
                  return (<tr key={code}><td>{l.custom_name ? s(l.custom_name) : s(lang === "ar" ? l.name_ar : l.name_en)}{l.lab_group ? <div className="muted small">{LAB_GROUP[s(l.lab_group)]?.[lang]}</div> : null}</td>
                    <td className="nowrap"><strong className="ltr">{l.value_kind === "bp" ? `${s(l.value_num)}/${s(l.value_num2)}` : s(l.value_num ?? l.value_text)}</strong> <span className="muted small ltr">{s(l.unit)}</span></td>
                    <td className="nowrap">{dt(l.effective_at)}</td><td className="muted small nowrap"><span className="ltr">{ref}</span></td><td><InterpChip value={s(l.interpretation)} lang={lang} />{l.is_correction ? <div className="muted small">{t("نتيجة مصحَّحة", "corrected result")}</div> : null}</td><td>{list.length}</td></tr>);
                })}</tbody></table></div>
              {types.filter((x) => x.series.some((sr) => sr.pts.length >= 2)).map(({ code, ty, series }) => {
                const units = new Set(series.map((x) => x.unit));
                return (
                  <details className="fold" key={code} style={{ marginBlockStart: ".6rem" }}>
                    <summary>{lang === "ar" ? s(ty.name_ar) : s(ty.name_en)} — {t("الرسم الزمني", "trend")}</summary>
                    <div className="fold-body">
                      {units.size > 1 && <Banner tone="warn">{t("وحدات مختلفة: تُعرض منفصلة ولا تُقارن.", "Different units: drawn separately, not compared.")}</Banner>}
                      <TrendChart series={series} lang={lang} tz={tz} refLines={units.size === 1 ? REF_LINES[code] : undefined} name={lang === "ar" ? s(ty.name_ar) : s(ty.name_en)} tableLabel={t("عرض القيم كجدول", "Show values as a table")} />
                      {series.filter((x) => x.pts.length).slice(0, 1).map((x) => { const st = stats(x.pts)!; return <p key={x.key} className="small muted">{t("المتوسط", "mean")} {Number(st.mean.toFixed(1))} · {t("أدنى", "min")} {st.min} · {t("أعلى", "max")} {st.max} · {st.count} {t("قراءة", "readings")}</p>; })}
                    </div>
                  </details>);
              })}
              <details className="fold" style={{ marginBlockStart: ".6rem" }}><summary>{t("كل النتائج (السجل الكامل ضمن النطاق)", "All results (full history in scope)")}</summary>
                <div className="fold-body table-wrap"><table className="t"><tbody>{obs.map((o, i) => (
                  <tr key={i}><td className="nowrap">{dt(o.effective_at)}</td><td>{o.custom_name ? s(o.custom_name) : s(lang === "ar" ? o.name_ar : o.name_en)}</td>
                    <td className="nowrap"><span className="ltr">{o.value_kind === "bp" ? `${s(o.value_num)}/${s(o.value_num2)}` : s(o.value_num ?? o.value_text)} {s(o.unit)}</span></td>
                    <td className="muted small"><span className="ltr">{o.ref_low != null || o.ref_high != null ? `${s(o.ref_low)} – ${s(o.ref_high)}` : s(o.ref_text)}</span></td><td><InterpChip value={s(o.interpretation)} lang={lang} /></td>
                    <td className="small muted">{s(o.context)}</td></tr>))}</tbody></table></div></details>
            </>)}
        </Card>
      )}

      {showEnc && (
        <Card title={t("الزيارات", "Visits")} id="sec-encounters">
          {add("encounters")}
          {(b.encounters ?? []).length === 0 ? <Empty>{t("لا زيارات ضمن النطاق.", "No visits in scope.")}</Empty> : (b.encounters ?? []).map((e, i) => (
            <article className="rec" key={i}><div className="row between"><span className="row"><span className="rec-title">{lbl(ENCOUNTER_KIND, s(e.kind), lang)}{e.reason ? ` — ${s(e.reason)}` : ""}</span>{spec(e.specialty_id) && <Chip tone="info">{spec(e.specialty_id)}</Chip>}</span><span className="muted small">{dt(e.started_at)}</span></div>
              <KV items={[[t("الطبيب", "Practitioner"), s(e.practitioner_name)], [t("المنشأة", "Facility"), s(e.facility_name)], [t("الأعراض", "Symptoms"), s(e.symptoms)], [t("الفحص", "Examination"), s(e.examination)], [t("التقييم", "Assessment"), s(e.assessment)], [t("الخطة", "Plan"), s(e.plan)], [t("الملخص", "Summary"), s(e.summary)], [t("ملخص الخروج", "Discharge"), s(e.discharge_summary)],
                ...((): [string, string][] => { const x = extras?.encounters[s(e.id)]; if (!x) return [];
                  return [[t("الأسنان", "Teeth"), x.teeth?.length ? x.teeth.join("، ") : ""], [t("التخدير", "Anaesthesia"), x.anesthesia_kind ? lbl(ANESTHESIA_KIND, x.anesthesia_kind, lang) : ""],
                    [t("المادة المخدرة والكمية", "Anaesthetic"), s(x.anesthetic)], [t("المواد", "Materials"), s(x.materials)], [t("المضاعفات", "Complications"), s(x.complications)],
                    [t("التعليمات المعطاة", "Instructions given"), s(x.instructions)], [t("موعد المتابعة", "Follow-up"), x.follow_up_date ? d(x.follow_up_date) : ""]]; })()]} /></article>))}
        </Card>
      )}

      {showCond && (
        <Card title={t("التشخيصات والحالات الأخرى", "Other diagnoses & conditions")} id="sec-conditions">
          {add("conditions")}
          {(b.other_conditions ?? []).length === 0 ? <Empty>{t("لا شيء ضمن النطاق.", "Nothing in scope.")}</Empty> : (b.other_conditions ?? []).map((c, i) => (
            <div key={i} className="rec row between"><span><strong>{s(c.name)}</strong> <Chip tone={c.certainty === "confirmed" ? "ok" : "muted"}>{lbl(CERTAINTY, s(c.certainty), lang)}</Chip> <span className="muted small">{lbl(CLINICAL_STATUS, s(c.clinical_status), lang)}{spec(c.specialty_id) ? ` · ${spec(c.specialty_id)}` : ""}</span></span><span className="muted small">{d(c.onset_date, c.date_precision)}</span></div>))}
        </Card>
      )}

      {showProc && (
        <Card title={t("العمليات والإجراءات", "Procedures & surgeries")} id="sec-procedures">
          {add("procedures")}
          {(b.procedures ?? []).length === 0 ? <Empty>{t("لا شيء ضمن النطاق.", "Nothing in scope.")}</Empty> : (b.procedures ?? []).map((x, i) => (
            <article className="rec" key={i}><div className="row between"><span className="rec-title">{s(x.name)} <Chip tone="muted">{lbl(PROCEDURE_KIND, s(x.kind), lang)}</Chip>{x.body_site ? <Chip tone="muted">{s(x.body_site)}</Chip> : null}</span><span className="muted small">{d(x.performed_on, x.date_precision)}</span></div>
              <KV items={[[t("المنفّذ", "Operator"), s(x.operator_name)], [t("الدافع", "Indication"), s(x.indication)], [t("النتيجة", "Outcome"), s(x.outcome)], [t("المضاعفات", "Complications"), s(x.complications)], [t("ملاحظات", "Notes"), s(x.notes)]]} /></article>))}
        </Card>
      )}

      {showImg && (
        <Card title={t("الأشعة والتصوير", "Imaging")} id="sec-imaging">{add("imaging_studies")}{(b.imaging ?? []).map((x, i) => (
          <article className="rec" key={i}><div className="row between"><span className="rec-title">{lbl(IMAGING_MODALITY, s(x.modality), lang)} {s(x.body_site)}</span><span className="muted small">{d(x.performed_on, x.date_precision)}</span></div>
            <KV items={[[t("الموجودات", "Findings"), s(x.findings)], [t("الخلاصة", "Impression"), s(x.impression)]]} /></article>))}</Card>
      )}

      {inc.has("specialty_records") && (b.specialty_records ?? []).length > 0 && (
        <Card title={t("سجلات التخصص", "Specialty records")}>{(b.specialty_records ?? []).map((x, i) => {
          const fields = (x.fields ?? []) as { key: string; label_ar: string; label_en: string; unit?: string; options?: { value: string; label_ar: string; label_en: string }[] }[];
          const data = (x.data ?? {}) as R;
          return (<article className="rec" key={i}><div className="row between"><span className="rec-title">{s(lang === "ar" ? x.record_type_name_ar : x.record_type_name_en)} <Chip tone="info">{spec(x.specialty_id)}</Chip></span><span className="muted small">{d(x.occurred_on)}</span></div>
            <KV items={fields.map((f): [string, string] => { const v = data[f.key]; const opt = f.options?.find((o) => o.value === v); return [lang === "ar" ? f.label_ar : f.label_en, v == null ? "" : `${opt ? (lang === "ar" ? opt.label_ar : opt.label_en) : s(v)}${f.unit ? " " + f.unit : ""}`]; })} />
            {x.notes ? <p className="rec-body">{s(x.notes)}</p> : null}</article>);
        })}</Card>
      )}

      {inc.has("care_plans") && (b.care_plans ?? []).length > 0 && (
        <Card title={t("خطط العلاج والمتابعة", "Care plans")}>{(b.care_plans ?? []).map((x, i) => (
          <article className="rec" key={i}><span className="rec-title">{s(x.title)}</span> <Chip tone="muted">{lbl(CARE_PLAN_STATUS, s(x.status), lang)}</Chip><KV items={[[t("الأهداف", "Goals"), s(x.goals)], [t("التعليمات", "Instructions"), s(x.instructions)]]} /></article>))}</Card>
      )}

      {showNotes && (
        <Card title={t("الملاحظات السريرية", "Clinical notes")} id="sec-notes">{add("clinical_notes")}{(b.notes ?? []).map((x, i) => (
          <article className="rec" key={i}><div className="row between"><strong>{s(x.title)}</strong><span className="muted small">{dt(x.noted_at)}{x.author_name ? ` · ${s(x.author_name)}` : ""}</span></div><p className="rec-body">{s(x.body)}</p>
            {(() => { const n = extras?.notes[s(x.id)]; if (!n) return null; return (<>
              {n.status === "signed" ? <p className="small note-sign">{t("موقّعة", "Signed")}{n.signed_name ? ` — ${n.signed_name}` : ""}{n.signed_at ? ` · ${dt(n.signed_at)}` : ""}</p> : <Chip tone="warn">{t("مسودة", "Draft")}</Chip>}
              {n.amendments.map((a, j) => <div className="amendment" key={j}><div className="small"><strong>{t(`تعديل موثّق ${j + 1}`, `Amendment ${j + 1}`)}</strong> · {dt(a.amended_at)}{a.amended_name ? ` · ${a.amended_name}` : ""} — {t("السبب", "Reason")}: {a.reason}</div><p className="rec-body">{a.body}</p></div>)}
            </>); })()}</article>))}</Card>
      )}

      {inc.has("immunizations") && (b.immunizations ?? []).length > 0 && (
        <Card title={t("التطعيمات", "Immunizations")}>{(b.immunizations ?? []).map((x, i) => (
          <div className="row between" key={i}><span>{s(x.vaccine_name)}{x.dose_number ? ` #${s(x.dose_number)}` : ""} <Chip tone="muted">{lbl(IMMUNIZATION_STATUS, s(x.status), lang)}</Chip></span><span className="muted small">{d(x.administered_on, x.date_precision)}</span></div>))}</Card>
      )}

      {inc.has("family_history") && (b.family_history ?? []).length > 0 && (
        <Card title={t("التاريخ العائلي", "Family history")}>{(b.family_history ?? []).map((x, i) => (
          <div key={i}>{lbl(FAMILY_RELATION, s(x.relation), lang)}: <strong>{s(x.condition_name)}</strong>{x.age_at_onset != null ? <span className="muted small"> · {t("بدأ بعمر", "onset at")} {s(x.age_at_onset)}</span> : null}</div>))}</Card>
      )}

      {showDocs && (
        <Card title={t("المستندات والتقارير", "Documents & reports")} id="sec-documents">
          {add("medical_documents")}
          {(b.documents ?? []).length === 0 ? <Empty>{t("لا مستندات ضمن النطاق.", "No documents in scope.")}</Empty> : (b.documents ?? []).map((x, i) => (
            <div className="rec row between" key={i}>
              <span className="row"><FileText size={16} aria-hidden="true" /><a href={`/s/${token}/doc/${s(x.id)}`} target="_blank" rel="noopener noreferrer"><strong>{s(x.title)}</strong></a><Chip tone="info">{lbl(DOC_TYPE, s(x.doc_type), lang)}</Chip>{spec(x.specialty_id) && <Chip tone="muted">{spec(x.specialty_id)}</Chip>}</span>
              <span className="row"><span className="muted small">{d(x.document_date)}</span>{b.meta.allow_download && <a className="small" href={`/s/${token}/doc/${s(x.id)}?dl=1`}>{t("تنزيل", "Download")}</a>}</span></div>))}
        </Card>
      )}

      {others.length > 0 && contrib && (
        <Card title={t("إضافات أخرى", "Other additions")} id="contrib-others">
          <p className="small muted">{t("ما سمح لك المريض بإضافته وليس له قسم في هذه الصفحة.", "What the patient allowed you to add that has no section on this page.")} {others.map((m) => <Chip key={m} tone="muted">{contribLabel(m, lang)}</Chip>)}</p>
          {others.map((m) => <div key={m}>{add(m)}</div>)}
        </Card>
      )}

      {contrib && <ContribSummary token={token} st={contrib} myNotes={myNotes} />}

      {b.meta.allow_notes && (
        <Card title={t("ملاحظة للمريض", "Leave a note for the patient")} id="sec-note-patient">
          <p className="small muted">{t("لا تُضاف ملاحظتك إلى السجل الطبي تلقائياً؛ يراجعها المريض أولاً.", "Your note is not added to the medical record automatically; the patient reviews it first.")}</p>
          <ActionForm action={addShareNote} className="stack">
            <input type="hidden" name="_t" value={token} />
            <div className="field"><label htmlFor="author_name">{t("اسمك", "Your name")}</label><input id="author_name" name="author_name" required minLength={2} maxLength={120} defaultValue={contrib?.clinician?.name ?? contrib?.contributor?.full_name ?? ""} /></div>
            <div className="field"><label htmlFor="body">{t("الملاحظة", "Note")}</label><textarea id="body" name="body" required maxLength={4000} rows={4} /></div>
            <div><SubmitButton>{t("إرسال", "Send")}</SubmitButton></div>
          </ActionForm>
        </Card>
      )}

      <div className="card-foot" style={{ margin: 0, justifyContent: "space-between", flexWrap: "wrap", gap: ".5rem" }}>
        <p className="small muted row" style={{ gap: ".4rem", margin: 0, alignItems: "center" }}>
          <ShieldCheck size={15} aria-hidden="true" />
          <span>{t("هذا عرض لمعلومات سجّلها المريض أو مقدمو الرعاية؛ قد لا يكون كاملاً. القرار السريري لك.", "This is a view of information recorded by the patient or care providers; it may be incomplete. Clinical judgement is yours.")}</span>
        </p>
        <span className="small muted">{t("أُنشئ في", "Generated at")} {dt(b.meta.generated_at)}</span>
      </div>
    </div>
  );
}
