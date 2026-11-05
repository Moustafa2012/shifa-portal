import Link from "next/link";
import { forSex } from "@/lib/sex";
import { Download, FileText, Image as ImageIcon, Lock, Printer } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { getAccess, getPatient, getSpecialties, specialtyName } from "@/lib/data";
import { getTz } from "@/lib/auth";
import { fmtBytes, fmtDate } from "@/lib/format";
import { DOC_TYPE, lbl, SENSITIVITY } from "@/lib/labels";
import { qs } from "@/lib/qs";
import { Banner, Card, Chip, Empty, PageHead } from "@/components/ui";
import { ActionForm, ConfirmButton } from "@/components/ui/client";
import { invalidateDocument, setDocumentSensitivity } from "@/app/actions/documents";

type SP = Record<string, string | undefined>;
const ERR: Record<string, [string, string]> = {
  storage_unconfigured: ["التخزين الآمن غير مضبوط على الخادم (SUPABASE_SERVICE_ROLE_KEY).", "Secure storage is not configured on the server (SUPABASE_SERVICE_ROLE_KEY)."],
  too_large: ["الملف أكبر من 20 ميغابايت.", "The file is larger than 20 MB."],
  bad_type: ["نوع الملف غير مسموح. المسموح: PDF أو JPG أو PNG أو WebP (يُفحص المحتوى لا الامتداد).", "File type not allowed. Allowed: PDF, JPG, PNG, WebP (content is checked, not the extension)."],
  active_content: ["رُفض ملف PDF لاحتوائه على محتوى نشط (جافاسكربت أو تشغيل تلقائي).", "This PDF was rejected because it contains active content (JavaScript or auto-launch)."],
  no_file: ["اختر ملفاً.", "Choose a file."], bad_form: ["بيانات غير صالحة.", "Invalid data."],
  duplicate: ["هذا الملف نفسه مرفوع من قبل في هذا الملف الطبي. إن أردت رفعه مرة أخرى فاختره من جديد وحدد «ارفعه رغم ذلك».", "This exact file is already in this record. To upload it again, choose it once more and tick “Upload anyway”."],
  upload_failed: ["تعذر رفع الملف.", "The upload failed."], register_failed: ["تعذر تسجيل المستند. تحقق من صلاحياتك.", "Could not register the document. Check your permissions."],
};

