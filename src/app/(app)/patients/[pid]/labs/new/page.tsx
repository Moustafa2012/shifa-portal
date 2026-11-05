import { redirect } from "next/navigation";
import { appliesToSex, forSex } from "@/lib/sex";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { getAccess, getObsTypes, getPatient, getSpecialties } from "@/lib/data";
import { LAB_FLAG, LAB_GROUP, LAB_STATUS, lbl, ORDER_STATUS } from "@/lib/labels";
import { fmtDate } from "@/lib/format";
import { getTz } from "@/lib/auth";
import { ActionForm, DateTimeField, SubmitButton } from "@/components/ui/client";
import { LabRows } from "@/components/observations/LabRows";
import { PageHead } from "@/components/ui";
import { addLabReport } from "@/app/actions/observations";

export default async function NewLabReport({ params }: { params: { pid: string } }) {
  const { lang, t } = i18n();
  const tz = getTz();
  const p = await getPatient(params.pid);
  const access = await getAccess(p.id);
  if (!access.canWrite) redirect(`/patients/${p.id}/labs`);
  const [types, specs, { data: encs }, { data: openOrders }] = await Promise.all([
    getObsTypes(), getSpecialties(),
    createClient().from("encounters").select("id, kind, reason, started_at").eq("patient_id", p.id).eq("record_status", "active").order("started_at", { ascending: false }).limit(20),
    createClient().from("test_orders").select("id, name, status, requested_on").eq("patient_id", p.id).eq("record_status", "active").eq("kind", "lab")
      .in("status", ["suggested", "requested"]).order("requested_on", { ascending: false }).limit(100),
  ]);
  const labTypes = forSex(types, p.sex).filter((x) => x.category === "lab").map((x) => ({
    id: x.id, name: lang === "ar" ? x.name_ar : x.name_en, unit: x.default_unit, kind: x.value_kind, group: LAB_GROUP[x.lab_group ?? "other"]?.[lang] ?? "—",
    units: x.default_unit ? [x.default_unit, ...Object.keys(x.unit_conversions ?? {})] : [], other: x.code.startsWith("other_"),
  }));
  return (
    <>
      <PageHead title={t("تقرير تحاليل جديد", "New lab report")} sub={t("انقل النتائج كما وردت في تقرير المختبر مع مجاله المرجعي. ارفع نسخة التقرير من صفحة المستندات لتبقى مرجعاً.", "Copy results as printed on the lab report, with its reference range. Upload the report itself from Documents to keep the original.")} />
      <div className="card">
        <ActionForm action={addLabReport} className="stack" resetOnSuccess>
          <input type="hidden" name="_pid" value={p.id} />
          <div className="form-grid">
            <div className="field wide"><label htmlFor="title">{t("عنوان التقرير", "Report title")} <span className="req">*</span></label><input id="title" name="title" type="text" required maxLength={200} placeholder={t("مثال: صورة دم كاملة", "e.g. Complete blood count")} /></div>
            <div className="field"><label htmlFor="lab_name">{t("المختبر", "Laboratory")}</label><input id="lab_name" name="lab_name" type="text" maxLength={200} /></div>
            <div className="field"><label htmlFor="specimen_type">{t("نوع العينة", "Specimen")}</label><input id="specimen_type" name="specimen_type" type="text" maxLength={100} placeholder={t("دم، بول…", "blood, urine…")} /></div>
            <div className="field"><label>{t("وقت أخذ العينة", "Sample collected")} <span className="req">*</span></label><DateTimeField name="collected_at" required /></div>
            <div className="field"><label>{t("وقت إجراء التحليل", "Performed")}</label><DateTimeField name="performed_at" blank /></div>
            <div className="field"><label>{t("وقت اعتماد النتيجة", "Approved")}</label><DateTimeField name="approved_at" blank /></div>
            <div className="field"><label htmlFor="approved_by_name">{t("اعتمدها", "Approved by")}</label><input id="approved_by_name" name="approved_by_name" type="text" maxLength={200} /></div>
            <div className="field"><label htmlFor="status">{t("حالة التقرير", "Report status")}</label><select id="status" name="status" defaultValue="final">{LAB_STATUS.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
            <div className="field"><label htmlFor="specialty_id">{t("التخصص", "Specialty")}</label><select id="specialty_id" name="specialty_id" defaultValue=""><option value="">—</option>{forSex(specs, p.sex).map((s) => <option key={s.id} value={s.id}>{lang === "ar" ? s.name_ar : s.name_en}</option>)}</select></div>
            {(encs ?? []).length > 0 && <div className="field"><label htmlFor="encounter_id">{t("ربط بزيارة", "Link to a visit")}</label><select id="encounter_id" name="encounter_id" defaultValue=""><option value="">—</option>{(encs ?? []).map((e) => <option key={e.id as string} value={e.id as string}>{fmtDate(e.started_at as string, lang, tz)} — {(e.reason as string) ?? (e.kind as string)}</option>)}</select></div>}
            <div className="field wide"><label htmlFor="lab_notes">{t("ملاحظات المختبر", "Lab notes")}</label><textarea id="lab_notes" name="lab_notes" rows={2} maxLength={2000} /></div>
          </div>
          <h2>{t("النتائج", "Results")}</h2>
          <LabRows types={labTypes} text={{
            test: t("التحليل", "Test"), result: t("النتيجة", "Result"), unit: t("الوحدة", "Unit"), refLow: t("المرجع الأدنى", "Ref. low"), refHigh: t("المرجع الأعلى", "Ref. high"),
            refText: t("المرجع النصي", "Ref. text"), refTextHint: t("مثال: سلبي (Negative) أو < 1.0", "e.g. Negative or < 1.0"),
            flag: t("علامة المختبر", "Lab flag"), add: t("إضافة تحليل", "Add a test"), remove: t("حذف الصف", "Remove row"), choose: t("اختر…", "Choose…"), row: t("نتيجة", "Result"),
            flags: LAB_FLAG.map((f) => ({ value: f.value, label: f[lang] })),
            customName: t("اسم التحليل كما في التقرير", "Test name as printed"), customHint: t("مثال: RDW-SD", "e.g. RDW-SD"),
          }} />
          {(openOrders ?? []).length > 0 && (
            <fieldset>
              <legend>{t("هل يجيب هذا التقرير عن فحوصات مطلوبة؟", "Does this report answer requested tests?")}</legend>
              <p className="small muted" style={{ marginBlockStart: 0 }}>{t("ما تحدده يُعلَّم «تم» ويُربط بهذا التقرير.", "Ticked requests are marked done and linked to this report.")}</p>
              <div className="check-grid">
                {(openOrders ?? []).map((o) => (
                  <label key={o.id as string} className="check"><input type="checkbox" name="fulfils" value={o.id as string} />
                    {o.name as string} <span className="muted small">({lbl(ORDER_STATUS, o.status as string, lang).split(" (")[0]})</span></label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="small muted">{t("اترك الوحدة فارغة لاستخدام الوحدة الافتراضية للتحليل. اكتب المرجع كما ورد في التقرير؛ إن لم تدخله فلن يُصنَّف التحليل.", "Leave unit empty to use the test’s default unit. Enter the reference range as printed; without it the result is not classified.")}</p>
          <div><SubmitButton pending={t("جارٍ الحفظ…", "Saving…")}>{t("حفظ التقرير", "Save report")}</SubmitButton></div>
        </ActionForm>
      </div>
    </>
  );
}
