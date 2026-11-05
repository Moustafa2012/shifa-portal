"use client";
import { DirectionProvider } from "@/components/ui/direction";

import { useRef } from "react";
import type { Lang } from "@/lib/i18n";
import {
  ABSENT_STATUSES, FINDING_KIND, HIDDEN_STATUSES, KIND_BADGE, SURFACES, TOOTH_STATUS, archesFor, fmtSurfaces, surfaceFromKey, surfaceSide, surfaceTone,
  toothName, type Dentition, type FindingRow, type Surface,
} from "@/lib/dental";
import { lbl } from "@/lib/labels";

export interface ChartTooth {
  status: string | null;
  findings: Pick<FindingRow, "kind" | "surfaces">[];
  /** open diagnoses on this tooth, and how many procedures and images name it */
  links?: { problems: { name: string; code: string }[]; procedures: number; images: number; planned?: number };
}

/** What a tooth shows, in words (screen readers; the same text for every chart view). */
export function toothAriaLabel(tooth: number, data: ChartTooth | undefined, lang: Lang): string {
  const ar = lang === "ar";
  const fs = data?.findings ?? [], problems = data?.links?.problems ?? [];
  const nProc = data?.links?.procedures ?? 0, nImg = data?.links?.images ?? 0, nPlan = data?.links?.planned ?? 0;
  return [
    `${tooth} ${toothName(tooth, lang)}`,
    data?.status ? lbl(TOOTH_STATUS, data.status, lang) : (ar ? "لا بيانات فحص" : "no exam data"),
    ...fs.map((f) => `${lbl(FINDING_KIND, f.kind, lang)}${f.surfaces.length ? " " + fmtSurfaces(f.surfaces, tooth) : ""}`),
    ...problems.map((p) => (ar ? `مشكلة: ${p.name}` : `problem: ${p.name}`)),
    ...(nProc ? [ar ? `إجراءات: ${nProc}` : `procedures: ${nProc}`] : []),
    ...(nImg ? [ar ? `صور: ${nImg}` : `images: ${nImg}`] : []),
    ...(nPlan ? [ar ? `علاج مخطط: ${nPlan}` : `planned treatments: ${nPlan}`] : []),
  ].join(" — ");
}

const CELL = 46, S = 34, K = 11, GAP = 16, ROW_H = 78;
const PAD = (CELL - S) / 2;

/** x of the left edge of each tooth cell in a row, the row centred on the widest (16-tooth) row */
function rowLayout(row: number[]): { tooth: number; x: number }[] {
  const full = 16 * CELL + GAP;
  const half = row.length / 2;
  const width = row.length * CELL + GAP;
  const off = (full - width) / 2;
  return row.map((tooth, i) => ({ tooth, x: off + i * CELL + (i >= half ? GAP : 0) }));
}

function regions(x: number, y: number): Record<"top" | "bottom" | "left" | "right" | "center", string> {
  const p = (pts: [number, number][]) => pts.map(([a, b]) => `${a},${b}`).join(" ");
  return {
    top: p([[x, y], [x + S, y], [x + S - K, y + K], [x + K, y + K]]),
    bottom: p([[x, y + S], [x + S, y + S], [x + S - K, y + S - K], [x + K, y + S - K]]),
    left: p([[x, y], [x + K, y + K], [x + K, y + S - K], [x, y + S]]),
    right: p([[x + S, y], [x + S - K, y + K], [x + S - K, y + S - K], [x + S, y + S]]),
    center: p([[x + K, y + K], [x + S - K, y + K], [x + S - K, y + S - K], [x + K, y + S - K]]),
  };
}

/**
 * The tooth chart, drawn facing the patient (patient's right on the viewer's left) in every language. Each tooth is a
 * button (arrow keys move, Enter selects); in edit mode its five surfaces can be clicked or toggled with M/O/D/B/L
 * (I and P also work on front and upper teeth).
 */
