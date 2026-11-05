"use client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

import { useMemo, useState, type ReactNode } from "react";
import type { Lang } from "@/lib/i18n";
import {
  DISEASE_KINDS, EVIDENCE, FINDING_KIND, FINDING_SEVERITY, MATERIAL, SURFACES, TOOTH_STATUS, WHOLE_TOOTH_KINDS, chartSummary, deriveChart,
  fmtSurfaces, surfaceCode, surfaceName, toothName, toothLinks, OPEN_PROBLEM, type Dentition, type ExamRow, type FindingRow,
  type ToothDiagnosis, type ToothImage, type ToothPlanned, type ToothProcedure,
} from "@/lib/dental";
import { CERTAINTY, CLINICAL_STATUS, DATE_PRECISION, IMAGING_MODALITY, lbl } from "@/lib/labels";
import { ITEM_STATUS } from "@/lib/treatment";
import { fmtPartialDate } from "@/lib/format";
import { Chip } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/ui/client";
import { addDentalFinding, invalidateDental, resolveDentalFinding } from "@/app/actions/dental";
import { Odontogram, OdontoLegend, type ChartTooth } from "./Odontogram";
import { Panoramic, PanoLegend } from "./Panoramic";
import { ImageViewer, type ViewerAnnotations, type ViewerDoc } from "./ImageViewer";
import { isWholeMouth, summarizeBoneLevels } from "@/lib/dental-imaging";

export type DentalDiagnosis = ToothDiagnosis;

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** how the image viewer reaches the files (the patient's own route, or the doctor's share route) and what it may do with annotations */
export interface ChartViewer { docBase: string; annotations: ViewerAnnotations }

/**
 * A form offered in the panel of the chosen tooth ("add a diagnosis for this tooth"…). The form is rendered by the page
 * (server side, with its own action); the chart only supplies the tooth, through a hidden `teeth` input bound to the
 * form by its id.
 */
export interface ToothAddForm { id: string; label: string; node: ReactNode }