export default async function DocumentsPage({ params, searchParams }: { params: { pid: string }; searchParams: SP }) {
  const { lang, t } = i18n();
  const tz = getTz();
  const p = await getPatient(params.pid);
  const access = await getAccess(p.id);
  const specs = await getSpecialties();
  const supabase = createClient();
  let q = supabase.from("medical_documents").select("*").eq("patient_id", p.id).order("document_date", { ascending: false, nullsFirst: false }).order("uploaded_at", { ascending: false }).limit(300);
  if (searchParams.specialty) q = q.eq("specialty_id", searchParams.specialty);
  if (searchParams.type) q = q.eq("doc_type", searchParams.type);
  const [{ data }, { data: encs }, { data: reps }] = await Promise.all([
    q,
    supabase.from("encounters").select("id, kind, reason, started_at").eq("patient_id", p.id).eq("record_status", "active").order("started_at", { ascending: false }).limit(30),
    supabase.from("lab_reports").select("id, title, collected_at").eq("patient_id", p.id).eq("record_status", "active").order("collected_at", { ascending: false, nullsFirst: false }).limit(30),
  ]);
  const docs = (data ?? []) as Record<string, unknown>[];
  const live = docs.filter((d) => d.record_status === "active");
  const dead = docs.filter((d) => d.record_status !== "active");
  const base = `/patients/${p.id}/documents`;
  const err = searchParams.error ? ERR[searchParams.error] : null;

  const row = (d: Record<string, unknown>, isDead = false) => {
    const image = String(d.mime_type).startsWith("image/");
    const Ico = image ? ImageIcon : FileText;
    return (
      <article className={`rec${isDead ? " error" : ""}`} key={String(d.id)}>
        <div className="row between">
          <div className="row"><Ico size={18} aria-hidden="true" />
            <a className="rec-title" href={`/api/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{String(d.title)}</a>
            <Chip tone="info">{lbl(DOC_TYPE, String(d.doc_type), lang)}</Chip>
            {d.specialty_id ? <Chip tone="muted">{specialtyName(specs, String(d.specialty_id), lang)}</Chip> : null}
            {d.sensitivity !== "standard" && <Chip tone="warn"><Lock size={12} aria-hidden="true" />{lbl(SENSITIVITY, String(d.sensitivity), lang).split(" (")[0]}</Chip>}
            {isDead && <Chip tone="bad">{t("أُبطل", "Invalidated")}</Chip>}
          </div>
          <span className="muted small nowrap">{d.document_date ? fmtDate(String(d.document_date), lang, tz) : ""}</span>
        </div>
        {d.description ? <p className="rec-body">{String(d.description)}</p> : null}
        <div className="rec-meta">
          <span>{t("رُفع", "Uploaded")} {fmtDate(String(d.uploaded_at), lang, tz)} {d.contributed_by ? `${t("بواسطة طبيب عبر رابط مشاركة", "by a doctor through a share link")}${d.source_detail ? ` (${String(d.source_detail)})` : ""}` : d.uploaded_by === access.userId ? t("بواسطتك", "by you") : t("بواسطة مستخدم آخر", "by another user")}</span>
          <span>{String(d.original_filename)} · {fmtBytes(Number(d.size_bytes))}</span>
          <a href={`/api/documents/${d.id}?dl=1`}>{t("تنزيل", "Download")}</a>
        </div>
        {isDead && <p className="small muted">{t("السبب", "Reason")}: {String(d.invalidated_reason ?? "")}</p>}
        {access.canWrite && !isDead && (
          <div className="row no-print" style={{ marginBlockStart: ".5rem" }}>
            <ActionForm action={setDocumentSensitivity} className="row" resetOnSuccess={false}>
              <input type="hidden" name="_pid" value={p.id} /><input type="hidden" name="_id" value={String(d.id)} />
              <select name="sensitivity" defaultValue={String(d.sensitivity)} aria-label={t("الحساسية", "Sensitivity")} style={{ width: "auto" }}>{SENSITIVITY.map((o) => <option key={o.value} value={o.value}>{o[lang].split(" (")[0]}</option>)}</select>
              <button className="btn sm">{t("حفظ", "Save")}</button>
            </ActionForm>
            <ActionForm action={invalidateDocument} className="row">
              <input type="hidden" name="_pid" value={p.id} /><input type="hidden" name="_id" value={String(d.id)} />
              <input name="reason" type="text" required minLength={3} placeholder={t("سبب الإبطال", "Reason")} aria-label={t("السبب", "Reason")} />
              <ConfirmButton message={t("إبطال هذا المستند؟", "Invalidate this document?")}>{t("بالخطأ", "In error")}</ConfirmButton>
            </ActionForm>
          </div>
        )}
      </article>
    );
  };

  return (
    <>
      <PageHead
        title={t("المستندات والملفات المرفقة", "Attached medical documents")}
        sub={t("ملفات خاصة ومرفقات لا تُفتح إلا بصلاحية. لتوليد وطباعة تقارير الملف الطبي الرسمية تفضل بزيارة مركز التقارير.", "Private files and attachments. For generating and downloading official clinical PDF reports, visit the Reports Center.")}
        actions={
          <span className="row" style={{ gap: ".5rem" }}>
            <Link className="btn sm primary" href={`/patients/${p.id}/reports`}>
              <Printer size={14} aria-hidden="true" />
              {t("مركز وفهرس التقارير (PDF)", "Reports index & center")}
            </Link>
            {access.canManage ? <a className="btn sm" id="export-zip" href={`/api/patients/${p.id}/export`} download><Download size={14} aria-hidden="true" />{t("تصدير الملف كاملاً (ZIP)", "Export ZIP")}</a> : undefined}
          </span>
        }
      />
      {searchParams.uploaded && <Banner tone="ok">{t("تم رفع المستند.", "Document uploaded.")}</Banner>}
      {err && <Banner tone={searchParams.error === "duplicate" ? "warn" : "bad"}>{t(...err)}{searchParams.error === "duplicate" && searchParams.dup && /^[0-9a-f-]{36}$/.test(searchParams.dup) ? <> <a href={`/api/documents/${searchParams.dup}`} target="_blank" rel="noopener noreferrer">{t("فتح النسخة الموجودة", "Open the existing copy")}</a></> : null}</Banner>}
      {access.canWrite && (
        <details className="fold" open={live.length === 0 || searchParams.error === "duplicate"}>
          <summary>{t("+ رفع مستند", "+ Upload a document")}</summary>
          <div className="fold-body">
            <form method="post" action={`/api/patients/${p.id}/documents`} encType="multipart/form-data" className="stack">
              <div className="form-grid">
                <div className="field wide"><label htmlFor="file">{t("الملف (PDF / JPG / PNG / WebP، حتى 20 ميغابايت)", "File (PDF / JPG / PNG / WebP, up to 20 MB)")} <span className="req">*</span></label><input id="file" name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" /></div>
                <div className="field"><label htmlFor="title">{t("العنوان", "Title")}</label><input id="title" name="title" type="text" maxLength={200} /></div>
                <div className="field"><label htmlFor="doc_type">{t("النوع", "Type")}</label><select id="doc_type" name="doc_type" defaultValue="other">{DOC_TYPE.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
                <div className="field"><label htmlFor="specialty_id">{t("التخصص", "Specialty")}</label><select id="specialty_id" name="specialty_id" defaultValue=""><option value="">—</option>{forSex(specs, p.sex).map((s) => <option key={s.id} value={s.id}>{lang === "ar" ? s.name_ar : s.name_en}</option>)}</select></div>
                <div className="field"><label htmlFor="document_date">{t("تاريخ المستند", "Document date")}</label><input id="document_date" name="document_date" type="date" /></div>
                <div className="field"><label htmlFor="sensitivity">{t("مستوى الحساسية", "Sensitivity")}</label><select id="sensitivity" name="sensitivity" defaultValue="standard">{SENSITIVITY.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
                {(encs ?? []).length > 0 && <div className="field"><label htmlFor="encounter_id">{t("ربط بزيارة", "Link to a visit")}</label><select id="encounter_id" name="encounter_id" defaultValue=""><option value="">—</option>{(encs ?? []).map((e) => <option key={e.id as string} value={e.id as string}>{fmtDate(e.started_at as string, lang, tz)} — {(e.reason as string) ?? (e.kind as string)}</option>)}</select></div>}
                {(reps ?? []).length > 0 && <div className="field"><label htmlFor="lab_report_id">{t("ربط بتقرير تحاليل", "Link to a lab report")}</label><select id="lab_report_id" name="lab_report_id" defaultValue=""><option value="">—</option>{(reps ?? []).map((r) => <option key={r.id as string} value={r.id as string}>{r.title as string}</option>)}</select></div>}
                <div className="field wide"><label htmlFor="description">{t("وصف", "Description")}</label><textarea id="description" name="description" rows={2} maxLength={1000} /></div>
              </div>
              {searchParams.error === "duplicate" && <label className="form-confirm"><input type="checkbox" name="allow_duplicate" />{t("ارفعه رغم ذلك (نسخة ثانية مقصودة)", "Upload anyway (an intended second copy)")}</label>}
              <div><button className="btn primary">{t("رفع", "Upload")}</button></div>
            </form>
          </div>
        </details>
      )}
      <Card title={t(`المستندات (${live.length})`, `Documents (${live.length})`)} actions={
        <form method="get" className="row"><select name="specialty" defaultValue={searchParams.specialty ?? ""} aria-label={t("التخصص", "Specialty")} style={{ width: "auto" }}><option value="">{t("كل التخصصات", "All specialties")}</option>{forSex(specs, p.sex).map((s) => <option key={s.id} value={s.id}>{lang === "ar" ? s.name_ar : s.name_en}</option>)}</select>
          <select name="type" defaultValue={searchParams.type ?? ""} aria-label={t("النوع", "Type")} style={{ width: "auto" }}><option value="">{t("كل الأنواع", "All types")}</option>{DOC_TYPE.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select>
          <button className="btn sm">{t("تصفية", "Filter")}</button>{(searchParams.specialty || searchParams.type) && <Link className="btn ghost sm" href={base + qs({}, {})}>{t("مسح", "Clear")}</Link>}</form>
      }>
        {live.length === 0 ? <Empty>{t("لا توجد مستندات.", "No documents.")}</Empty> : live.map((d) => row(d))}
        {dead.length > 0 && <details style={{ marginBlockStart: ".8rem" }}><summary className="muted small">{t(`مستندات مُبطلة (${dead.length})`, `Invalidated documents (${dead.length})`)}</summary>{dead.map((d) => row(d, true))}</details>}
      </Card>
    </>
  );
}