export function Odontogram({
  dentition, teeth, lang, selected, onSelect, onSurface, marked, idPrefix = "tooth",
}: {
  dentition: Dentition; teeth: Record<number, ChartTooth>; lang: Lang; selected?: number | null; onSelect?: (t: number) => void;
  onSurface?: (t: number, s: Surface) => void; marked?: Surface[]; idPrefix?: string;
}) {
  const refs = useRef(new Map<number, SVGGElement>());
  const rows = archesFor(dentition);
  const layouts = rows.map(rowLayout);
  const width = 16 * CELL + GAP;
  const height = rows.length * ROW_H + (rows.length > 2 ? 10 : 0);
  const rowY = (r: number) => r * ROW_H + (rows.length > 2 && r >= rows.length / 2 ? 10 : 0);
  const ar = lang === "ar";
  const first = layouts[0][0].tooth;
  const focusable = selected && rows.some((r) => r.includes(selected)) ? selected : first;

  const move = (tooth: number, dr: number, di: number) => {
    const r = layouts.findIndex((l) => l.some((c) => c.tooth === tooth));
    const i = layouts[r].findIndex((c) => c.tooth === tooth);
    let target: number | undefined;
    if (di) target = layouts[r][Math.max(0, Math.min(layouts[r].length - 1, i + di))]?.tooth;
    else {
      const nr = r + dr;
      if (nr < 0 || nr >= layouts.length) return;
      const x = layouts[r][i].x;
      target = layouts[nr].reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)).tooth;
    }
    if (target) refs.current.get(target)?.focus();
  };

  const onKey = (tooth: number) => (e: React.KeyboardEvent<SVGGElement>) => {
    const k = e.key;
    if (k === "ArrowLeft") { e.preventDefault(); move(tooth, 0, -1); }
    else if (k === "ArrowRight") { e.preventDefault(); move(tooth, 0, 1); }
    else if (k === "ArrowUp") { e.preventDefault(); move(tooth, -1, 0); }
    else if (k === "ArrowDown") { e.preventDefault(); move(tooth, 1, 0); }
    else if (k === "Home" || k === "End") {
      e.preventDefault();
      const l = layouts.find((x) => x.some((c) => c.tooth === tooth))!;
      refs.current.get((k === "Home" ? l[0] : l[l.length - 1]).tooth)?.focus();
    } else if (k === "Enter" || k === " ") { e.preventDefault(); onSelect?.(tooth); }
    else if (onSurface && selected === tooth && k.length === 1) {
      const s = surfaceFromKey(k, tooth);
      if (s) { e.preventDefault(); onSurface(tooth, s); }
    }
  };

  return (
    <DirectionProvider direction="ltr">
    <div className="odonto" dir="ltr">
      <div className="odonto-sides" aria-hidden="true">
        <span>{ar ? "يمين المريض" : "Patient's right"}</span>
        <span>{ar ? "الفك العلوي ↑ · السفلي ↓" : "Upper ↑ · Lower ↓"}</span>
        <span>{ar ? "يسار المريض" : "Patient's left"}</span>
      </div>
      <div className="odonto-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} className="odonto-svg" role="group"
          aria-label={ar ? "مخطط الأسنان: يمين المريض على اليسار" : "Tooth chart: patient's right on the left"}>
          <defs>
            <pattern id={`${idPrefix}-work`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" className="dent-work-bg" />
              <line x1="0" y1="0" x2="0" y2="5" className="dent-work-line" />
            </pattern>
          </defs>
          <line x1={width / 2} y1={2} x2={width / 2} y2={height - 2} className="odonto-mid" />
          {layouts.map((row, r) => row.map(({ tooth, x }) => {
            const upper = r < rows.length / 2;
            const y0 = rowY(r);
            const dy = upper ? y0 + 14 : y0 + 18;
            const tx = x + PAD;
            const data = teeth[tooth];
            const status = data?.status ?? null;
            const fs = data?.findings ?? [];
            const absent = status != null && ABSENT_STATUSES.has(status);
            const hidden = status != null && HIDDEN_STATUSES.has(status);
            const reg = regions(tx, dy);
            const problems = data?.links?.problems ?? [];
            const probCodes = [...new Set(problems.map((p) => p.code))];
            const workCodes = [...new Set(fs.map((f) => KIND_BADGE[f.kind]).filter(Boolean))];
            const badgeList = [...probCodes.map((c) => ({ c, bad: true })), ...workCodes.map((c) => ({ c, bad: false }))].slice(0, 2);
            const nProc = data?.links?.procedures ?? 0, nImg = data?.links?.images ?? 0;
            const isSel = selected === tooth;
            const label = toothAriaLabel(tooth, data, lang);
            return (
              <g key={tooth} ref={(el) => { if (el) refs.current.set(tooth, el); else refs.current.delete(tooth); }}
                id={`${idPrefix}-${tooth}`} data-tooth={tooth}
                className={`tooth${absent ? " absent" : ""}${hidden ? " hidden" : ""}${status == null && !problems.length && !fs.length ? " nodata" : ""}${problems.length ? " problem" : ""}${isSel ? " sel" : ""}`}
                role="button" tabIndex={tooth === focusable ? 0 : -1} aria-pressed={isSel} aria-label={label}
                onClick={() => onSelect?.(tooth)} onKeyDown={onKey(tooth)}>
                <rect x={x + 1} y={y0 + 1} width={CELL - 2} height={ROW_H - 4} rx="6" className="tooth-ring" />
                <text x={x + CELL / 2} y={upper ? y0 + 11 : y0 + 66} className="tooth-num">{tooth}</text>
                {SURFACES.map((s) => {
                  const side = surfaceSide(s, tooth);
                  const tone = absent ? null : surfaceTone(fs, s);
                  const mark = isSel && marked?.includes(s);
                  return (
                    <polygon key={s} points={reg[side]} data-surface={s}
                      className={`surf${tone ? ` ${tone}` : ""}${mark ? " mark" : ""}`}
                      style={tone === "work" && !mark ? { fill: `url(#${idPrefix}-work)` } : undefined}
                      onClick={onSurface ? (e) => {
                        // the first click only chooses the tooth; once chosen, clicking a surface toggles it
                        e.stopPropagation();
                        if (isSel) onSurface(tooth, s); else onSelect?.(tooth);
                      } : undefined} />
                  );
                })}
                {absent && <path d={`M${tx + 3},${dy + 3} L${tx + S - 3},${dy + S - 3} M${tx + S - 3},${dy + 3} L${tx + 3},${dy + S - 3}`} className="tooth-x" />}
                {problems.length > 0 && <rect x={tx - 2} y={dy - 2} width={S + 4} height={S + 4} rx="5" className="tooth-problem" />}
                {badgeList.length > 0 && (
                  <text x={x + CELL / 2} y={upper ? y0 + 61 : y0 + 13} className="tooth-badge">
                    {badgeList.map((b, i) => <tspan key={i} className={b.bad ? "bad" : undefined}>{i > 0 ? "·" : ""}{b.c}</tspan>)}
                  </text>
                )}
                {nProc > 0 && <circle cx={x + 6} cy={upper ? y0 + 7 : y0 + 62} r="3" className="mk-proc" />}
                {(data?.links?.planned ?? 0) > 0 && <path d={`M ${x + 11},${upper ? y0 + 10 : y0 + 65} l 3.5,-6 l 3.5,6 z`} className="mk-plan" />}
                {nImg > 0 && <rect x={x + CELL - 9} y={upper ? y0 + 4 : y0 + 59} width="6" height="6" rx="1" className="mk-img" />}
              </g>
            );
          }))}
        </svg>
      </div>
    </div>
    </DirectionProvider>
  );
}