/** The current chart (or the chart as it was on a past date), with a panel for the chosen tooth. */
export function DentalChart({
  dentition, exams, findings, diagnoses, contributors, lang, pid, canWrite, today, asOf, specialtyId, procedures = [], images = [], problemsHref, toothAdd = [], toothAddTitle, planned = [], treatmentHref, viewer,
}: {
  dentition: Dentition; exams: ExamRow[]; findings: FindingRow[]; diagnoses: DentalDiagnosis[]; contributors: Record<string, string>;
  procedures?: ToothProcedure[]; images?: ToothImage[]; problemsHref?: string; toothAdd?: ToothAddForm[]; toothAddTitle?: string;
  /** treatments still to happen (current plans), and where the plans are */
  planned?: ToothPlanned[]; treatmentHref?: string;
  /** opens the image files of the studies in the viewer (zoom, compare, annotate); without it files open as plain links */
  viewer?: ChartViewer;
  lang: Lang; pid?: string; canWrite: boolean; today: string; asOf?: string | null; specialtyId?: string | null;
}) {
  const ar = lang === "ar";
  const t = (a: string, e: string) => (ar ? a : e);
  const chart = useMemo(() => deriveChart(exams, findings, asOf ?? undefined), [exams, findings, asOf]);
  const links = useMemo(() => (asOf ? new Map() : toothLinks(diagnoses, procedures, images, planned)), [diagnoses, procedures, images, planned, asOf]);
  const teeth = useMemo(() => {
    const out: Record<number, ChartTooth> = Object.fromEntries([...chart].map(([k, v]) => [k, { status: v.status, findings: v.findings } as ChartTooth]));
    for (const [k, l] of links) out[k] = { ...(out[k] ?? { status: null, findings: [] }), links: l };
    return out;
  }, [chart, links]);
  const [sel, setSel] = useState<number | null>(null);
  // the panoramic (anatomical) view by default; the five-surface view for detail
  const [view, setView] = useState<"pano" | "surfaces">("pano");
  const sum = chartSummary(chart);
  // a tooth "has a problem" from an exam finding or from an open diagnosis that names it
  sum.disease = new Set([...[...chart.values()].filter((v) => v.findings.some((f) => DISEASE_KINDS.has(f.kind))).map((v) => v.tooth),
    ...[...links].filter(([, l]) => l.problems.length).map(([k]) => k)]).size;
  const v = sel ? chart.get(sel) : undefined;
  const history = sel ? findings.filter((f) => f.tooth === sel).sort((a, b) => b.observed_on.localeCompare(a.observed_on)) : [];
  const stateHistory = sel ? exams.flatMap((e) => e.states.filter((s) => s.tooth === sel).map((s) => ({ ...s, date: e.exam_date, exam: e })))
    .sort((a, b) => b.date.localeCompare(a.date)) : [];
  const dx = sel ? diagnoses.filter((d) => d.teeth?.includes(sel)).sort((a, b) => Number(OPEN_PROBLEM.has(b.clinical_status ?? "active")) - Number(OPEN_PROBLEM.has(a.clinical_status ?? "active"))) : [];
  const px = sel ? procedures.filter((p) => p.teeth?.includes(sel)) : [];
  // an image naming the tooth, and the whole-mouth images (a panoramic shows every tooth)
  const ix = sel ? images.filter((i) => i.teeth?.includes(sel) || isWholeMouth(i.modality, i.teeth)) : [];
  const wholeMouth = images.filter((i) => isWholeMouth(i.modality, i.teeth));
  const [viewing, setViewing] = useState<string | null>(null);
  const imgOf = (id: string | null | undefined) => (id ? images.find((i) => i.id === id) : undefined);
  const imgLabel = (i: ToothImage) => `${lbl(IMAGING_MODALITY, i.modality, lang)}${i.performed_on ? ` ${fmtPartialDate(i.performed_on, i.date_precision ?? "day", lang)}` : ""}`;
  const viewDocs: ViewerDoc[] = useMemo(() => images.flatMap((i) => (i.documents ?? []).filter((d) => !d.mime_type || IMAGE_MIME.has(d.mime_type))
    .map((d) => ({ id: d.id, title: d.title, imaging_id: i.id, label: `${imgLabel(i)} · ${d.title}` }))), [images, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const docBase = viewer?.docBase ?? "/api/documents/";
  const docLink = (d: { id: string; title: string; mime_type?: string | null }) =>
    viewer && viewDocs.some((v) => v.id === d.id)
      ? <button type="button" className="btn sm" onClick={() => setViewing(d.id)} aria-label={t(`عرض ${d.title} في العارض`, `Open ${d.title} in the viewer`)}>{t("عرض", "View")} · {d.title}</button>
      : <a href={`${docBase}${d.id}`} target="_blank" rel="noopener noreferrer">{d.title}</a>;
  const imageLine = (i: ToothImage) => (
    <li key={i.id} data-image={i.id}><strong>{lbl(IMAGING_MODALITY, i.modality, lang)}</strong>{i.body_site ? ` — ${i.body_site}` : ""}
      <span className="muted small"> · {i.performed_on ? fmtPartialDate(i.performed_on, i.date_precision ?? "day", lang) : t("التاريخ غير معروف", "date unknown")}</span>
      {isWholeMouth(i.modality, i.teeth) && <Chip tone="info">{t("كامل الفم", "Whole mouth")}</Chip>}
      {i.contributed_by && <Chip tone="info">{t("أضافه طبيب عبر رابط", "Added by a doctor via a link")}</Chip>}
      {i.bone_levels && <div className="small"><span className="muted">{t("فقد العظم", "Bone level")}:</span> <span className="ltr">{summarizeBoneLevels(i.bone_levels, lang)}</span></div>}
      {i.impression && <div className="small">{i.impression}</div>}
      {(i.documents ?? []).map((d) => <div key={d.id} className="small">{docLink(d)}</div>)}</li>
  );
  const tx = sel && !asOf ? planned.filter((p) => p.teeth?.includes(sel)) : [];
  const examOf = (id: string | null) => exams.find((e) => e.id === id);
  const day = (v: string | null | undefined) => fmtPartialDate(v ?? null, "day", lang);

  const prov = (r: { contributed_by?: string | null; verification?: string | null; source_detail?: string | null }) =>
    r.contributed_by ? <Chip tone="info">{t(`أضافه ${contributors[r.contributed_by] ?? "طبيب"} عبر رابط`, `Added by ${contributors[r.contributed_by] ?? "a doctor"} via a link`)}</Chip>
      : r.verification === "reported" ? <Chip tone="muted">{t("إفادة غير موثقة", "Unverified (reported)")}</Chip>
        : <Chip tone="ok">{t("موثّق", "Confirmed")}</Chip>;

  const findingLine = (f: FindingRow, tooth: number) => (
    <>
      <strong>{lbl(FINDING_KIND, f.kind, lang)}</strong>
      {f.surfaces.length > 0 && <>{" "}<span className="ltr">{fmtSurfaces(f.surfaces, tooth)}</span></>}
      {f.material && <span> · {lbl(MATERIAL, f.material, lang)}</span>}
      {f.severity && <span> · {lbl(FINDING_SEVERITY, f.severity, lang)}</span>}
      <span className="muted small"> · {fmtPartialDate(f.observed_on, f.date_precision ?? "day", lang)} · {lbl(EVIDENCE, f.evidence, lang)}</span>
      {imgOf(f.imaging_id) && <span className="muted small finding-image"> · {t("من صورة", "from")} {imgLabel(imgOf(f.imaging_id)!)}</span>}
    </>
  );

  return (
    <div className="dental-chart">
      <div className="row between" style={{ marginBlockEnd: ".5rem" }}>
        <Tabs value={view} onValueChange={(v) => setView(v as "pano" | "surfaces")}>
          <TabsList className="chart-views">
            <TabsTrigger value="pano">{t("بانوراما", "Panoramic")}</TabsTrigger>
            <TabsTrigger value="surfaces">{t("الأسطح", "Surfaces")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {view === "pano"
        ? <Panoramic dentition={dentition} teeth={teeth} lang={lang} selected={sel} onSelect={setSel} idPrefix="chart" />
        : <Odontogram dentition={dentition} teeth={teeth} lang={lang} selected={sel} onSelect={setSel} idPrefix="chart" />}
      <p className="small muted">
        {t(`أسنان لها بيانات فحص: ${sum.examined} · مفقودة/مخلوعة: ${sum.absent} · بها مشكلة: ${sum.disease} · بها علاج موجود: ${sum.work}`,
          `Teeth with exam data: ${sum.examined} · missing/extracted: ${sum.absent} · with a problem: ${sum.disease} · with existing work: ${sum.work}`)}
      </p>
      {view === "pano" ? <PanoLegend lang={lang} teeth={teeth} /> : <OdontoLegend lang={lang} />}

      {wholeMouth.length > 0 && (
        <section className="whole-mouth" aria-label={t("صور الفم كاملاً", "Whole-mouth images")}>
          <h4>{t("صور الفم كاملاً", "Whole-mouth images")}</h4>
          <ul className="tooth-list">{wholeMouth.map(imageLine)}</ul>
        </section>
      )}

      {!sel ? <p className="hint">{t("اختر سناً لعرض تفاصيله وتاريخه.", "Choose a tooth to see its details and history.")}</p> : (
        <section className="tooth-panel" aria-live="polite" aria-label={t(`السن ${sel}`, `Tooth ${sel}`)}>
          <div className="row between">
            <h3><span className="ltr">{sel}</span> — {toothName(sel, lang)}</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSel(null)}>{t("إغلاق", "Close")}</Button>
          </div>
          <p>
            {v?.status ? <>{t("الحالة", "State")}: <strong>{lbl(TOOTH_STATUS, v.status, lang)}</strong>
              <span className="muted small"> — {t("آخر فحص", "last exam")} {day(v.statusDate)}</span></>
              : <span className="muted">{t("لا يوجد فحص سجّل حالة هذا السن (لا يعني أنه سليم).", "No exam recorded this tooth's state (not the same as healthy).")}</span>}
          </p>

          <h4>{asOf ? t(`الموجود حتى ${day(asOf)}`, `Present as of ${day(asOf)}`) : t("الموجود حالياً", "Current")}</h4>
          {(v?.findings ?? []).length === 0 ? <p className="muted small">{t("لا شيء مسجل.", "Nothing recorded.")}</p> : (
            <ul className="tooth-list">
              {v!.findings.map((f) => (
                <li key={f.id} className={DISEASE_KINDS.has(f.kind) ? "disease" : "work"}>
                  <div>{findingLine(f, sel)} {prov(f)}</div>
                  {f.notes && <div className="small">{f.notes}</div>}
                  {canWrite && pid && !asOf && (
                    <div className="row" style={{ gap: ".4rem" }}>
                      <details className="fold"><summary>{t("عولج / انتهى", "Treated / resolved")}</summary><div className="fold-body">
                        <ActionForm action={resolveDentalFinding} className="row">
                          <input type="hidden" name="_pid" value={pid} /><input type="hidden" name="_id" value={f.id} />
                          <input type="date" name="resolved_on" required defaultValue={today} max={today} aria-label={t("التاريخ", "Date")} />
                          <input name="resolved_note" maxLength={500} placeholder={t("كيف؟ (مثلاً: حُشي في عيادة…)", "How? (e.g. filled at…)")} aria-label={t("ملاحظة", "Note")} style={{ flex: 1, minWidth: 160 }} />
                          <SubmitButton className="btn sm">{t("حفظ", "Save")}</SubmitButton>
                        </ActionForm></div></details>
                      {!f.contributed_by && (
                        <details className="fold"><summary>{t("أُدخل خطأً", "Entered in error")}</summary><div className="fold-body">
                          <ActionForm action={invalidateDental} className="row">
                            <input type="hidden" name="_pid" value={pid} /><input type="hidden" name="_id" value={f.id} /><input type="hidden" name="_table" value="dental_findings" />
                            <input name="reason" required minLength={3} maxLength={400} placeholder={t("السبب", "Reason")} aria-label={t("السبب", "Reason")} style={{ flex: 1, minWidth: 160 }} />
                            <ConfirmButton message={t("إبطال هذا الموجود؟ يبقى في التاريخ مع السبب.", "Invalidate this finding? It stays in the history with the reason.")}>{t("إبطال", "Invalidate")}</ConfirmButton>
                          </ActionForm></div></details>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h4>{t("التشخيصات والمشكلات", "Diagnoses & problems")}</h4>
          {dx.length === 0 ? <p className="muted small">{t("لا تشخيص يسمّي هذا السن.", "No diagnosis names this tooth.")}</p> : (
            <ul className="tooth-list">{dx.map((d) => {
              const open = OPEN_PROBLEM.has(d.clinical_status ?? "active") && d.certainty !== "refuted";
              return (
                <li key={d.id} className={open ? "disease" : ""}><strong>{d.name}</strong>{" "}
                  <Chip tone={open ? "bad" : "ok"}>{d.certainty === "refuted" ? lbl(CERTAINTY, "refuted", lang) : lbl(CLINICAL_STATUS, d.clinical_status, lang)}</Chip>
                  {d.certainty !== "confirmed" && d.certainty !== "refuted" && <Chip tone="muted">{lbl(CERTAINTY, d.certainty, lang)}</Chip>}
                  {d.contributed_by && <Chip tone="info">{t("أضافه طبيب عبر رابط", "Added by a doctor via a link")}</Chip>}
                  {d.resolved_date && !open && <span className="muted small"> · {fmtPartialDate(d.resolved_date, "day", lang)}</span>}
                </li>
              );
            })}</ul>
          )}
          {problemsHref && canWrite && !asOf && <p className="small"><a href={problemsHref}>{toothAdd.length ? t("تغيير حالة تشخيص ←", "Change a diagnosis status →") : t("تغيير حالة تشخيص أو إضافة تشخيص لهذا السن ←", "Change a diagnosis status or add one for this tooth →")}</a></p>}

          {tx.length > 0 && (<>
            <h4>{t("العلاج المخطط", "Planned treatment")}</h4>
            <ul className="tooth-list">{tx.map((p) => (
              <li key={p.id} className="planned"><strong>{p.name}</strong> <Chip tone="warn">{lbl(ITEM_STATUS, p.status, lang)}</Chip>
                <span className="muted small"> · {treatmentHref ? <a href={`${treatmentHref}#plan-${p.plan_id}`}>{p.plan}</a> : p.plan}</span></li>
            ))}</ul>
          </>)}

          {px.length > 0 && (<>
            <h4>{t("الإجراءات", "Procedures")}</h4>
            <ul className="tooth-list">{px.map((p) => (
              <li key={p.id} className="work"><strong>{p.name}</strong>
                <span className="muted small"> · {p.performed_on ? fmtPartialDate(p.performed_on, p.date_precision ?? "day", lang) : t("التاريخ غير معروف", "date unknown")}{p.operator_name ? ` · ${p.operator_name}` : ""}</span>
                {p.contributed_by && <Chip tone="info">{t("أضافه طبيب عبر رابط", "Added by a doctor via a link")}</Chip>}</li>
            ))}</ul>
          </>)}

          {ix.length > 0 && (<>
            <h4>{t("الصور والأشعة", "Images & X-rays")}</h4>
            <ul className="tooth-list">{ix.map(imageLine)}</ul>
          </>)}

          <h4>{t("تاريخ السن", "Tooth history")}</h4>
          {history.length === 0 && stateHistory.length === 0 ? <p className="muted small">{t("لا تاريخ مسجل.", "No history recorded.")}</p> : (
            <ol className="tooth-hist">
              {[...history.map((f) => ({ key: `f${f.id}`, date: f.observed_on, node: (
                <>{findingLine(f, sel)}{f.resolved_on && <Chip tone="ok">{t(`عولج ${day(f.resolved_on)}`, `resolved ${day(f.resolved_on)}`)}{f.resolved_note ? ` — ${f.resolved_note}` : ""}</Chip>}
                  {f.exam_id && examOf(f.exam_id)?.examiner_name && <span className="muted small"> · {examOf(f.exam_id)!.examiner_name}</span>}</>
              ) })),
              ...stateHistory.map((s) => ({ key: `s${s.exam.id}`, date: s.date, node: (
                <>{t("الحالة", "State")}: <strong>{lbl(TOOTH_STATUS, s.status, lang)}</strong>{s.note && ` — ${s.note}`}
                  <span className="muted small"> · {day(s.date)}{s.exam.examiner_name ? ` · ${s.exam.examiner_name}` : ""}</span></>
              ) }))].sort((a, b) => b.date.localeCompare(a.date)).map((x) => <li key={x.key}>{x.node}</li>)}
            </ol>
          )}

          {toothAdd.length > 0 && !asOf && (
            <div className="tooth-add">
              <h4>{toothAddTitle ?? t(`أضف للسن ${sel}`, `Add for tooth ${sel}`)}</h4>
              <p className="small muted">{t("السن والقسم معروفان من المخطط، فلا يُسأل عنهما.", "The tooth and the specialty are known from the chart, so they are not asked.")}</p>
              {toothAdd.map((a) => (
                <details className="fold" key={a.id} id={`${a.id}-fold`}>
                  <summary>{a.label}</summary>
                  <div className="fold-body">
                    <input type="hidden" name="teeth" form={a.id} value={sel} />
                    {a.node}
                  </div>
                </details>
              ))}
            </div>
          )}

          {canWrite && pid && !asOf && (
            <details className="fold"><summary>{t("أضف إلى هذا السن (خارج فحص)", "Add to this tooth (outside an exam)")}</summary>
              <div className="fold-body">
                <AddFinding pid={pid} tooth={sel} lang={lang} today={today} specialtyId={specialtyId ?? ""} />
              </div>
            </details>
          )}
        </section>
      )}
      {viewing && viewer && viewDocs.length > 0 && (
        <ImageViewer docs={viewDocs} startId={viewing} docBase={docBase} lang={lang} annotations={viewer.annotations} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function AddFinding({ pid, tooth, lang, today, specialtyId }: { pid: string; tooth: number; lang: Lang; today: string; specialtyId: string }) {
  const t = (a: string, e: string) => (lang === "ar" ? a : e);
  const [kind, setKind] = useState("filling");
  const whole = WHOLE_TOOTH_KINDS.has(kind);
  return (
    <ActionForm action={addDentalFinding} className="stack" id={`add-finding-${tooth}`}>
      <input type="hidden" name="_pid" value={pid} /><input type="hidden" name="tooth" value={tooth} /><input type="hidden" name="_spec" value={specialtyId} />
      <div className="form-grid">
        <div className="field"><label htmlFor={`af_kind_${tooth}`}>{t("ما الموجود", "What")}</label>
          <select id={`af_kind_${tooth}`} name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>{FINDING_KIND.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
        <div className="field"><label htmlFor={`af_ev_${tooth}`}>{t("المصدر / الإثبات", "Evidence")}</label>
          <select id={`af_ev_${tooth}`} name="evidence" defaultValue="patient_reported">{EVIDENCE.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
        {DISEASE_KINDS.has(kind)
          ? <div className="field"><label htmlFor={`af_sev_${tooth}`}>{t("الشدة", "Severity")}</label><select id={`af_sev_${tooth}`} name="severity" defaultValue=""><option value="">—</option>{FINDING_SEVERITY.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>
          : <div className="field"><label htmlFor={`af_mat_${tooth}`}>{t("المادة", "Material")}</label><select id={`af_mat_${tooth}`} name="material" defaultValue=""><option value="">—</option>{MATERIAL.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div>}
        <div className="field"><label htmlFor={`af_date_${tooth}`}>{t("منذ / بتاريخ", "Since / on")} <span className="req">*</span></label>
          <div className="date-prec"><input id={`af_date_${tooth}`} name="observed_on" type="date" required max={today} />
            <select name="date_precision" defaultValue="year" aria-label={t("دقة التاريخ", "Date precision")}>{DATE_PRECISION.map((o) => <option key={o.value} value={o.value}>{o[lang]}</option>)}</select></div></div>
        {!whole && (
          <fieldset className="field wide surf-pick"><legend>{t("الأسطح (إن عُرفت)", "Surfaces (if known)")}</legend>
            {SURFACES.map((s) => <label key={s} className="pill"><input type="checkbox" name="surfaces" value={s} /><span className="ltr">{surfaceCode(s, tooth)}</span> {surfaceName(s, tooth, lang)}</label>)}
          </fieldset>
        )}
        <div className="field wide"><label htmlFor={`af_notes_${tooth}`}>{t("ملاحظة", "Note")}</label><input id={`af_notes_${tooth}`} name="notes" maxLength={2000} /></div>
      </div>
      <div><SubmitButton>{t("إضافة", "Add")}</SubmitButton></div>
    </ActionForm>
  );
}
