import { notFound } from "next/navigation";
import { appliesToSex, forSex } from "@/lib/sex";
import Link from "next/link";
import { Printer } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { getPatient, getSpecialties, specialtyName, UUID_RE } from "@/lib/data";
import { getTz } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { ENCOUNTER_KIND, lbl, ANESTHESIA_KIND } from "@/lib/labels";
import { ENTITIES } from "@/lib/entities";
import { EntitySection } from "@/components/EntitySection";
import { EntityForm } from "@/components/EntityForm";
import { Card, KV, PageHead } from "@/components/ui";
import { ObservationTable } from "@/components/observations/ObservationTable";
import type { ObservationRow } from "@/lib/types";

export default async function VisitPage({ params }: { params: { pid: string; eid: string } }) {
  if (!UUID_RE.test(params.eid)) notFound();
  const { lang, t } = i18n();
  const p = await getPatient(params.pid);
  const supabase = createClient();
  const { data: e } = await supabase.from("encounters").select("*").eq("id", params.eid).eq("patient_id", p.id).maybeSingle();
  if (!e) notFound();
  const [specs, { data: obs }, { data: docs }] = await Promise.all([
    getSpecialties(),
    supabase.from("observations").select("*").eq("encounter_id", e.id).order("effective_at", { ascending: false }),
    supabase.from("medical_documents").select("id, title, doc_type").eq("encounter_id", e.id).eq("record_status", "active"),
  ]);
  const tz = getTz();
  const path = `/patients/${p.id}/visits/${e.id}`;
  const link = { encounter_id: e.id };
  // records created inside a visit inherit its specialty, so they travel with that specialty's file and shares
  const inherit: Record<string, string> = e.specialty_id ? { specialty_id: e.specialty_id } : {};
  const row = e as Record<string, unknown> & { id: string };
  return (
    <>
      <PageHead
        title={`${lbl(ENCOUNTER_KIND, e.kind, lang)}${e.reason ? ` — ${e.reason}` : ""}`}
        sub={`${fmtDateTime(e.started_at, lang, tz)}${e.practitioner_name ? ` · ${e.practitioner_name}` : ""}${e.facility_name ? ` · ${e.facility_name}` : ""}${e.specialty_id ? ` · ${specialtyName(specs, e.specialty_id, lang)}` : ""}`}
        actions={
          <span className="row" style={{ gap: ".5rem" }}>
            <a className="btn sm" href={`/api/patients/${p.id}/visits/${e.id}/pdf`} target="_blank" rel="noopener">
              <Printer size={14} aria-hidden="true" />
              {t("تقرير الزيارة (PDF)", "Visit note (PDF)")}
            </a>
            <Link className="btn sm" href={`/patients/${p.id}/visits`}>{t("كل الزيارات", "All visits")}</Link>
          </span>
        }
      />
      <Card title={t("تفاصيل الزيارة", "Visit details")}>
        <KV items={[
          [t("الأعراض", "Symptoms"), e.symptoms], [t("التاريخ المرضي", "History"), e.history_of_present_illness], [t("الفحص السريري", "Examination"), e.examination],
          [t("التقييم", "Assessment"), e.assessment], [t("الخطة", "Plan"), e.plan], [t("ملخص الزيارة", "Summary"), e.summary], [t("ملخص الخروج", "Discharge summary"), e.discharge_summary],
          [t("الأسنان", "Teeth"), Array.isArray(e.teeth) && e.teeth.length ? (e.teeth as number[]).join("، ") : null],
          [t("التخدير", "Anaesthesia"), e.anesthesia_kind ? lbl(ANESTHESIA_KIND, e.anesthesia_kind as string, lang) : null], [t("المادة المخدرة والكمية", "Anaesthetic"), e.anesthetic],
          [t("المواد المستخدمة", "Materials"), e.materials], [t("المضاعفات", "Complications"), e.complications], [t("التعليمات المعطاة", "Instructions given"), e.instructions],
          [t("موعد المتابعة", "Follow-up"), e.follow_up_date],
        ]} />
        <details className="fold" style={{ marginBlockStart: ".8rem" }}>
          <summary>{t("تعديل الزيارة", "Edit visit")}</summary>
          <div className="fold-body"><EntityForm entity={ENTITIES.visits} pid={p.id} row={row} specialties={forSex(specs, p.sex)} returnPath={path} context={{ dental: e.kind === "dental" }} /></div>
        </details>
      </Card>
      <EntitySection entity={ENTITIES.conditions} pid={p.id} returnPath={path} filter={link} links={link} defaults={inherit} title={t("التشخيصات في هذه الزيارة", "Diagnoses made at this visit")} compact
        context={{ dental: e.kind === "dental" }} addLabel={t("إضافة تشخيص", "Add a diagnosis")} />
      <EntitySection entity={ENTITIES.medications} pid={p.id} returnPath={path} filter={link} links={link} title={t("الأدوية الموصوفة", "Medications prescribed")} defaults={{ origin: "prescribed", ...inherit }} compact />
      <EntitySection entity={ENTITIES.procedures} pid={p.id} returnPath={path} filter={link} links={link} defaults={inherit} title={t("الإجراءات", "Procedures")} compact />
      <Card title={t("القياسات والنتائج المرتبطة", "Linked measurements & results")}>
        {(obs ?? []).length === 0
          ? <p className="muted">{t("لا توجد قياسات مرتبطة. أضف قياساً من صفحة القياسات واربطه بهذه الزيارة.", "None linked. Add a measurement from the Vitals page and link it to this visit.")}</p>
          : <ObservationTable rows={obs as ObservationRow[]} lang={lang} tz={tz} canWrite={false} pid={p.id} returnPath={path} />}
      </Card>
      <Card title={t("المستندات", "Documents")}>
        {(docs ?? []).length === 0 ? <p className="muted">{t("لا توجد مستندات مرتبطة.", "No linked documents.")}</p> :
          <ul>{(docs ?? []).map((d) => <li key={d.id}><a href={`/api/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{d.title}</a></li>)}</ul>}
      </Card>
    </>
  );
}