export function OdontoLegend({ lang }: { lang: Lang }) {
  const ar = lang === "ar";
  return (
    <ul className="odonto-legend">
      <li><svg width="18" height="14" aria-hidden="true"><rect width="18" height="14" className="surf disease" /></svg>{ar ? "مشكلة تحتاج علاجاً (تسوس، كسر…)" : "Problem to treat (caries, fracture…)"}</li>
      <li><svg width="18" height="14" aria-hidden="true"><defs><pattern id="lg-work" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" className="dent-work-bg" /><line x1="0" y1="0" x2="0" y2="5" className="dent-work-line" /></pattern></defs><rect width="18" height="14" style={{ fill: "url(#lg-work)" }} className="surf" /></svg>{ar ? "علاج موجود (حشوة، تاج…)" : "Existing work (filling, crown…)"}</li>
      <li><svg width="18" height="14" aria-hidden="true"><rect width="18" height="14" className="surf" /><path d="M3,2 L15,12 M15,2 L3,12" className="tooth-x" /></svg>{ar ? "مفقود / مخلوع" : "Missing / extracted"}</li>
      <li><svg width="18" height="14" aria-hidden="true"><rect x="1" y="1" width="16" height="12" className="surf legend-hidden" /></svg>{ar ? "لم يبزغ / مطمور" : "Unerupted / impacted"}</li>
      <li><svg width="18" height="14" aria-hidden="true"><rect x="1" y="1" width="16" height="12" className="surf legend-nodata" /></svg>{ar ? "لا بيانات فحص (لا يعني سليماً)" : "No exam data (not the same as healthy)"}</li>
      <li><span className="tooth-badge-txt">CR RCT IMP</span>{ar ? "تاج، علاج عصب، زرعة…" : "Crown, root canal, implant…"}</li>
      <li><svg width="18" height="14" aria-hidden="true"><rect x="1" y="1" width="16" height="12" rx="3" className="tooth-problem" /></svg><span className="tooth-badge-txt bad">ABS</span>{ar ? "مشكلة نشطة (تشخيص)" : "Open problem (diagnosis)"}</li>
      <li><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" className="mk-proc" /></svg>{ar ? "إجراء مسجل" : "Procedure recorded"}</li>
      <li><svg width="10" height="10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1" className="mk-img" /></svg>{ar ? "صورة / أشعة" : "Image / X-ray"}</li>
    </ul>
  );
}
