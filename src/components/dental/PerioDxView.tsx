import type { Lang } from "@/lib/i18n";
import { dxIsSet, dxLine, DX_EXTENTS, type DxLike } from "@/lib/perio-staging";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui";
import { Activity, Calendar, FileText, Share2 } from "lucide-react";

/** The periodontal diagnosis a clinician saved with a chart, and who recorded the chart when it came through a link. */
export function PerioDxView({
  exam,
  lang,
  visit,
}: {
  exam: DxLike & { contributed_by?: string | null; examiner_name?: string | null };
  lang: Lang;
  /** the linked visit, when it can be named */
  visit?: string | null;
}) {
  const ar = lang === "ar";
  const t = (a: string, e: string) => (ar ? a : e);

  const by = exam.contributed_by ? (
    <Chip tone="info" className="inline-flex items-center gap-1.5">
      <Share2 size={13} aria-hidden="true" />
      <span>{ar ? `سجّله ${exam.examiner_name ?? ""} عبر رابط` : `Recorded by ${exam.examiner_name ?? "a doctor"} via a link`}</span>
    </Chip>
  ) : null;

  if (!dxIsSet(exam) && !by && !visit) return null;

  const stageVariant = exam.dx_stage === "III" || exam.dx_stage === "IV" ? "bad" : "warn";
  const gradeVariant = exam.dx_grade === "C" ? "bad" : exam.dx_grade === "B" ? "warn" : "ok";
  const extentLabel = DX_EXTENTS.find((x) => x.value === exam.dx_extent)?.[lang];

  return (
    <div
      className="perio-dx-view rounded-lg border border-border/50 bg-card/60 p-3.5 my-2.5 space-y-2 text-sm"
      data-testid="perio-dx-view"
      dir={ar ? "rtl" : "ltr"}
    >
      {by && <div className="flex items-center gap-2">{by}</div>}

      {dxIsSet(exam) && (
        <div className="perio-dx-line flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-foreground font-semibold">
            <Activity size={16} className="text-primary shrink-0" aria-hidden="true" />
            <span>{t("التشخيص اللثوي", "Periodontal diagnosis")}:</span>
          </div>

          <span className="font-medium text-foreground">{dxLine(exam, lang) || "—"}</span>

          {exam.dx_stage && (
            <Badge variant={stageVariant} className="text-xs">
              {t("المرحلة", "Stage")} {exam.dx_stage}
            </Badge>
          )}

          {exam.dx_grade && (
            <Badge variant={gradeVariant} className="text-xs">
              {t("الدرجة", "Grade")} {exam.dx_grade}
            </Badge>
          )}

          {extentLabel && (
            <Badge variant="outline" className="text-xs">
              {extentLabel}
            </Badge>
          )}

          {exam.dx_rbl_pct != null && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>·</span>
              <span>{t("فقد العظم", "bone loss")}</span>
              <span className="font-mono text-foreground font-medium ltr"><bdi>{exam.dx_rbl_pct}%</bdi></span>
            </span>
          )}

          {exam.dx_teeth_lost_perio != null && exam.dx_teeth_lost_perio > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>·</span>
              <Badge variant="bad" className="text-xs">
                {t("أسنان فُقدت لثوياً", "teeth lost")}: {exam.dx_teeth_lost_perio}
              </Badge>
            </span>
          )}
        </div>
      )}

      {exam.dx_note && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/40">
          <FileText size={14} className="shrink-0 mt-0.5 text-muted-foreground" aria-hidden="true" />
          <p className="m-0 leading-relaxed">{exam.dx_note}</p>
        </div>
      )}

      {visit && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Calendar size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{t("مرتبط بالزيارة", "Linked to the visit")}:</span>
          <span className="font-medium text-foreground">{visit}</span>
        </div>
      )}
    </div>
  );
}
