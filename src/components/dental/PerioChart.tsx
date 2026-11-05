"use client";
import { DirectionProvider } from "@/components/ui/direction";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useFormState } from "react-dom";
import type { Lang } from "@/lib/i18n";
import {
  GM_MAX, GM_MIN, PD_MAX, PERIO_ARCHES, calAt, depthTone, emptyTooth, furcationsOf, readSite, sideOrder, siteComplete, siteName, summarize,
  type Furcation, type PerioTooth, type Site,
} from "@/lib/perio";
import { toothName } from "@/lib/dental";
import type { FormAction, FormState } from "@/components/ui/client";
import type { DxLike, PerioFactors } from "@/lib/perio-staging";
import { PerioDxFields, type VisitOption } from "./PerioDx";
import { SubmitButton } from "@/components/ui/client";
import { isLocalPath } from "@/lib/safe-path";
import { Badge } from "@/components/ui/badge";
import { Save, CheckCircle2 } from "lucide-react";

/** what is typed, per tooth: numbers stay text while being typed ("-", "1" of "12") */
interface Edit {
  missing: boolean; implant: boolean; mobility: string;
  furc: Record<Furcation, string>;
  pd: string[]; gm: string[]; bop: boolean[]; plaque: boolean[]; supp: boolean[];
}
type Side = "buccal" | "lingual";
const blank6 = () => ["", "", "", "", "", ""];
const false6 = () => [false, false, false, false, false, false];
const txt = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function toEdit(t: PerioTooth | undefined, missing = false): Edit {
  return {
    missing: t ? t.missing : missing, implant: t?.implant ?? false, mobility: txt(t?.mobility),
    furc: { b: txt(t?.furcation_b), l: txt(t?.furcation_l), m: txt(t?.furcation_m), d: txt(t?.furcation_d) },
    pd: t?.pd ? t.pd.map(txt) : blank6(), gm: t?.gm ? t.gm.map(txt) : blank6(),
    bop: t?.bop ? t.bop.map(Boolean) : false6(), plaque: t?.plaque ? t.plaque.map(Boolean) : false6(), supp: t?.suppuration ? t.suppuration.map(Boolean) : false6(),
  };
}
const num = (s: string, lo: number, hi: number) => { const v = readSite(s, lo, hi); return v === "bad" ? null : v; };
const any6 = <T,>(a: T[], f: (v: T) => boolean) => a.some(f);
function toTooth(tooth: number, e: Edit): PerioTooth {
  const t = emptyTooth(tooth);
  t.missing = e.missing;
  if (e.missing) return t;
  t.implant = e.implant;
  t.mobility = num(e.mobility, 0, 3);
  for (const f of furcationsOf(tooth)) t[`furcation_${f}`] = num(e.furc[f], 0, 3);
  t.pd = any6(e.pd, (v) => v.trim() !== "") ? e.pd.map((v) => num(v, 0, PD_MAX)) : null;
  t.gm = any6(e.gm, (v) => v.trim() !== "") ? e.gm.map((v) => num(v, GM_MIN, GM_MAX)) : null;
  t.bop = any6(e.bop, Boolean) ? [...e.bop] : null;
  t.plaque = any6(e.plaque, Boolean) ? [...e.plaque] : null;
  t.suppuration = any6(e.supp, Boolean) ? [...e.supp] : null;
  return t;
}

