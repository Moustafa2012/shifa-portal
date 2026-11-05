import Link from "next/link";
import {
  FileDown,
  Plus,
  Calendar,
  Sparkles,
  Trash2,
  History,
  ArrowLeftRight,
  Eye,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { Lang } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { fmtPartialDate } from "@/lib/format";
import { comparePerio, siteName, summarize, type PerioExam, type PerioTooth } from "@/lib/perio";
import { dxLine, factorsFrom } from "@/lib/perio-staging";
import { Card, Chip, Empty } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/ui/client";
import { PerioChart } from "./PerioChart";
import { PerioDxView } from "./PerioDxView";
import { createPerioPlan, invalidatePerio, savePerio } from "@/app/actions/perio";

/** The periodontal chart tab: the open draft (or a new chart), the final charts, one of them drawn, and the comparison of two. */
export async function PerioSection({
  pid,
  canWrite,
  lang,
  today,
  seedMissing,
  q,
}: {
  pid: string;
  canWrite: boolean;
  lang: Lang;
  today: string;
  seedMissing: number[];
  q: { pv?: string; pa?: string; pb?: string; pnew?: string };
}) {
  const ar = lang === "ar";
  const t = (a: string, e: string) => (ar ? a : e);
  const supabase = createClient();
  const [{ data: examRows }, { data: toothRows }, { data: encRows }, { data: pat }, { data: life }, { data: condRows }, { data: hbType }] = await Promise.all([
    supabase.from("perio_exams").select("*").eq("patient_id", pid).eq("record_status", "active").order("exam_date", { ascending: false }).order("recorded_at", { ascending: false }),
    supabase.from("perio_teeth").select("*").eq("patient_id", pid),
    supabase.from("encounters").select("id, started_at, reason, kind").eq("patient_id", pid).eq("record_status", "active").order("started_at", { ascending: false }).limit(60),
    supabase.from("patients").select("date_of_birth").eq("id", pid).maybeSingle(),
    supabase.from("patient_health_profile").select("tobacco_status, cigarettes_per_day").eq("patient_id", pid).maybeSingle(),
    supabase.from("conditions").select("name, icd10_code").eq("patient_id", pid).eq("record_status", "active").in("clinical_status", ["active", "recurrence"]).neq("certainty", "refuted"),
    supabase.from("observation_types").select("id").eq("code", "hba1c").maybeSingle(),
  ]);
  const { data: hbRow } = hbType
    ? await supabase.from("observations").select("value_num").eq("patient_id", pid).eq("type_id", hbType.id as string).in("status", ["final", "preliminary", "amended"])
        .not("value_num", "is", null).order("effective_at", { ascending: false }).limit(1)
    : { data: null };
  const factors = factorsFrom({
    dob: (pat?.date_of_birth as string | null) ?? null, on: today, tobaccoStatus: life?.tobacco_status as string | undefined,
    cigarettesPerDay: life?.cigarettes_per_day == null ? null : Number(life.cigarettes_per_day),
    diabetes: (condRows ?? []).some((c) => /^E1[0-4]/i.test(String(c.icd10_code ?? "")) || /diabet|سكر/i.test(String(c.name ?? ""))),
    hba1c: hbRow?.[0]?.value_num == null ? null : Number(hbRow[0].value_num),
  });
  const visits = (encRows ?? []).map((e) => ({ id: e.id as string, label: `${fmtPartialDate(String(e.started_at).slice(0, 10), "day", lang)} — ${(e.reason as string | null) ?? (e.kind as string)}` }));
  const visitLabel = (id: string | null | undefined) => visits.find((v) => v.id === id)?.label ?? null;
  const teeth = (toothRows ?? []) as (PerioTooth & { exam_id: string })[];
  // a doctor's open draft is theirs: the account sees the doctor's charts once they are final
  const exams: PerioExam[] = (examRows ?? []).filter((e) => !(e.status === "draft" && e.contributed_by))
    .map((e) => ({ ...e, teeth: teeth.filter((x) => x.exam_id === e.id) })) as PerioExam[];
  const draft = exams.find((e) => e.status === "draft");
  const finals = exams.filter((e) => e.status === "final");
  const day = (v: string) => fmtPartialDate(v, "day", lang);
  const base = `/patients/${pid}/dental?tab=perio`;
  // a chosen final chart (the "View" link) is shown first, even while a draft is open; readers without write access fall back to the latest final chart
  const chosen = finals.find((e) => e.id === q.pv);
  const editing = canWrite && !chosen && Boolean(draft || q.pnew);
  const shown = chosen ?? (!editing ? finals[0] : undefined);
  // a new chart starts from the teeth known to be missing (last final chart, else the dental chart)
  const seed = finals[0] ? finals[0].teeth.filter((x) => x.missing).map((x) => x.tooth) : seedMissing;
  const ea = finals.find((e) => e.id === q.pa), eb = finals.find((e) => e.id === q.pb);
  const [older, newer] = ea && eb ? (ea.exam_date <= eb.exam_date ? [ea, eb] : [eb, ea]) : [undefined, undefined];
  const cmp = older && newer && older.id !== newer.id ? comparePerio(older.teeth, newer.teeth) : null;

  return (<>
    <Card
      id="perio"
      title={
        <span className="flex items-center gap-2">
          <span>{t("مخطط اللثة", "Periodontal chart")}</span>
        </span>
      }
      description={t(
        "ست نقاط لكل سن: عمق الجيب وموضع حافة اللثة والنزف والبلاك والقيح، مع الحركة وانقسام الجذور. يُحسب مستوى الارتباط تلقائياً. يبقى المخطط مسودة حتى يُعتمد، وبعد الاعتماد لا يُعدَّل.",
        "Six sites per tooth: pocket depth, gingival margin, bleeding, plaque and pus, with mobility and furcations. The attachment level is computed. A chart stays a draft until it is finalised; a final chart is not edited."
      )}
      actions={
        canWrite && !editing ? (
          <Link className="btn primary sm inline-flex items-center gap-1.5" href={`${base}&pnew=1#perio`}>
            <Plus size={16} aria-hidden="true" />
            <span>{t("مخطط لثة جديد", "New periodontal chart")}</span>
          </Link>
        ) : undefined
      }
      dir={ar ? "rtl" : "ltr"}
    >
      {editing ? (<>
        {draft && (
          <div className="row between perio-draft-bar p-3 rounded-lg border border-amber-500/35 bg-amber-500/10 mb-4 items-center flex-wrap gap-2">
            <span className="inline-flex items-center gap-2">
              <Chip tone="warn" className="font-semibold">{t("مسودة", "Draft")}</Chip>
              <span className="text-xs text-muted-foreground">
                {t(`بدأت في ${day(draft.exam_date)} — تُستكمل من حيث توقفت.`, `Started ${day(draft.exam_date)} — continue where you left off.`)}
              </span>
            </span>
            <ActionForm action={invalidatePerio} className="inline">
              <input type="hidden" name="_pid" value={pid} />
              <input type="hidden" name="_id" value={draft.id} />
              <input type="hidden" name="_discard" value="1" />
              <ConfirmButton
                className="btn ghost sm inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:bg-rose-500/15"
                message={t("إلغاء هذه المسودة؟ تبقى في السجل كمسودة ملغاة.", "Discard this draft? It stays in the log as a discarded draft.")}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{t("إلغاء المسودة", "Discard draft")}</span>
              </ConfirmButton>
            </ActionForm>
          </div>
        )}
        <PerioChart
          key="perio-editor"
          lang={lang}
          teeth={draft?.teeth ?? []}
          edit={{
            action: savePerio,
            hidden: { _pid: pid },
            examId: draft?.id ?? null,
            today,
            seedMissing: seed,
            header: {
              exam_date: draft?.exam_date ?? today,
              examiner_name: draft?.examiner_name ?? "",
              facility_name: draft?.facility_name ?? "",
              notes: draft?.notes ?? "",
            },
            dx: { factors, initial: draft ?? {}, visits, visitId: draft?.encounter_id ?? "" },
          }}
        />
      </>) : shown ? (<>
        <div className="row between perio-shown-bar p-3 rounded-lg border border-border/50 bg-card/60 mb-3 items-center flex-wrap gap-2">
          <span className="inline-flex items-center gap-2">
            <Chip tone="ok" className="font-semibold">{t("معتمد", "Final")}</Chip>
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <Calendar size={14} className="text-muted-foreground" aria-hidden="true" />
              <strong>{day(shown.exam_date)}</strong>
            </span>
            {shown.examiner_name && <span className="text-xs text-muted-foreground"> — {shown.examiner_name}</span>}
          </span>
          <span className="row gap-sm flex items-center gap-2">
            {canWrite && (
              <ActionForm action={createPerioPlan} className="inline">
                <input type="hidden" name="_pid" value={pid} />
                <input type="hidden" name="_id" value={shown.id} />
                <SubmitButton className="btn sm inline-flex items-center gap-1.5" pending={t("جارٍ الإنشاء…", "Creating…")}>
                  <Sparkles size={14} className="text-amber-500" aria-hidden="true" />
                  <span>{t("خطة لثوية بمراحل", "Phased gum treatment plan")}</span>
                </SubmitButton>
              </ActionForm>
            )}
            <a className="btn sm inline-flex items-center gap-1.5" href={`/api/patients/${pid}/perio/${shown.id}/pdf`} target="_blank" rel="noopener">
              <FileDown size={15} aria-hidden="true" />
              <span>PDF</span>
            </a>
          </span>
        </div>
        <PerioDxView exam={shown} lang={lang} visit={visitLabel(shown.encounter_id)} />
        {shown.notes && (
          <div className="p-3 my-2 text-xs rounded border border-border/40 bg-muted/30 text-muted-foreground">
            <p className="m-0 leading-relaxed">{shown.notes}</p>
          </div>
        )}
        <PerioChart lang={lang} teeth={shown.teeth} />
      </>) : (
        <Empty title={t("لا يوجد مخطط لثة بعد", "No periodontal chart yet")}>
          {t("يسجّل طبيب الأسنان أو أخصائي اللثة القياسات في الفحص؛ أدخلها هنا من تقريره.", "The dentist or periodontist measures these at the exam; enter them here from their report.")}
        </Empty>
      )}
    </Card>

    {finals.length > 0 && (
      <Card
        id="perio-history"
        title={
          <span className="flex items-center gap-2">
            <History size={17} className="text-primary" aria-hidden="true" />
            <span>{t("المخططات المعتمدة", "Final charts")}</span>
            <Badge variant="secondary" className="font-mono text-xs">{finals.length}</Badge>
          </span>
        }
        dir={ar ? "rtl" : "ltr"}
      >
        <ul className="list perio-list">
          {finals.map((e) => {
            const sm = summarize(e.teeth);
            const bopAlert = (sm.bopPct ?? 0) >= 10;
            return (
              <li key={e.id} className="perio-item rounded-lg border border-border/50 bg-card/60 p-3.5 space-y-2">
                <div className="row between flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                        <Calendar size={14} className="text-muted-foreground" aria-hidden="true" />
                        <span>{day(e.exam_date)}</span>
                      </span>
                      {e.examiner_name && <span className="text-xs text-muted-foreground">— {e.examiner_name}</span>}
                      {e.contributed_by && (
                        <Chip tone="info" className="text-xs">
                          {t(`سجّله ${e.examiner_name ?? ""} عبر رابط`, `Recorded by ${e.examiner_name ?? "a doctor"} via a link`)}
                        </Chip>
                      )}
                    </div>
                    {dxLine(e, lang) && (
                      <div className="text-xs font-semibold text-foreground bg-surface-2/60 px-2.5 py-1 rounded border border-border/40 inline-block">
                        {dxLine(e, lang)}
                      </div>
                    )}
                    <div className="row gap-sm wrap flex items-center gap-1.5 pt-0.5">
                      <Chip tone={bopAlert ? "warn" : "ok"} className="text-xs font-mono">
                        {t("نزف", "BOP")} {sm.bopPct ?? "—"}%
                      </Chip>
                      <Chip tone={sm.pd4 ? "warn" : "ok"} className="text-xs font-mono">
                        {t("جيوب ≥4", "PD ≥4")}: {sm.pd4}
                      </Chip>
                      <Chip tone={sm.pd6 ? "bad" : "ok"} className="text-xs font-mono">
                        {t("جيوب ≥6", "PD ≥6")}: {sm.pd6}
                      </Chip>
                      <Chip tone="muted" className="text-xs font-mono">
                        {t("أقصى CAL", "Max CAL")}: {sm.maxCal ?? "—"}
                      </Chip>
                    </div>
                  </div>
                  <div className="row gap-sm flex items-center gap-1.5">
                    <Link
                      className="btn ghost sm inline-flex items-center gap-1"
                      href={`${base}&pv=${e.id}#perio`}
                      aria-current={shown?.id === e.id ? "true" : undefined}
                    >
                      <Eye size={14} aria-hidden="true" />
                      <span>{t("عرض", "View")}</span>
                    </Link>
                    <a className="btn ghost sm inline-flex items-center gap-1" href={`/api/patients/${pid}/perio/${e.id}/pdf`} target="_blank" rel="noopener">
                      <FileDown size={14} aria-hidden="true" />
                      <span>PDF</span>
                    </a>
                  </div>
                </div>
                {canWrite && (
                  <details className="perio-invalidate pt-1">
                    <summary className="text-xs text-muted-foreground hover:text-foreground cursor-pointer inline-flex items-center gap-1">
                      <AlertTriangle size={12} className="text-amber-500" aria-hidden="true" />
                      <span>{t("إبطال (أُدخل خطأً)", "Invalidate (entered in error)")}</span>
                    </summary>
                    <div className="mt-2.5 p-3 rounded border border-rose-500/30 bg-rose-500/5 space-y-2">
                      <ActionForm action={invalidatePerio}>
                        <input type="hidden" name="_pid" value={pid} />
                        <input type="hidden" name="_id" value={e.id} />
                        <div className="field">
                          <label htmlFor={`pr-${e.id}`} className="text-xs font-medium text-foreground">
                            {t("سبب الإبطال", "Reason for invalidation")}
                          </label>
                          <input
                            id={`pr-${e.id}`}
                            name="reason"
                            required
                            minLength={3}
                            maxLength={500}
                            className="text-xs"
                            placeholder={t("أدخل سبب إبطال هذا الفحص...", "Enter reason for invalidation...")}
                          />
                        </div>
                        <SubmitButton className="btn danger sm inline-flex items-center gap-1">
                          <AlertTriangle size={13} aria-hidden="true" />
                          <span>{t("إبطال المخطط نهائياً", "Invalidate the chart")}</span>
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    )}

    {finals.length > 1 && (
      <Card
        id="perio-compare"
        title={
          <span className="flex items-center gap-2">
            <ArrowLeftRight size={17} className="text-primary" aria-hidden="true" />
            <span>{t("مقارنة مخططين", "Compare two charts")}</span>
          </span>
        }
        dir={ar ? "rtl" : "ltr"}
      >
        <form method="get" action={`/patients/${pid}/dental#perio-compare`} className="row gap wrap perio-compare-form items-end gap-3 mb-4">
          <input type="hidden" name="tab" value="perio" />
          <div className="field flex-1 min-w-[200px]">
            <label htmlFor="pa" className="text-xs font-medium text-foreground">{t("الفحص الأقدم", "Earlier exam")}</label>
            <select id="pa" name="pa" defaultValue={older?.id ?? finals[1].id}>
              {finals.map((e) => (
                <option key={e.id} value={e.id}>
                  {day(e.exam_date)}{e.examiner_name ? ` — ${e.examiner_name}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field flex-1 min-w-[200px]">
            <label htmlFor="pb" className="text-xs font-medium text-foreground">{t("الفحص الأحدث", "Later exam")}</label>
            <select id="pb" name="pb" defaultValue={newer?.id ?? finals[0].id}>
              {finals.map((e) => (
                <option key={e.id} value={e.id}>
                  {day(e.exam_date)}{e.examiner_name ? ` — ${e.examiner_name}` : ""}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn primary inline-flex items-center gap-1.5 h-[38px]">
            <ArrowLeftRight size={15} aria-hidden="true" />
            <span>{t("قارن", "Compare")}</span>
          </button>
        </form>

        {cmp && older && newer && (<>
          <div className="table-wrap rounded-lg border border-border/50 overflow-hidden mb-3">
            <table className="t perio-cmp-sum w-full text-sm">
              <thead className="bg-muted/50 border-b border-border/50">
                <tr>
                  <th className="text-start p-2.5 font-semibold">{t("المؤشر", "Measure")}</th>
                  <th className="text-start p-2.5 font-semibold font-mono">{day(older.exam_date)}</th>
                  <th className="text-start p-2.5 font-semibold font-mono">{day(newer.exam_date)}</th>
                  <th className="text-start p-2.5 font-semibold">{t("التغيّر", "Change")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {([
                  [t("النزف عند السبر", "Bleeding on probing"), cmp.before.bopPct, cmp.after.bopPct, "%", "lower-is-better"],
                  [t("البلاك", "Plaque"), cmp.before.plaquePct, cmp.after.plaquePct, "%", "lower-is-better"],
                  [t("جيوب ≥ 4 مم", "Pockets ≥ 4 mm"), cmp.before.pd4, cmp.after.pd4, "", "lower-is-better"],
                  [t("جيوب ≥ 6 مم", "Pockets ≥ 6 mm"), cmp.before.pd6, cmp.after.pd6, "", "lower-is-better"],
                  [t("متوسط الارتباط (CAL)", "Mean CAL"), cmp.before.meanCal, cmp.after.meanCal, " " + t("مم", "mm"), "lower-is-better"],
                  [t("الأسنان المفقودة", "Missing teeth"), cmp.before.missing, cmp.after.missing, "", "neutral"],
                ] as [string, number | null, number | null, string, string][]).map(([k, a, b, u, direction]) => {
                  const diff = a != null && b != null ? Number((b - a).toFixed(1)) : null;
                  let diffBadge: React.ReactNode = null;
                  if (diff !== null && diff !== 0) {
                    if (direction === "lower-is-better") {
                      const improved = diff < 0;
                      diffBadge = (
                        <Badge variant={improved ? "ok" : "bad"} className="text-xs font-mono inline-flex items-center gap-1">
                          {improved ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                          <bdi>{diff > 0 ? `+${diff}` : `${diff}`}{u}</bdi>
                        </Badge>
                      );
                    } else {
                      diffBadge = (
                        <Badge variant="secondary" className="text-xs font-mono">
                          <bdi>{diff > 0 ? `+${diff}` : `${diff}`}{u}</bdi>
                        </Badge>
                      );
                    }
                  } else if (diff === 0) {
                    diffBadge = <span className="text-xs text-muted-foreground">—</span>;
                  }
                  return (
                    <tr key={k} className="hover:bg-muted/20">
                      <th scope="row" className="p-2.5 font-medium text-foreground text-start">{k}</th>
                      <td className="p-2.5 font-mono text-muted-foreground">{a ?? "—"}{a !== null ? u : ""}</td>
                      <td className="p-2.5 font-mono font-medium text-foreground">{b ?? "—"}{b !== null ? u : ""}</td>
                      <td className="p-2.5">{diffBadge}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            {t(
              "يُحسب التغيّر في المواقع المسبورة في المخططين فقط؛ أقل من 2 مم يقع ضمن خطأ القياس.",
              "Only sites probed in both charts are compared; less than 2 mm is within probing error."
            )}
          </p>

          {cmp.lostTeeth.length > 0 && (
            <div className="p-3 rounded-lg border border-rose-500/35 bg-rose-500/10 mb-4 flex items-center gap-2 text-sm text-rose-700 dark:text-rose-300">
              <AlertTriangle size={16} className="shrink-0" />
              <span>
                <Chip tone="bad">{t("أسنان فُقدت", "Teeth lost")}</Chip>{" "}
                <strong className="font-mono">{cmp.lostTeeth.join(lang === "ar" ? "، " : ", ")}</strong>
              </span>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-semibold flex items-center gap-2 mb-2">
                <span className="text-rose-600 dark:text-rose-400">●</span>
                <span>{t(`مواقع تراجع فيها الارتباط (${cmp.worse.length})`, `Sites that lost attachment (${cmp.worse.length})`)}</span>
              </h4>
              {cmp.worse.length ? (
                <div className="table-wrap rounded-lg border border-border/50 overflow-hidden">
                  <table className="t perio-cmp-worse w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border/50">
                      <tr>
                        <th className="p-2 text-start">{t("السن", "Tooth")}</th>
                        <th className="p-2 text-start">{t("الموقع", "Site")}</th>
                        <th className="p-2 text-start">{t("العمق", "Depth")}</th>
                        <th className="p-2 text-start">{t("الارتباط (CAL)", "CAL")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {cmp.worse.map((w) => (
                        <tr key={`${w.tooth}-${w.site}`} className="hover:bg-muted/20">
                          <td className="p-2 font-mono font-bold text-foreground">{w.tooth}</td>
                          <td className="p-2 text-xs text-muted-foreground">{siteName(w.site, w.tooth, lang)}</td>
                          <td className="p-2 font-mono text-xs">{w.pdBefore} → {w.pdAfter}</td>
                          <td className="p-2">
                            <Chip tone="bad" className="font-mono text-xs">
                              {w.calBefore} → {w.calAfter} (+{w.dCal})
                            </Chip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("لا يوجد تراجع مسجل.", "None.")}</p>
              )}
            </div>

            <div>
              <h4 className="text-sm font-semibold flex items-center gap-2 mb-2">
                <span className="text-emerald-600 dark:text-emerald-400">●</span>
                <span>{t(`مواقع تحسّن عمقها الجيبي (${cmp.better.length})`, `Sites that got shallower (${cmp.better.length})`)}</span>
              </h4>
              {cmp.better.length ? (
                <div className="table-wrap rounded-lg border border-border/50 overflow-hidden">
                  <table className="t perio-cmp-better w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border/50">
                      <tr>
                        <th className="p-2 text-start">{t("السن", "Tooth")}</th>
                        <th className="p-2 text-start">{t("الموقع", "Site")}</th>
                        <th className="p-2 text-start">{t("العمق الجيبي", "Depth")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {cmp.better.map((w) => (
                        <tr key={`${w.tooth}-${w.site}`} className="hover:bg-muted/20">
                          <td className="p-2 font-mono font-bold text-foreground">{w.tooth}</td>
                          <td className="p-2 text-xs text-muted-foreground">{siteName(w.site, w.tooth, lang)}</td>
                          <td className="p-2">
                            <Chip tone="ok" className="font-mono text-xs">
                              {w.pdBefore} → {w.pdAfter}
                            </Chip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("لا توجد مواقع تحسنت.", "None.")}</p>
              )}
            </div>
          </div>
        </>)}
      </Card>
    )}
  </>);
}
