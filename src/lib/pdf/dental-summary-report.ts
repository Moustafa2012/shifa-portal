import "server-only";
import { fmtDateTime, fmtPartialDate } from "@/lib/format";
import { IMAGING_MODALITY, RECALL_KIND, lbl } from "@/lib/labels";
import { PULP_RESULTS, PULP_TESTS, pulpLabel } from "@/lib/dental-exam";
import { summarizeBoneLevels } from "@/lib/dental-imaging";
import { worstBoneText, type DentalSummary, type SummaryItem } from "@/lib/dental-summary";
import { dxLine } from "@/lib/perio-staging";
import { ITEM_STATUS } from "@/lib/treatment";
import type { SafetyAlert } from "@/lib/safety-rules";
import type { Block, Cell, ReportMeta } from "@/lib/pdf/engine";
import { headline, safetyBlocks, type PdfPatient } from "@/lib/pdf/rx-reports";

/*
 * The "Dental summary" PDF: the same facts as the summary card (buildDentalSummary), in words. The PDF font has no glyphs for
 * comparison and arrow signs or bullets, so every sentence here is in words and plain ASCII punctuation.
 */

type Lang = "ar" | "en";
const tx = (lang: Lang) => (ar: string, en: string) => (lang === "ar" ? ar : en);

export function buildDentalSummaryReport(p: PdfPatient, s: DentalSummary, o: { lang: Lang; tz: string; alerts: SafetyAlert[]; byShare?: boolean; clinician?: string | null }): { meta: ReportMeta; blocks: Block[]; filename: string } {
  const { lang, tz } = o;
  const t = tx(lang);
  const day = (v: string | null | undefined, prec?: string | null) => (v ? fmtPartialDate(v, prec ?? "day", lang, tz) : "");
  const teeth = (list: number[]) => list.join(", ");
  const blocks: Block[] = [];
  const kv = (rows: [string, string][]) => blocks.push({ t: "kv", rows: rows.filter(([, v]) => v) });
  const none = (text: string) => blocks.push({ t: "p", muted: true, text });

  if (s.empty) none(t("لا يوجد في الملف السني ما يُلخَّص بعد.", "The dental file has nothing to summarise yet."));
  if (s.softTissue) {
    blocks.push({ t: "alert", tone: "bad", title: t("آفة مشتبهة مفتوحة في الأنسجة الرخوة", "Open suspicious lesion in the soft tissues"), text:
      `${t(`سُجّلت في فحص ${day(s.softTissue.exam_date)}`, `Recorded at the exam of ${day(s.softTissue.exam_date)}`)}${s.softTissue.examiner_name ? ` (${s.softTissue.examiner_name})` : ""}`
      + `${s.softTissue.note ? ` - ${s.softTissue.note}` : ""}. ${t("تحتاج متابعة أو تحويلاً لأخصائي.", "It needs follow-up or a specialist.")}` });
  }

  blocks.push({ t: "h", text: t("حالة المخطط الحالية", "Current chart") });
  if (s.chart.examined === 0 && s.chart.openFindings === 0) none(t("لا فحص مسجل بعد.", "No exam recorded yet."));
  else {
    const row = (list: number[]) => (list.length ? `${list.length} (${teeth(list)})` : "0");
    kv([[t("أسنان مفقودة", "Missing teeth"), row(s.chart.missing)], [t("أسنان مرمَّمة", "Restored teeth"), row(s.chart.restored)],
      [t("زرعات", "Implants"), row(s.chart.implants)], [t("أسنان بموجودات مفتوحة", "Teeth with open findings"), row(s.chart.open)],
      [t("عدد الموجودات المفتوحة", "Open findings"), String(s.chart.openFindings)], [t("أسنان فُحصت", "Teeth examined"), String(s.chart.examined)]]);
  }

  blocks.push({ t: "h", text: t("الفحص الأساسي", "Baseline exam") });
  if (s.baseline) kv([[t("التاريخ", "Date"), day(s.baseline.exam_date)], [t("الفاحص", "Examiner"), s.baseline.examiner_name ?? ""]]);
  else none(t("لا فحص أساسي شامل بعد.", "No comprehensive baseline exam yet."));

  blocks.push({ t: "h", text: t("اللثة: آخر مخطط معتمد", "Gums: latest final periodontal chart") });
  const pe = s.perio;
  if (!pe) none(t("لا مخطط لثة معتمد.", "No final periodontal chart."));
  else {
    const dx = dxLine({ dx_kind: pe.dx_kind, dx_stage: pe.dx_stage, dx_grade: pe.dx_grade, dx_extent: pe.dx_extent }, lang);
    kv([
      [t("التاريخ", "Date"), day(pe.exam_date)], [t("الفاحص", "Examiner"), pe.examiner_name ?? ""],
      [t("التشخيص (تصنيف 2017)", "Diagnosis (2017 classification)"), dx || t("لم يُسجَّل تشخيص لثوي", "No periodontal diagnosis recorded")],
      [t("فقد العظم الشعاعي", "Radiographic bone loss"), pe.dx_rbl_pct == null ? "" : `${pe.dx_rbl_pct}%`],
      [t("النزف عند السبر", "Bleeding on probing"), pe.stats.bopPct === null ? "" : `${pe.stats.bopPct}%`],
      [t("متوسط العمق", "Mean depth"), pe.stats.meanPd === null ? "" : `${pe.stats.meanPd} ${t("مم", "mm")}`],
      [t("جيوب 4 / 6 مم فأكثر", "Pockets 4+ / 6+ mm"), `${pe.stats.pd4} / ${pe.stats.pd6}`],
    ]);
    if (pe.change) {
      const dir = pe.change.direction === "worse" ? t("أسوأ", "Worse") : pe.change.direction === "better" ? t("أفضل", "Better") : t("مستقر", "Stable");
      blocks.push({ t: "alert", tone: pe.change.direction === "worse" ? "bad" : pe.change.direction === "better" ? "ok" : "info", title: `${t("التغيّر منذ المخطط السابق", "Change since the previous chart")}: ${dir}`, text:
        t(`مقارنة بمخطط ${day(pe.change.previous_date)}: ازداد فقد الارتباط في ${pe.change.worse} من المواقع وتحسّن في ${pe.change.better}`,
          `Against the chart of ${day(pe.change.previous_date)}: attachment worsened at ${pe.change.worse} ${pe.change.worse === 1 ? "site" : "sites"}, improved at ${pe.change.better}`)
        + (pe.change.lost.length ? t(`، وأسنان فُقدت: ${teeth(pe.change.lost)}`, `; teeth lost: ${teeth(pe.change.lost)}`) : "")
        + (pe.change.bop[0] !== null && pe.change.bop[1] !== null ? t(`، النزف ${pe.change.bop[0]}% ثم ${pe.change.bop[1]}%`, `; bleeding ${pe.change.bop[0]}% then ${pe.change.bop[1]}%`) : "") });
    } else none(t("لا مخطط سابق للمقارنة.", "No earlier chart to compare with."));
  }

  blocks.push({ t: "h", text: t("اختبارات حيوية العصب غير الطبيعية", "Abnormal pulp tests") });
  if (!s.pulp.length) none(t("لا نتائج غير طبيعية.", "No abnormal results."));
  else blocks.push({ t: "table", cols: [{ label: t("السن", "Tooth"), w: 2 }, { label: t("الاختبار", "Test"), w: 4 }, { label: t("النتيجة", "Result"), w: 5 }, { label: t("التاريخ", "Date"), w: 3 }],
    rows: s.pulp.map((x): Cell[] => [String(x.tooth), pulpLabel(PULP_TESTS, x.test, lang), { text: pulpLabel(PULP_RESULTS, x.result, lang), tone: "warn" }, day(x.exam_date)]) });

  blocks.push({ t: "h", text: t("آخر صورة للفم كاملاً", "Latest whole-mouth image") });
  const im = s.image;
  if (!im) none(t("لا صورة بانوراما أو CBCT أو سيفالومترية.", "No panoramic, CBCT or cephalometric image."));
  else kv([
    [t("النوع", "Kind"), lbl(IMAGING_MODALITY, im.modality, lang)], [t("التاريخ", "Date"), day(im.performed_on, im.date_precision)],
    [t("قراءة العظم", "Bone reading"), im.bone && Object.keys(im.bone).length ? summarizeBoneLevels(im.bone, lang) : t("لا قراءة منظَّمة", "No structured reading")],
    [t("أشد مستوى", "Worst level"), im.worst ? worstBoneText(im.worst, lang) : ""], [t("الانطباع", "Impression"), im.impression ?? ""], [t("الموجودات", "Findings"), im.findings ?? ""],
  ]);

  blocks.push({ t: "h", text: t("العلاج", "Treatment") });
  const items = (title: string, list: SummaryItem[], dateCol: "scheduled" | "completed") => {
    blocks.push({ t: "p", text: `${title} (${list.length})` });
    if (!list.length) return;
    blocks.push({ t: "table", cols: [{ label: t("السن", "Tooth"), w: 2 }, { label: t("العلاج", "Treatment"), w: 5 }, { label: t("الحالة", "Status"), w: 3 }, { label: dateCol === "completed" ? t("أُنجز في", "Done on") : t("الموعد", "Scheduled"), w: 3 }],
      rows: list.map((i): Cell[] => [teeth(i.teeth), { text: i.name, bold: true }, lbl(ITEM_STATUS, i.status, lang), day(dateCol === "completed" ? i.completed_on : i.scheduled_for)]) });
  };
  items(t("مقترح", "Proposed"), s.treatment.proposed, "scheduled");
  items(t("موافَق عليه أو مجدول أو قيد التنفيذ", "Accepted, scheduled or in progress"), s.treatment.accepted, "scheduled");
  items(t(`منجز منذ ${day(s.treatment.completedSince)}`, `Completed since ${day(s.treatment.completedSince)}`), s.treatment.completed, "completed");

  blocks.push(...(o.alerts.length ? safetyBlocks(o.alerts, lang) : [{ t: "h", text: t("تنبيهات السلامة", "Safety alerts") } as Block, { t: "p", muted: true, text: t("لا تنبيهات فعّالة.", "No active alerts.") } as Block]));

  blocks.push({ t: "h", text: t("الفحص الدوري القادم", "Next recall") });
  if (!s.recall) none(t("لا فحص دوري فعّال.", "No active recall."));
  else kv([
    [t("النوع", "Kind"), s.recall.kind === "other" ? s.recall.label ?? "" : lbl(RECALL_KIND, s.recall.kind, lang)], [t("الموعد", "Due"), day(s.recall.due_on)],
    [t("الحالة", "State"), s.recall.state === "overdue" ? t("متأخر", "Overdue") : s.recall.state === "due_soon" ? t("خلال 30 يوماً", "Within 30 days") : t("قادم", "Upcoming")],
    [t("التكرار", "Repeats"), t(`كل ${s.recall.interval_months} أشهر`, `every ${s.recall.interval_months} months`)],
  ]);

  const docRef = `${p.mrn}-DENTAL-SUMMARY`;
  return {
    meta: {
      lang, title: t("ملخص الأسنان", "Dental summary"), subtitle: o.byShare ? (o.clinician ?? undefined) : undefined, brand: t("بوابة شفاء", "Shifa Portal"), headline: headline(p, lang, tz),
      docRef,
      generatedAt: `${t("أُنشئ في", "Generated")} ${fmtDateTime(new Date(), lang, tz)}`,
      footerNote: o.byShare
        ? t("ملخص من الملف السني ضمن نطاق رابط المشاركة. أداة لتنظيم المعلومات؛ لا تقدّم تشخيصاً ولا علاجاً.", "A summary of the dental file within the scope of the share link. A tool to organise information; it does not diagnose or treat.")
        : t("أداة لتنظيم المعلومات الصحية؛ لا تقدّم تشخيصاً ولا علاجاً. القرار السريري للطبيب المعالج.", "A tool to organise health information; it does not diagnose or treat. The clinical decision belongs to the treating clinician."),
    },
    blocks, filename: `${p.mrn}-dental-summary.pdf`,
  };
}