// ---------------------------------------------------------------- the drawing of one side of one tooth
const MM = 3.2, CEJ = 8, H = 62;
/** gingival margin and attachment level of three sites; apical is down (the upper arch is flipped by its caller) */
export function PerioSvg({ tooth, side, t, flip, label }: { tooth: number; side: Side; t: PerioTooth | undefined; flip: boolean; label: string }) {
  const order = sideOrder(tooth, side);
  const xs = [10, 30, 50];
  const y = (mm: number) => CEJ + mm * MM;
  const pts = order.map((s, k) => {
    const pd = t?.pd?.[s], gm = t?.gm?.[s] ?? 0;
    return { x: xs[k], gm: y(-(gm)), base: pd === null || pd === undefined ? null : y(-(gm) + pd), tone: depthTone(pd), bop: !!t?.bop?.[s] };
  });
  const line = (k: "gm" | "base") => pts.filter((p) => p[k] !== null).map((p) => `${p.x},${p[k]}`).join(" ");
  return (
    <svg viewBox={`0 0 60 ${H}`} className="perio-svg" role="img" aria-label={label} preserveAspectRatio="none">
      <g transform={flip ? `translate(0 ${H}) scale(1 -1)` : undefined}>
        {t?.missing ? (
          <path d={`M8 ${CEJ} L52 ${H - 6} M52 ${CEJ} L8 ${H - 6}`} className="perio-missing" />
        ) : (<>
          <path d={`M14 ${CEJ} L18 ${H - 4} Q30 ${H + 2} 42 ${H - 4} L46 ${CEJ} Z`} className={t?.implant ? "perio-root implant" : "perio-root"} />
          <line x1="0" x2="60" y1={CEJ} y2={CEJ} className="perio-cej" />
          {pts.map((p, i) => p.base !== null && <line key={i} x1={p.x} x2={p.x} y1={p.gm} y2={p.base} className={`perio-pocket ${p.tone ?? ""}`} />)}
          {line("gm") && <polyline points={line("gm")} className="perio-gm" />}
          {line("base") && <polyline points={line("base")} className="perio-cal" />}
          {pts.map((p, i) => p.bop && p.base !== null && <circle key={`b${i}`} cx={p.x} cy={p.base} r="2.8" className="perio-bop-dot" />)}
        </>)}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- the chart
export interface PerioChartProps {
  lang: Lang;
  teeth: PerioTooth[];
  /** editing a draft: the save action and the exam's header; omit to show a chart read-only */
  edit?: {
    action: FormAction; hidden: Record<string, string>; examId: string | null; today: string; seedMissing: number[];
    header: { exam_date: string; examiner_name: string; facility_name: string; notes: string };
    /** the periodontal diagnosis and the visit link; omit to leave them out of the form */
    dx?: { factors: PerioFactors; initial: DxLike; visits: VisitOption[]; visitId: string };
    /** the examiner is the signed-in clinician (a share link): the field is shown but not typed */
    examinerLocked?: boolean;
  };
}

export function PerioChart({ lang, teeth, edit }: PerioChartProps) {
  const ar = lang === "ar";
  const t = (a: string, e: string) => (ar ? a : e);
  const readOnly = !edit;
  // `edit` is a new object on every render: the typed values are reset only when the saved chart itself changes
  // (another draft, or different saved teeth), never by a revalidation that brings back what was already saved
  const teethRef = useRef(teeth);
  teethRef.current = teeth;
  const seedRef = useRef(edit?.seedMissing ?? []);
  seedRef.current = edit?.seedMissing ?? [];
  const savedSig = useMemo(() => JSON.stringify(teeth), [teeth]);
  const propExamId = edit?.examId ?? "";
  const seedSig = edit && !edit.examId ? edit.seedMissing.join(",") : "";
  const initial = useMemo(() => {
    const by = new Map(teethRef.current.map((x) => [x.tooth, x]));
    const seed = new Set(seedSig ? seedRef.current : []);
    const out: Record<number, Edit> = {};
    for (const n of [...PERIO_ARCHES.upper, ...PERIO_ARCHES.lower]) out[n] = toEdit(by.get(n), seed.has(n));
    return out;
  }, [savedSig, propExamId, seedSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState(initial);
  const [auto, setAuto] = useState(true);
  // the redirect after finalising happens as soon as the action answers: the revalidation that comes with the answer
  // unmounts this editor (the draft is gone), before any effect would run
  const [form, formAction] = useFormState<FormState, FormData>(async (prev: FormState, fd: FormData) => {
    const r = edit ? await edit.action(prev, fd) : undefined;
    const to = r?.redirectTo;
    if (isLocalPath(to)) window.location.assign(to);
    return r;
  }, undefined);
  const finalizeRef = useRef<HTMLInputElement>(null);
  const [examId, setExamId] = useState(propExamId);
  // the draft behind the editor can change under it (discarded, or started in another tab): follow the saved one
  useEffect(() => { setExamId(propExamId); }, [propExamId]);
  useEffect(() => {
    if (finalizeRef.current) finalizeRef.current.value = "0";   // a refused "finalise" must not turn the next draft save into one
    if (form?.ok && form.data?.id) setExamId(form.data.id);
  }, [form]);
  useEffect(() => { setState(initial); }, [initial]);

  const model = useMemo(() => {
    const out = new Map<number, PerioTooth>();
    for (const [k, v] of Object.entries(state)) out.set(Number(k), toTooth(Number(k), v));
    return out;
  }, [state]);
  const modelTeeth = useMemo(() => [...model.values()], [model]);
  const summary = useMemo(() => summarize(modelTeeth), [modelTeeth]);
  // teeth with something on them, and teeth already in the saved draft even when emptied now (so that clearing a tooth is saved)
  const savedTeeth = useMemo(() => new Set((JSON.parse(savedSig) as { tooth: number }[]).map((x) => x.tooth)), [savedSig]);
  const payload = useMemo(() => JSON.stringify(modelTeeth.filter((x) => savedTeeth.has(x.tooth) || x.missing || x.implant || x.pd || x.gm || x.bop || x.plaque
    || x.suppuration || x.mobility !== null || [x.furcation_b, x.furcation_l, x.furcation_m, x.furcation_d].some((f) => f !== null))), [modelTeeth, savedTeeth]);

  const set = (tooth: number, f: (e: Edit) => Edit) => setState((s) => ({ ...s, [tooth]: f(s[tooth]) }));
  const focusNext = (row: string, i: number) => {
    for (let k = i + 1; k < 48; k++) {
      const el = document.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-i="${k}"]`);
      if (el && !el.disabled) { el.focus(); el.select(); return; }
    }
  };
  const onSite = (row: string, i: number, tooth: number, kind: "pd" | "gm", site: Site, v: string) => {
    if (!/^[-+]?\d{0,2}$/.test(v)) return;
    set(tooth, (e) => { const a = [...e[kind]]; a[site] = v; return { ...e, [kind]: a }; });
    // a depth may continue 1 → 10–20, and a negative margin −1 → −10…−15
    if (auto && siteComplete(v, kind === "pd" || v.startsWith("-"))) focusNext(row, i);
  };
  const onKey = (row: string, i: number) => (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focusNext(row, i); }
  };

  const arch = (which: "upper" | "lower") => {
    const list = PERIO_ARCHES[which];
    const upper = which === "upper";
    const sides: Side[] = upper ? ["buccal", "lingual"] : ["lingual", "buccal"];
    const sideLabel = (s: Side) => (s === "buccal" ? t("الدهليزي", "Buccal") : upper ? t("الحنكي", "Palatal") : t("اللساني", "Lingual"));
    const cellsPerTooth = (render: (tooth: number, e: Edit, m: PerioTooth | undefined) => React.ReactNode, cls = "") =>
      list.map((n) => <td key={n} colSpan={3} className={`pc-tooth ${cls}${state[n].missing ? " is-missing" : ""}`}>{render(n, state[n], model.get(n))}</td>);
    const siteRow = (side: Side, kind: "pd" | "gm" | "cal" | "bop" | "plaque" | "supp", label: string) => {
      const row = `${which}-${side}-${kind}`;
      // a final chart shows only the rows that hold something
      if (readOnly && kind !== "pd" && kind !== "cal") {
        const has = list.some((n) => sideOrder(n, side).some((s) => {
          const e = state[n];
          return kind === "gm" ? e.gm[s].trim() !== "" && e.gm[s] !== "0" : e[kind][s];
        }));
        if (!has) return null;
      }
      return (
        <tr key={row} className={`pc-row pc-${kind}`}>
          <th scope="row">{label}</th>
          {list.map((n, ti) => sideOrder(n, side).map((s, k) => {
            const e = state[n], m = model.get(n), i = ti * 3 + k, name = `${n} ${siteName(s, n, lang)}`;
            if (e.missing) return <td key={`${n}-${k}`} className="pc-site is-missing" />;
            if (kind === "cal") {
              const c = calAt(m?.pd?.[s], m?.gm?.[s]);
              return <td key={`${n}-${k}`} className={`pc-site pc-calv ${depthTone(c) ?? ""}`} aria-label={c === null ? undefined : `${name}: ${t("مستوى الارتباط", "attachment level")} ${c}`}>{c ?? ""}</td>;
            }
            if (kind === "bop" || kind === "plaque" || kind === "supp") {
              const on = e[kind][s];
              const what = kind === "bop" ? t("نزف", "bleeding") : kind === "plaque" ? t("بلاك", "plaque") : t("قيح", "suppuration");
              return (
                <td key={`${n}-${k}`} className="pc-site">
                  {readOnly ? (on ? <span className={`pc-dot ${kind} on`} role="img" aria-label={`${name}: ${what}`} /> : null) : (
                    <button type="button" className={`pc-dot ${kind}${on ? " on" : ""}`} aria-pressed={on} aria-label={`${name}: ${what}`}
                      onClick={() => set(n, (x) => { const a = [...x[kind]]; a[s] = !a[s]; return { ...x, [kind]: a }; })} />
                  )}
                </td>
              );
            }
            const v = e[kind][s];
            const bad = readSite(v, kind === "pd" ? 0 : GM_MIN, kind === "pd" ? PD_MAX : GM_MAX) === "bad";
            const tone = kind === "pd" ? depthTone(m?.pd?.[s]) : null;
            return (
              <td key={`${n}-${k}`} className={`pc-site ${tone ?? ""}`} aria-label={readOnly && v.trim() !== "" ? `${name}: ${kind === "pd" ? t("عمق الجيب", "probing depth") : t("حافة اللثة", "gingival margin")} ${v}` : undefined}>
                {readOnly ? <span>{v}</span> : (
                  <input value={v} inputMode="text" pattern="[+\-]?[0-9]{0,2}" maxLength={3} autoComplete="off" data-row={row} data-i={i} aria-invalid={bad || undefined}
                    aria-label={`${name}: ${kind === "pd" ? t("عمق الجيب", "probing depth") : t("حافة اللثة", "gingival margin")}`}
                    onChange={(ev) => onSite(row, i, n, kind, s, ev.target.value)} onKeyDown={onKey(row, i)} onFocus={(ev) => ev.target.select()} />
                )}
              </td>
            );
          }))}
        </tr>
      );
    };
    const furcRow = (side: Side) => {
      const fs = (n: number): Furcation[] => furcationsOf(n).filter((f) => (side === "buccal" ? f === "b" : f !== "b"));
      if (!list.some((n) => fs(n).length)) return null;
      if (readOnly && !list.some((n) => fs(n).some((f) => state[n].furc[f] && state[n].furc[f] !== "0"))) return null;
      return (
        <tr key={`${which}-${side}-furc`} className="pc-row pc-furc">
          <th scope="row">{t("انقسام الجذور", "Furcation")}</th>
          {cellsPerTooth((n, e) => (e.missing ? null : fs(n).map((f) => {
            const lab = `${n} ${t("انقسام", "furcation")} ${f === "b" ? t("دهليزي", "buccal") : f === "l" ? t("لساني", "lingual") : f === "m" ? t("أنسي-حنكي", "mesiopalatal") : t("وحشي-حنكي", "distopalatal")}`;
            return readOnly ? (e.furc[f] && e.furc[f] !== "0" ? <span key={f} className="pc-furc-v" title={lab}>{f.toUpperCase()}{e.furc[f]}</span> : null) : (
              <select key={f} aria-label={lab} value={e.furc[f]} onChange={(ev) => set(n, (x) => ({ ...x, furc: { ...x.furc, [f]: ev.target.value } }))}>
                <option value="">{f.toUpperCase()}</option>{[0, 1, 2, 3].map((g) => <option key={g} value={g}>{f.toUpperCase()}{g}</option>)}
              </select>
            );
          })))}
        </tr>
      );
    };
    const svgRow = (side: Side) => (
      <tr key={`${which}-${side}-svg`} className="pc-row pc-graph">
        <th scope="row" className="pc-side-label">{sideLabel(side)}</th>
        {cellsPerTooth((n, _e, m) => <PerioSvg tooth={n} side={side} t={m} flip={upper} label={`${n} ${sideLabel(side)}`} />, "pc-graph-cell")}
      </tr>
    );
    const block = (side: Side, outerFirst: boolean) => {
      const rows = [
        furcRow(side),
        siteRow(side, "plaque", t("بلاك", "Plaque")),
        siteRow(side, "bop", t("نزف", "Bleeding")),
        siteRow(side, "supp", t("قيح", "Pus")),
        siteRow(side, "gm", t("حافة اللثة", "Margin")),
        siteRow(side, "pd", t("عمق الجيب", "Depth")),
        siteRow(side, "cal", t("الارتباط", "CAL")),
        svgRow(side),
      ];
      return outerFirst ? rows : rows.reverse();
    };
    const toothRow = (
      <tr key={`${which}-teeth`} className="pc-row pc-teeth">
        <th scope="row">{t("السن", "Tooth")}</th>
        {cellsPerTooth((n) => <strong title={toothName(n, lang)}>{n}</strong>)}
      </tr>
    );
    const flagRows = readOnly ? [
      list.some((n) => state[n].implant) && (
        <tr key={`${which}-implant`} className="pc-row pc-flags">
          <th scope="row">{t("زرعة", "Implant")}</th>
          {cellsPerTooth((n, e) => (e.implant ? "●" : null))}
        </tr>
      ),
      list.some((n) => state[n].mobility && state[n].mobility !== "0") && (
        <tr key={`${which}-mob`} className="pc-row pc-flags">
          <th scope="row">{t("الحركة", "Mobility")}</th>
          {cellsPerTooth((n, e) => (e.mobility && e.mobility !== "0" ? <span className="pc-mob">{e.mobility}</span> : null))}
        </tr>
      ),
    ] : [
      <tr key={`${which}-missing`} className="pc-row pc-flags">
        <th scope="row">{t("مفقود", "Missing")}</th>
        {cellsPerTooth((n, e) => (readOnly ? (e.missing ? "✕" : null) : (
          <input type="checkbox" checked={e.missing} aria-label={`${n}: ${t("مفقود", "missing")}`}
            onChange={(ev) => set(n, (x) => (ev.target.checked ? { ...toEdit(undefined, true) } : { ...x, missing: false }))} />)))}
      </tr>,
      <tr key={`${which}-implant`} className="pc-row pc-flags">
        <th scope="row">{t("زرعة", "Implant")}</th>
        {cellsPerTooth((n, e) => (e.missing ? null : readOnly ? (e.implant ? "●" : null) : (
          <input type="checkbox" checked={e.implant} aria-label={`${n}: ${t("زرعة", "implant")}`} onChange={(ev) => set(n, (x) => ({ ...x, implant: ev.target.checked }))} />)))}
      </tr>,
      <tr key={`${which}-mob`} className="pc-row pc-flags">
        <th scope="row">{t("الحركة", "Mobility")}</th>
        {cellsPerTooth((n, e) => (e.missing ? null : readOnly ? (e.mobility && e.mobility !== "0" ? <span className="pc-mob">{e.mobility}</span> : null) : (
          <select aria-label={`${n}: ${t("الحركة", "mobility")}`} value={e.mobility} onChange={(ev) => set(n, (x) => ({ ...x, mobility: ev.target.value }))}>
            <option value="">—</option>{[0, 1, 2, 3].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>)))}
      </tr>,
    ];
    return (
      <DirectionProvider direction="ltr" key={which}>
        <div className="w-full max-w-full min-w-0 space-y-1.5" dir="ltr">
          <div className="table-wrap perio-wrap w-full max-w-full min-w-0" dir="ltr">
            <div className="odonto-sides" dir="ltr" style={{ direction: "ltr" }} aria-hidden="true">
              <div className="odonto-sides-sticky" />
              <div className="odonto-sides-content">
                <span className="font-semibold text-xs text-foreground/85">
                  {upper ? t("يمين المريض (UR) · الربع 1", "Patient's right (UR) · Q1") : t("يمين المريض (LR) · الربع 4", "Patient's right (LR) · Q4")}
                </span>
                <span className="text-xs text-muted-foreground font-medium">
                  {upper ? t("الفك العلوي (MAXILLA) — دهليزي / حنكي", "Maxilla — Buccal / Palatal") : t("الفك السفلي (MANDIBLE) — لساني / دهليزي", "Mandible — Lingual / Buccal")}
                </span>
                <span className="font-semibold text-xs text-foreground/85">
                  {upper ? t("يسار المريض (UL) · الربع 2", "Patient's left (UL) · Q2") : t("يسار المريض (LL) · الربع 3", "Patient's left (LL) · Q3")}
                </span>
              </div>
            </div>
            <table className="perio-chart" dir="ltr" aria-label={upper ? t("الفك العلوي", "Upper arch") : t("الفك السفلي", "Lower arch")}>
              <colgroup><col className="pc-label-col" />{list.map((n) => <Fragment key={n}><col /><col /><col /></Fragment>)}</colgroup>
              <tbody>
                {upper ? (<>{toothRow}{flagRows}{block(sides[0], true)}{block(sides[1], false)}</>)
                  : (<>{block(sides[0], true)}{block(sides[1], false)}{[...flagRows].reverse()}{toothRow}</>)}
              </tbody>
            </table>
          </div>
        </div>
      </DirectionProvider>
    );
  };

  const bopAlert = (summary.bopPct ?? 0) >= 10;
  const stats = (
    <div className="perio-stats w-full max-w-full min-w-0" aria-live="polite" dir={ar ? "rtl" : "ltr"}>
      <div className="perio-stat">
        <span className="k">{t("المواقع المسبورة", "Sites probed")}</span>
        <span className="v font-mono">{summary.sites}</span>
      </div>
      <div className={`perio-stat ${bopAlert ? "border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10" : ""}`}>
        <div className="flex items-center justify-between gap-1">
          <span className="k">{t("النزف عند السبر", "Bleeding on probing")}</span>
          {summary.bopPct !== null && (
            <Badge variant={bopAlert ? "bad" : "ok"} className="text-[10px] px-1.5 py-0">
              {bopAlert ? t("التهاب نشط", "Active") : t("سليمة", "Healthy")}
            </Badge>
          )}
        </div>
        <span className={`v font-mono ${bopAlert ? "text-amber-700 dark:text-amber-400" : "text-foreground"}`}>
          {summary.bopPct === null ? "—" : `${summary.bopPct}%`}
        </span>
      </div>
      <div className="perio-stat">
        <span className="k">{t("البلاك", "Plaque")}</span>
        <span className="v font-mono">{summary.plaquePct === null ? "—" : `${summary.plaquePct}%`}</span>
      </div>
      <div className={`perio-stat ${summary.pd4 > 0 ? "border-amber-500/35" : ""}`}>
        <div className="flex items-center justify-between gap-1">
          <span className="k">{t("جيوب ≥ 4 مم", "Pockets ≥ 4 mm")}</span>
          {summary.pd4 > 0 && <Badge variant="warn" className="text-[10px] px-1.5 py-0">{summary.pd4}</Badge>}
        </div>
        <span className={`v font-mono ${summary.pd4 > 0 ? "text-amber-700 dark:text-amber-400" : "text-foreground"}`}>
          {summary.pd4}
        </span>
      </div>
      <div className={`perio-stat ${summary.pd6 > 0 ? "border-rose-500/40 bg-rose-500/5 dark:bg-rose-500/10" : ""}`}>
        <div className="flex items-center justify-between gap-1">
          <span className="k">{t("جيوب ≥ 6 مم", "Pockets ≥ 6 mm")}</span>
          {summary.pd6 > 0 && <Badge variant="bad" className="text-[10px] px-1.5 py-0">{summary.pd6}</Badge>}
        </div>
        <span className={`v font-mono ${summary.pd6 > 0 ? "text-rose-700 dark:text-rose-400" : "text-foreground"}`}>
          {summary.pd6}
        </span>
      </div>
      <div className="perio-stat">
        <span className="k">{t("متوسط الارتباط", "Mean CAL")}</span>
        <span className="v font-mono">{summary.meanCal === null ? "—" : `${summary.meanCal} ${t("مم", "mm")}`}</span>
      </div>
      <div className={`perio-stat ${(summary.maxCal ?? 0) >= 5 ? "border-rose-500/35" : ""}`}>
        <span className="k">{t("أقصى فقد ارتباط", "Max CAL")}</span>
        <span className="v font-mono">
          {summary.maxCal === null ? "—" : `${summary.maxCal} ${t("مم", "mm")}`}
        </span>
      </div>
    </div>
  );

  const legend = (
    <div className="perio-legend w-full max-w-full min-w-0 flex flex-wrap items-center gap-3 text-xs text-muted-foreground p-3 rounded-lg border border-border/40 bg-surface-2/40" dir={ar ? "rtl" : "ltr"}>
      <div className="flex items-center gap-1.5">
        <span className="lg ok inline-block w-2.5 h-2.5 rounded bg-emerald-500" />
        <span className="font-medium text-foreground">{t("1–3 مم", "1–3 mm")}</span>
        <span className="text-muted-foreground">({t("عمق طبيعي", "normal depth")})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="lg warn inline-block w-2.5 h-2.5 rounded bg-amber-500" />
        <span className="font-medium text-foreground">{t("4–5 مم", "4–5 mm")}</span>
        <span className="text-muted-foreground">({t("جيب متوسط", "moderate pocket")})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="lg deep inline-block w-2.5 h-2.5 rounded bg-rose-500" />
        <span className="font-medium text-foreground">{t("6 مم فأكثر", "6 mm +")}</span>
        <span className="text-muted-foreground">({t("جيب عميق", "deep pocket")})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="lg gm inline-block w-3.5 h-0.5 rounded bg-sky-500" />
        <span className="font-medium text-foreground">{t("حافة اللثة", "gingival margin")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="lg cal inline-block w-3.5 h-0.5 rounded bg-rose-500" />
        <span className="font-medium text-foreground">{t("مستوى الارتباط (CAL)", "attachment level (CAL)")}</span>
      </div>
      <div className="w-full text-[11px] text-muted-foreground pt-1 border-t border-border/30">
        {t("حافة اللثة: موجب = فوق ملتقى المينا بالملاط (تضخم)، سالب = انحسار. الارتباط = العمق − الحافة.",
          "Margin: positive = coronal to the CEJ (overgrowth), negative = recession. CAL = depth − margin.")}
      </div>
    </div>
  );

  if (readOnly) return <div className="perio w-full max-w-full min-w-0">{stats}{arch("upper")}{arch("lower")}{legend}</div>;

  const h = edit!.header;
  return (
    <form action={formAction} className="perio w-full max-w-full min-w-0" id="perio-form">
      {Object.entries(edit!.hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="_id" value={examId} />
      <input type="hidden" name="teeth" value={payload} />
      <input type="hidden" name="_finalize" defaultValue="0" ref={finalizeRef} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 perio-head w-full max-w-full min-w-0">
        <div className="field"><label htmlFor="pe-date">{t("تاريخ الفحص", "Exam date")}</label><input id="pe-date" name="exam_date" type="date" required max={edit!.today} defaultValue={h.exam_date} /></div>
        <div className="field"><label htmlFor="pe-examiner">{t("الفاحص", "Examiner")}</label><input id="pe-examiner" name="examiner_name" maxLength={200} defaultValue={h.examiner_name} readOnly={edit!.examinerLocked} /></div>
        <div className="field"><label htmlFor="pe-facility">{t("المنشأة", "Facility")}</label><input id="pe-facility" name="facility_name" maxLength={200} defaultValue={h.facility_name} /></div>
        <div className="field perio-auto"><label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t("انتقال تلقائي بعد كل رقم", "Move on after each digit")}</label>
          <span className="small muted">{t("Enter أو مسافة للانتقال يدوياً؛ بعد «1» في العمق انتظر رقماً ثانياً.", "Enter or space moves on; after “1” in depth, a second digit may follow.")}</span></div>
      </div>
      {stats}
      {arch("upper")}
      {arch("lower")}
      {legend}
      {edit!.dx && <PerioDxFields lang={lang} teeth={modelTeeth} factors={edit!.dx.factors} initial={edit!.dx.initial} visits={edit!.dx.visits} visitId={edit!.dx.visitId} />}
      <div className="field"><label htmlFor="pe-notes">{t("ملاحظات", "Notes")}</label><textarea id="pe-notes" name="notes" rows={2} maxLength={4000} defaultValue={h.notes} /></div>
      <div aria-live="polite">
        {form?.error && <p className="form-msg err" role="alert">{form.error}</p>}
        {form?.ok && form.message && <p className="form-msg ok">{form.message}</p>}
      </div>
      <div className="row gap">
        <SubmitButton className="btn inline-flex items-center gap-1.5" pending={t("جارٍ الحفظ…", "Saving…")}>
          <Save size={15} aria-hidden="true" />
          <span>{t("حفظ المسودة", "Save draft")}</span>
        </SubmitButton>
        <button type="submit" className="btn primary inline-flex items-center gap-1.5" onClick={(e) => {
          if (!window.confirm(t("بعد الاعتماد لا يُعدَّل المخطط (يمكن إبطاله بسبب فقط). اعتماد الآن؟", "A final chart is not edited (it can only be invalidated with a reason). Finalise now?"))) { e.preventDefault(); return; }
          if (finalizeRef.current) finalizeRef.current.value = "1";
        }}>
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>{t("اعتماد المخطط", "Finalise the chart")}</span>
        </button>
      </div>
    </form>
  );
}
