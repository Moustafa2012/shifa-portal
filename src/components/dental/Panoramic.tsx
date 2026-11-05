"use client";

import { useMemo, useRef, useState } from "react";
import {
  Compass,
  Filter,
  Layers,
  Maximize2,
  Minimize2,
  Sparkles,
  Check,
  AlertTriangle,
  Info,
} from "lucide-react";
import type { Lang } from "@/lib/i18n";
import {
  ABSENT_STATUSES,
  FINDING_KIND,
  TOOTH_STATUS,
  SURFACES,
  surfaceTone,
  toothName,
  quadrant,
  isUpper,
  isPatientRight,
  isPrimary,
  fmtSurfaces,
  type Dentition,
  type Surface,
} from "@/lib/dental";
import { lbl } from "@/lib/labels";
import { apexOf, archLayout, mirrorX, panoramicPairs, rootPath, smile, toothShape } from "@/lib/dental-anatomy";
import { toothAriaLabel, type ChartTooth } from "./Odontogram";
import { Badge } from "@/components/ui/badge";

const MARGIN = 20;
const HEADER_H = 46;
const NUM_H = 38;
const SPAN = 155;
const MID = 30;
const FOOTER_H = 46;
const BLOCK_H = HEADER_H + NUM_H + SPAN + MID + SPAN + NUM_H + FOOTER_H;
const LESION_CODES = new Set(["ABS", "PA", "NEC"]);

/** Surface patches on a crown drawn as a lower tooth (+x mesial). Buccal and lingual face the viewer and the back. */
function surfacePatch(s: Surface, w: number, ch: number) {
  switch (s) {
    case "O": return <rect x={-w / 2 - 2} y={-4} width={w + 4} height={ch * 0.3 + 4} />;
    case "M": return <rect x={0.2 * w} y={ch * 0.2} width={0.32 * w} height={ch * 0.78} />;
    case "D": return <rect x={-0.52 * w} y={ch * 0.2} width={0.32 * w} height={ch * 0.78} />;
    case "B": return <ellipse cx={0} cy={ch * 0.47} rx={0.17 * w} ry={ch * 0.17} />;
    case "L": return <ellipse cx={0} cy={ch * 0.78} rx={0.15 * w} ry={ch * 0.12} opacity={0.7} />;
  }
}

/** Quadrant notation and localized anatomical region */
function quadrantInfo(tooth: number, lang: Lang): { code: string; name: string } {
  const q = quadrant(tooth);
  const ar = lang === "ar";
  switch (q) {
    case 1: return { code: "Q1 (UR)", name: ar ? "الربع 1 · علوي أيمن" : "Q1 · Maxilla Right" };
    case 2: return { code: "Q2 (UL)", name: ar ? "الربع 2 · علوي أيسر" : "Q2 · Maxilla Left" };
    case 3: return { code: "Q3 (LL)", name: ar ? "الربع 3 · سفلي أيسر" : "Q3 · Mandible Left" };
    case 4: return { code: "Q4 (LR)", name: ar ? "الربع 4 · سفلي أيمن" : "Q4 · Mandible Right" };
    case 5: return { code: "Q5 (UR)", name: ar ? "الربع 5 · لبني علوي أيمن" : "Q5 · Primary UR" };
    case 6: return { code: "Q6 (UL)", name: ar ? "الربع 6 · لبني علوي أيسر" : "Q6 · Primary UL" };
    case 7: return { code: "Q7 (LL)", name: ar ? "الربع 7 · لبني سفلي أيسر" : "Q7 · Primary LL" };
    case 8: return { code: "Q8 (LR)", name: ar ? "الربع 8 · لبني سفلي أيمن" : "Q8 · Primary LR" };
    default: return { code: `Q${q}`, name: `Quadrant ${q}` };
  }
}

/** Determines if a tooth matches an active clinical filter */
function toothMatchesFilter(data: ChartTooth | undefined, filter: string | null): boolean {
  if (!filter || filter === "all") return true;
  if (!data) return false;
  const fs = data.findings ?? [];
  const kinds = new Set(fs.map((f) => f.kind));
  const problems = data.links?.problems ?? [];
  const status = data.status;

  switch (filter) {
    case "problems":
      return problems.length > 0;
    case "disease":
      return (
        kinds.has("caries") ||
        kinds.has("secondary_caries") ||
        kinds.has("fracture") ||
        kinds.has("crack") ||
        kinds.has("wear") ||
        kinds.has("defective_restoration") ||
        kinds.has("retained_root")
      );
    case "work":
      return (
        kinds.has("filling") ||
        kinds.has("crown") ||
        kinds.has("bridge_abutment") ||
        kinds.has("bridge_pontic") ||
        kinds.has("inlay_onlay") ||
        kinds.has("veneer") ||
        kinds.has("denture") ||
        kinds.has("ortho_appliance")
      );
    case "rct":
      return (
        kinds.has("root_canal") ||
        kinds.has("post_core") ||
        kinds.has("periapical_lesion") ||
        kinds.has("abscess") ||
        problems.some((p) => LESION_CODES.has(p.code))
      );
    case "missing":
      return (
        (status != null && ABSENT_STATUSES.has(status)) ||
        kinds.has("implant") ||
        status === "unerupted" ||
        status === "impacted"
      );
    case "planned":
      return (data.links?.planned ?? 0) > 0;
    default:
      return true;
  }
}

/**
 * The panoramic view: both arches as on a panoramic radiograph (patient's right on the left, upper roots up, a slight
 * "smile" of the occlusal plane), each tooth with its crown, roots, canals and gum line. What is known is drawn where
 * it belongs: caries and fillings on their surfaces, crowns over the crown, root canal fillings in the canals,
 * periapical lesions and abscesses at the apex, implants as a screw, missing teeth as a dashed gap, unerupted and
 * impacted teeth below the gum, recession as a lowered gum line. Schematic: not a radiograph.
 */
export function Panoramic({
  dentition,
  teeth,
  lang,
  selected,
  onSelect,
  idPrefix = "pano",
  filter: externalFilter,
  onFilter: externalOnFilter,
}: {
  dentition: Dentition;
  teeth: Record<number, ChartTooth>;
  lang: Lang;
  selected?: number | null;
  onSelect?: (t: number) => void;
  idPrefix?: string;
  filter?: string | null;
  onFilter?: (filter: string | null) => void;
}) {
  const refs = useRef(new Map<number, SVGGElement>());
  const [hovered, setHovered] = useState<number | null>(null);
  const [internalFilter, setInternalFilter] = useState<string | null>(null);
  const filter = externalFilter !== undefined ? externalFilter : internalFilter;
  const setFilter = externalOnFilter ?? setInternalFilter;
  const [zoomWide, setZoomWide] = useState<boolean>(false);

  const ar = lang === "ar";
  const pairs = panoramicPairs(dentition);
  const layouts = pairs.map(([u, l]) => [archLayout(u), archLayout(l)] as const);
  const archW = (l: { cx: number; w: number }[]) => (l.length ? l[l.length - 1].cx + l[l.length - 1].w / 2 : 0);
  const W = Math.max(...layouts.flatMap(([u, l]) => [archW(u), archW(l)])) + MARGIN * 2;
  const H = BLOCK_H * pairs.length;
  const isPrim = dentition === "primary";
  const qUR = isPrim ? "Q5 · UR" : "Q1 · UR";
  const qUL = isPrim ? "Q6 · UL" : "Q2 · UL";
  const qLR = isPrim ? "Q8 · LR" : "Q4 · LR";
  const qLL = isPrim ? "Q7 · LL" : "Q3 · LL";

  // every row as absolute x positions, for drawing and for the arrow keys
  const rows = layouts.flatMap(([u, l], bi) =>
    [u, l].map((arch, ai) => {
      const off = MARGIN + (W - MARGIN * 2 - archW(arch)) / 2;
      const blockTop = bi * BLOCK_H;
      const occUpper = blockTop + HEADER_H + NUM_H + SPAN;
      const occ = ai === 0 ? occUpper : occUpper + MID;
      return {
        upper: ai === 0,
        occ,
        top: blockTop,
        teeth: arch.map((x) => ({ tooth: x.tooth, cx: off + x.cx, w: x.w })),
      };
    })
  );

  const all = rows.flatMap((r) => r.teeth.map((t) => t.tooth));
  const focusable = selected && all.includes(selected) ? selected : all[0];
  const activeTooth = hovered ?? selected ?? null;
  const activeData = activeTooth ? teeth[activeTooth] : undefined;

  // Summary statistics across whole dentition
  const stats = useMemo(() => {
    let examined = 0, problems = 0, work = 0, absent = 0, planned = 0;
    for (const t of all) {
      const d = teeth[t];
      if (d) {
        if (d.status || d.findings.length > 0) examined++;
        if (d.links?.problems?.length) problems++;
        if ((d.links?.planned ?? 0) > 0) planned++;
        if (d.status && ABSENT_STATUSES.has(d.status)) absent++;
        const kinds = new Set(d.findings.map((f) => f.kind));
        if (
          kinds.has("filling") ||
          kinds.has("crown") ||
          kinds.has("bridge_abutment") ||
          kinds.has("bridge_pontic") ||
          kinds.has("root_canal") ||
          kinds.has("implant")
        ) {
          work++;
        }
      }
    }
    return { examined, problems, work, absent, planned, total: all.length };
  }, [all, teeth]);

  // Live condition counts for filter pills in toolbar
  const filterCounts = useMemo(() => {
    let problems = 0, disease = 0, work = 0, rct = 0, missing = 0, planned = 0;
    for (const t of all) {
      const d = teeth[t];
      if (!d) continue;
      const fs = d.findings ?? [];
      const kinds = new Set(fs.map((f) => f.kind));
      const probs = d.links?.problems ?? [];
      const status = d.status;

      if (probs.length > 0) problems++;
      if (
        kinds.has("caries") ||
        kinds.has("secondary_caries") ||
        kinds.has("fracture") ||
        kinds.has("crack") ||
        kinds.has("wear") ||
        kinds.has("defective_restoration") ||
        kinds.has("retained_root")
      ) {
        disease++;
      }
      if (
        kinds.has("filling") ||
        kinds.has("crown") ||
        kinds.has("bridge_abutment") ||
        kinds.has("bridge_pontic") ||
        kinds.has("inlay_onlay") ||
        kinds.has("veneer") ||
        kinds.has("denture") ||
        kinds.has("ortho_appliance")
      ) {
        work++;
      }
      if (
        kinds.has("root_canal") ||
        kinds.has("post_core") ||
        kinds.has("periapical_lesion") ||
        kinds.has("abscess") ||
        probs.some((p) => LESION_CODES.has(p.code))
      ) {
        rct++;
      }
      if (
        (status != null && ABSENT_STATUSES.has(status)) ||
        kinds.has("implant") ||
        status === "unerupted" ||
        status === "impacted"
      ) {
        missing++;
      }
      if ((d.links?.planned ?? 0) > 0) {
        planned++;
      }
    }
    return {
      all: all.length,
      problems,
      disease,
      work,
      rct,
      missing,
      planned,
    };
  }, [all, teeth]);

  const move = (tooth: number, dr: number, di: number) => {
    const r = rows.findIndex((row) => row.teeth.some((x) => x.tooth === tooth));
    if (r === -1) return;
    const i = rows[r].teeth.findIndex((x) => x.tooth === tooth);
    let target: number | undefined;
    if (di) {
      target = rows[r].teeth[Math.max(0, Math.min(rows[r].teeth.length - 1, i + di))]?.tooth;
    } else {
      const nr = r + dr;
      if (nr < 0 || nr >= rows.length) return;
      const x = rows[r].teeth[i].cx;
      target = rows[nr].teeth.reduce((a, b) => (Math.abs(b.cx - x) < Math.abs(a.cx - x) ? b : a)).tooth;
    }
    if (target) {
      setHovered(target);
      refs.current.get(target)?.focus();
    }
  };

  const onKey = (tooth: number) => (e: React.KeyboardEvent<SVGGElement>) => {
    const k = e.key;
    if (k === "ArrowLeft") { e.preventDefault(); move(tooth, 0, -1); }
    else if (k === "ArrowRight") { e.preventDefault(); move(tooth, 0, 1); }
    else if (k === "ArrowUp") { e.preventDefault(); move(tooth, -1, 0); }
    else if (k === "ArrowDown") { e.preventDefault(); move(tooth, 1, 0); }
    else if (k === "Home") {
      e.preventDefault();
      const r = rows.find((row) => row.teeth.some((x) => x.tooth === tooth));
      if (r && r.teeth.length) {
        const first = r.teeth[0].tooth;
        setHovered(first);
        refs.current.get(first)?.focus();
      }
    } else if (k === "End") {
      e.preventDefault();
      const r = rows.find((row) => row.teeth.some((x) => x.tooth === tooth));
      if (r && r.teeth.length) {
        const last = r.teeth[r.teeth.length - 1].tooth;
        setHovered(last);
        refs.current.get(last)?.focus();
      }
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      onSelect?.(tooth);
    }
  };

  return (
    <div className={`pano-container pano ${zoomWide ? "zoom-wide" : ""}`} dir={ar ? "rtl" : "ltr"}>
      {/* Top Clinical Inspection HUD */}
      <div
        className="pano-hud"
        role="region"
        aria-label={ar ? "معلومات السن المحدد" : "Inspected tooth details"}
        dir={ar ? "rtl" : "ltr"}
      >
        {activeTooth ? (
          <div className="pano-hud-target">
            <Badge variant="info" className="font-mono text-xs font-bold px-2 py-0.5">
              <bdi>{activeTooth}</bdi>
            </Badge>
            <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
              <bdi>{quadrantInfo(activeTooth, lang).code}</bdi> · {quadrantInfo(activeTooth, lang).name}
            </Badge>
            <strong className="text-sm font-semibold text-foreground">{toothName(activeTooth, lang)}</strong>
            {activeData?.status && (
              <Badge variant={ABSENT_STATUSES.has(activeData.status) ? "bad" : "muted"}>
                {lbl(TOOTH_STATUS, activeData.status, lang)}
              </Badge>
            )}
            {activeData?.findings?.map((f, i) => (
              <Badge key={i} variant="warn">
                {lbl(FINDING_KIND, f.kind, lang)}
                {f.surfaces?.length ? ` (${fmtSurfaces(f.surfaces, activeTooth)})` : ""}
              </Badge>
            ))}
            {activeData?.links?.problems?.map((p, i) => (
              <Badge key={i} variant="bad">
                {ar ? `تشخيص: ${p.name}` : `Problem: ${p.name}`}
              </Badge>
            ))}
            {(activeData?.links?.planned ?? 0) > 0 && (
              <Badge variant="warn">
                {ar ? `خطة علاج (${activeData!.links!.planned})` : `Planned (${activeData!.links!.planned})`}
              </Badge>
            )}
            {selected === activeTooth ? (
              <Badge variant="ok">
                <Check size={12} aria-hidden="true" className={ar ? "ms-0.5" : "me-0.5"} />
                {ar ? "محدد حالياً" : "Selected"}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">
                {ar ? "انقر للتحديد وتعديل الفحص" : "Click to select for editing"}
              </span>
            )}
          </div>
        ) : (
          <div className="pano-hud-target">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
              <Compass size={14} aria-hidden="true" />
              <span>{ar ? "مرر المؤشر أو استخدم الأسهم للتنقل السريع بين الأسنان" : "Hover or use arrow keys to inspect teeth"}</span>
            </span>
          </div>
        )}

        <div className="pano-hud-stats">
          <Badge variant="secondary" className="text-xs">
            {ar ? `المفحوصة: ${stats.examined}/${stats.total}` : `Examined: ${stats.examined}/${stats.total}`}
          </Badge>
          {stats.problems > 0 && (
            <Badge variant="bad" className="text-xs">
              {ar ? `مشاكل: ${stats.problems}` : `Problems: ${stats.problems}`}
            </Badge>
          )}
          {stats.work > 0 && (
            <Badge variant="info" className="text-xs">
              {ar ? `علاجات: ${stats.work}` : `Restored: ${stats.work}`}
            </Badge>
          )}
          {stats.absent > 0 && (
            <Badge variant="muted" className="text-xs">
              {ar ? `مفقودة: ${stats.absent}` : `Missing: ${stats.absent}`}
            </Badge>
          )}
          {stats.planned > 0 && (
            <Badge variant="warn" className="text-xs">
              {ar ? `مخططة: ${stats.planned}` : `Planned: ${stats.planned}`}
            </Badge>
          )}
        </div>
      </div>

      {/* Panoramic Clinical Filters and View Controls Toolbar */}
      <div className="pano-toolbar" dir={ar ? "rtl" : "ltr"}>
        <div className="pano-filters" role="group" aria-label={ar ? "تصفية الحالات" : "Clinical filters"}>
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1 me-1">
            <Filter size={13} aria-hidden="true" />
            <span>{ar ? "إبراز:" : "Highlight:"}</span>
          </span>
          {[
            { id: "all", label: ar ? "الكل" : "All", count: filterCounts.all },
            { id: "problems", label: ar ? "تشخيصات ومشاكل" : "Problems", count: filterCounts.problems },
            { id: "disease", label: ar ? "تسوس وأمراض" : "Caries/Disease", count: filterCounts.disease },
            { id: "work", label: ar ? "حشوات وتيجان" : "Restorations", count: filterCounts.work },
            { id: "rct", label: ar ? "عصب وذروة" : "Endo/Apical", count: filterCounts.rct },
            { id: "missing", label: ar ? "مفقود ومطمور" : "Missing/Gaps", count: filterCounts.missing },
            { id: "planned", label: ar ? "علاج مخطط" : "Planned Tx", count: filterCounts.planned },
          ].map((btn) => (
            <button
              key={btn.id}
              type="button"
              className="pano-filter-btn"
              aria-pressed={(filter === null && btn.id === "all") || filter === btn.id}
              onClick={() => setFilter(btn.id === "all" ? null : filter === btn.id ? null : btn.id)}
            >
              <span>{btn.label}</span>
              <span className="pano-filter-count font-mono"><bdi>{btn.count}</bdi></span>
            </button>
          ))}
        </div>

        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            className="pano-zoom-btn"
            aria-pressed={zoomWide}
            onClick={() => setZoomWide(!zoomWide)}
            title={ar ? "تبديل عرض البانوراما" : "Toggle zoom scale"}
          >
            {zoomWide ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
            <span>{zoomWide ? (ar ? "عرض ملائم" : "Fit to width") : (ar ? "تكبير التفاصيل" : "Detailed view")}</span>
          </button>
        </div>
      </div>

      {/* Orientation Bar (Fixed LTR: patient's right is on the left, patient's left on the right) */}
      <div className="odonto-sides" dir="ltr" style={{ direction: "ltr" }} aria-hidden="true">
        <span className="font-medium text-xs text-foreground/85">{ar ? "يمين المريض (R)" : "Patient's right (R)"}</span>
        <span className="text-xs text-muted-foreground">{ar ? "بانوراما تخطيطية — ليست صورة أشعة رسمية" : "Schematic panoramic — not an official radiograph"}</span>
        <span className="font-medium text-xs text-foreground/85">{ar ? "يسار المريض (L)" : "Patient's left (L)"}</span>
      </div>

      {/* SVG Canvas (Fixed LTR viewport for anatomical accuracy) */}
      <div className="min-h-auto odonto-scroll" dir="ltr" style={{ direction: "ltr" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="pano-svg"
          role="grid"
          aria-label={ar ? "مخطط بانورامي للأسنان: يمين المريض على اليسار" : "Panoramic tooth chart: patient's right on the left"}
          style={{ direction: "ltr" }}
        >
          <defs>
            <pattern
              id={`${idPrefix}-work`}
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="4" height="4" className="pano-work-bg" />
              <line x1="0" y1="0" x2="0" y2="4" className="pano-work-line" />
            </pattern>
          </defs>

          {/* Panoramic Dark Canvas Background */}
          <rect x="0" y="0" width={W} height={H} rx="14" className="pano-bg" />

          {/* Alveolar Bone Curvature following the occlusal smile curve */}
          {rows.map((row, ri) => {
            const pts: string[] = [];
            for (let x = MARGIN; x <= W - MARGIN; x += 12) {
              pts.push(`${x},${row.occ + smile(x, W) + (row.upper ? -10 : 10)}`);
            }
            for (let x = W - MARGIN; x >= MARGIN; x -= 12) {
              pts.push(`${x},${row.occ + smile(x, W) + (row.upper ? -SPAN + 6 : SPAN - 6)}`);
            }
            return <polygon key={`bone-${ri}`} points={pts.join(" ")} className="pano-bone" />;
          })}

          {/* Midline vertical axis and anatomical label */}
          <line x1={W / 2} y1={8} x2={W / 2} y2={H - 8} className="pano-mid" />
          <text x={W / 2} y={38} className="pano-midline-label">
            {ar ? "خط المنتصف" : "MIDLINE"}
          </text>
          <text x={W / 2} y={H - 32} className="pano-midline-label">
            {ar ? "خط المنتصف" : "MIDLINE"}
          </text>

          {/* Quadrant and Arch Perimeter Labels */}
          <text x={MARGIN + 8} y={22} textAnchor="start" className="pano-quad-label">{qUR}</text>
          <text x={W - MARGIN - 8} y={22} textAnchor="end" className="pano-quad-label">{qUL}</text>
          <text x={MARGIN + 8} y={H - 16} textAnchor="start" className="pano-quad-label">{qLR}</text>
          <text x={W - MARGIN - 8} y={H - 16} textAnchor="end" className="pano-quad-label">{qLL}</text>

          {/* Arch Titles */}
          {rows.map((row, ri) => (
            <text
              key={`arch-title-${ri}`}
              x={W / 2}
              y={row.upper ? row.top + 22 : row.top + BLOCK_H - 16}
              className="pano-arch-label"
              opacity={0.4}
            >
              {row.upper
                ? (ar ? "الفك العلوي (MAXILLA)" : "MAXILLA")
                : (ar ? "الفك السفلي (MANDIBLE)" : "MANDIBLE")}
            </text>
          ))}

          {/* Dental Bridge Connectors between adjacent teeth sharing bridge restorations */}
          {rows.map((row, ri) => (
            <g key={`bridges-${ri}`}>
              {row.teeth.map((tCurr, idx) => {
                if (idx === row.teeth.length - 1) return null;
                const tNext = row.teeth[idx + 1];
                const dCurr = teeth[tCurr.tooth], dNext = teeth[tNext.tooth];
                if (!dCurr || !dNext) return null;
                const k1 = new Set(dCurr.findings.map((f) => f.kind));
                const k2 = new Set(dNext.findings.map((f) => f.kind));
                const isBridge1 = k1.has("bridge_abutment") || k1.has("bridge_pontic");
                const isBridge2 = k2.has("bridge_abutment") || k2.has("bridge_pontic");
                if (isBridge1 && isBridge2) {
                  const y1 = row.occ + smile(tCurr.cx, W) + (row.upper ? -12 : 12);
                  const y2 = row.occ + smile(tNext.cx, W) + (row.upper ? -12 : 12);
                  return (
                    <g key={`bridge-${tCurr.tooth}-${tNext.tooth}`}>
                      <line x1={tCurr.cx} y1={y1} x2={tNext.cx} y2={y2} className="pano-bridge" />
                      <line x1={tCurr.cx} y1={y1} x2={tNext.cx} y2={y2} className="pano-bridge-line" />
                    </g>
                  );
                }
                return null;
              })}
            </g>
          ))}

          {/* Teeth Elements */}
          {rows.map((row) =>
            row.teeth.map(({ tooth, cx, w }) => {
              const data = teeth[tooth];
              const shape = toothShape(tooth);
              const ch = shape.crownH;
              const status = data?.status ?? null;
              const fs = data?.findings ?? [];
              const kinds = new Set(fs.map((f) => f.kind));
              const problems = data?.links?.problems ?? [];
              const absent = status != null && ABSENT_STATUSES.has(status);
              const pontic = kinds.has("bridge_pontic");
              const implant = kinds.has("implant");
              const rct = kinds.has("root_canal");
              const lesion = kinds.has("periapical_lesion") || kinds.has("abscess") || problems.some((p) => LESION_CODES.has(p.code));
              const recession = kinds.has("recession");
              const eruption =
                status === "unerupted"
                  ? ch * 1.15
                  : status === "impacted"
                    ? ch * 0.95
                    : status === "partially_erupted"
                      ? ch * 0.5
                      : 0;
              const tilt = status === "impacted" ? 32 : 0;
              const occ = row.occ + smile(cx, W);
              const sy = row.upper ? -1 : 1, sx = mirrorX(tooth);
              const maxL = Math.max(...shape.roots.map((r) => r.length));
              const depth = ch + maxL + eruption + 6;
              const box = row.upper ? { y: occ - depth, h: depth + 6 } : { y: occ - 6, h: depth + 6 };
              const isSel = selected === tooth;
              const isHover = hovered === tooth;
              const isMatched = toothMatchesFilter(data, filter);
              const clip = `${idPrefix}-clip-${tooth}`;
              const nProc = data?.links?.procedures ?? 0, nImg = data?.links?.images ?? 0;
              const numY = row.upper ? row.top + HEADER_H + 16 : row.occ + SPAN + 26;
              const codesY = row.upper ? row.top + HEADER_H + 28 : row.occ + SPAN + 12;
              const codes = [...new Set(problems.map((p) => p.code))].slice(0, 2).join("·");

              return (
                <g
                  key={tooth}
                  ref={(el) => {
                    if (el) refs.current.set(tooth, el);
                    else refs.current.delete(tooth);
                  }}
                  id={`${idPrefix}-${tooth}`}
                  data-tooth={tooth}
                  className={`ptooth${status == null && !fs.length && !problems.length ? " nodata" : ""}${problems.length ? " problem" : ""
                    }${isSel ? " sel" : ""}${!isMatched ? " dimmed" : ""}${filter && isMatched ? " highlighted" : ""
                    }`}
                  role="gridcell"
                  tabIndex={tooth === focusable ? 0 : -1}
                  aria-selected={isSel}
                  aria-label={toothAriaLabel(tooth, data, lang)}
                  onClick={() => onSelect?.(tooth)}
                  onMouseEnter={() => setHovered(tooth)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(tooth)}
                  onBlur={() => setHovered(null)}
                  onKeyDown={onKey(tooth)}
                >
                  <rect x={cx - w / 2} y={box.y} width={w} height={box.h} rx="7" className="ptooth-ring" />
                  {problems.length > 0 && (
                    <rect
                      x={cx - w / 2 + 1}
                      y={box.y + 1}
                      width={w - 2}
                      height={box.h - 2}
                      rx="7"
                      className="ptooth-problem"
                    />
                  )}

                  <g transform={`translate(${cx},${occ}) scale(${sx},${sy})`}>
                    <defs>
                      <clipPath id={clip}>
                        <path d={shape.crown} />
                      </clipPath>
                    </defs>

                    {absent ? (
                      <g className="ghost">
                        <path d={shape.crown} />
                        {shape.roots.map((r, i) => (
                          <path key={i} d={rootPath(r, ch)} />
                        ))}
                      </g>
                    ) : (
                      <g transform={`translate(0,${eruption}) rotate(${tilt},0,${ch})`}>
                        {/* Roots & Pulpal canals */}
                        {!pontic && !implant &&
                          shape.roots.map((r, i) => (
                            <g key={i}>
                              <path d={rootPath(r, ch)} className="root" />
                              <line
                                x1={r.cx * 0.6}
                                y1={ch * 0.55}
                                x2={r.cx + r.tip * 0.9}
                                y2={ch + r.length - 3}
                                className={`canal${rct ? " rct" : ""}`}
                              />
                            </g>
                          ))}

                        {/* Furcation Involvement indicator on multi-rooted teeth with bone loss */}
                        {shape.roots.length >= 2 && kinds.has("bone_loss") && !implant && !pontic && (
                          <polygon
                            points={`0,${ch + 6} -3.5,${ch + 12} 3.5,${ch + 12}`}
                            className="pano-furcation"
                          />
                        )}

                        {/* Titanium Implant Screw */}
                        {implant && (
                          <g className="implant">
                            <path
                              d={`M ${-0.17 * w},${ch - 2} L ${0.17 * w},${ch - 2} L ${0.12 * w},${ch + maxL * 0.9
                                } L ${-0.12 * w},${ch + maxL * 0.9} Z`}
                            />
                            {Array.from({ length: 6 }, (_, i) => ch + 5 + (i * (maxL * 0.8)) / 6).map((y, i) => (
                              <line
                                key={i}
                                x1={-0.19 * w + i * 0.008 * w}
                                y1={y}
                                x2={0.19 * w - i * 0.008 * w}
                                y2={y + 3}
                                className="thread"
                              />
                            ))}
                          </g>
                        )}

                        {/* Post and core in root */}
                        {kinds.has("post_core") && !implant && (
                          <line
                            x1={shape.roots[shape.roots.length - 1].cx * 0.5}
                            y1={ch * 0.35}
                            x2={shape.roots[shape.roots.length - 1].cx}
                            y2={ch + maxL * 0.45}
                            className="post"
                          />
                        )}

                        {/* Crown and Pulp */}
                        {kinds.has("retained_root") ? (
                          <path
                            d={`M ${-w * 0.35},${ch + 2} Q 0,${ch - 3} ${w * 0.35},${ch + 2}`}
                            className="pano-retained-crown"
                          />
                        ) : (
                          <path d={shape.crown} className="crown" />
                        )}

                        {!implant && !pontic && !kinds.has("retained_root") && (
                          <path d={shape.pulp} className="pulp" />
                        )}

                        {/* Surface Pathologies and Existing Restorations */}
                        <g clipPath={`url(#${clip})`}>
                          {SURFACES.map((s) => {
                            const tone = surfaceTone(fs, s);
                            if (!tone) return null;
                            return (
                              <g
                                key={s}
                                className={`psurf ${tone}`}
                                style={tone === "work" ? { fill: `url(#${idPrefix}-work)` } : undefined}
                              >
                                {surfacePatch(s, shape.w, ch)}
                              </g>
                            );
                          })}
                        </g>

                        {/* Orthodontic bracket */}
                        {kinds.has("ortho_appliance") && (
                          <rect x={-4} y={ch * 0.4} width={8} height={7} className="bracket" />
                        )}

                        {/* Apical Lesion / Abscess */}
                        {lesion &&
                          shape.roots.map((r, i) => {
                            const a = apexOf(r, ch);
                            return <circle key={i} cx={a.x} cy={a.y + 3} r={6.5} className="lesion" />;
                          })}
                      </g>
                    )}

                    {/* Gum line with recession contour */}
                    <path
                      d={`M ${-w / 2},${ch + (recession ? 14 : 4)} Q 0,${ch + (recession ? 7 : -3)
                        } ${w / 2},${ch + (recession ? 14 : 4)}`}
                      className={`gum${recession ? " receded" : ""}`}
                    />

                    {/* Mobility indicator */}
                    {kinds.has("mobility") && !absent && (
                      <path
                        d={`M ${-w / 2 - 1},${ch * 0.2} q -3,6 0,12 M ${w / 2 + 1},${ch * 0.2} q 3,6 0,12`}
                        className="mobility"
                      />
                    )}

                    {/* Calculus band along gingival line */}
                    {kinds.has("calculus") && !absent && (
                      <line
                        x1={-w * 0.38}
                        y1={ch + 2}
                        x2={w * 0.38}
                        y2={ch + 2}
                        className="pano-calculus"
                      />
                    )}
                  </g>

                  {/* Tooth Numbering and Annotation Glyphs */}
                  <text x={cx} y={numY} className="ptooth-num">
                    {tooth}
                  </text>
                  {codes && (
                    <text x={cx} y={codesY} className="ptooth-code">
                      {codes}
                    </text>
                  )}
                  {nProc > 0 && <circle cx={cx - w / 2 + 5} cy={numY - 4} r="3" className="mk-proc" />}
                  {(data?.links?.planned ?? 0) > 0 && (
                    <path d={`M ${cx - w / 2 + 9},${numY - 1} l 3.5,-6 l 3.5,6 z`} className="mk-plan" />
                  )}
                  {nImg > 0 && <rect x={cx + w / 2 - 9} y={numY - 7} width="6" height="6" rx="1" className="mk-img" />}
                </g>
              );
            })
          )}
        </svg>
      </div>
    </div>
  );
}

/**
 * Enhanced Clinical Legend for Panoramic Tooth Chart.
 * Grouped into Pathology, Restorations, Periodontal/Anatomy, and Clinical Activity with interactive counts.
 */
export function PanoLegend({
  lang,
  teeth,
  activeFilter,
  onFilter,
}: {
  lang: Lang;
  teeth?: Record<number, ChartTooth>;
  activeFilter?: string | null;
  onFilter?: (filter: string | null) => void;
}) {
  const ar = lang === "ar";

  // Calculate live count per condition if teeth are provided
  const counts = useMemo(() => {
    if (!teeth) return null;
    let problems = 0, caries = 0, work = 0, rct = 0, lesion = 0, receded = 0, absent = 0, implant = 0, proc = 0, img = 0, plan = 0, nodata = 0;
    for (const t of Object.keys(teeth).map(Number)) {
      const d = teeth[t];
      if (!d || (!d.status && !d.findings.length && !d.links?.problems?.length)) {
        nodata++;
        continue;
      }
      if (d.links?.problems?.length) problems++;
      if ((d.links?.procedures ?? 0) > 0) proc++;
      if ((d.links?.images ?? 0) > 0) img++;
      if ((d.links?.planned ?? 0) > 0) plan++;
      if (d.status && ABSENT_STATUSES.has(d.status)) absent++;
      const kinds = new Set(d.findings.map((f) => f.kind));
      if (kinds.has("caries") || kinds.has("secondary_caries") || kinds.has("fracture")) caries++;
      if (kinds.has("filling") || kinds.has("crown") || kinds.has("bridge_abutment") || kinds.has("bridge_pontic")) work++;
      if (kinds.has("root_canal") || kinds.has("post_core")) rct++;
      if (kinds.has("periapical_lesion") || kinds.has("abscess")) lesion++;
      if (kinds.has("recession")) receded++;
      if (kinds.has("implant")) implant++;
    }
    return { problems, caries, work, rct, lesion, receded, absent, implant, proc, img, plan, nodata };
  }, [teeth]);

  const item = (svg: React.ReactNode, text: string, filterKey?: string, count?: number) => {
    const isFiltered = Boolean(activeFilter && activeFilter === filterKey);
    const content = (
      <>
        <span className="row" style={{ gap: ".45rem", alignItems: "center" }}>
          <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true" className="pano-legend-svg shrink-0">
            {svg}
          </svg>
          <span className="text-xs truncate">{text}</span>
        </span>
        {count != null && count > 0 && (
          <span className="pano-legend-badge font-mono shrink-0">
            <bdi>{count}</bdi>
          </span>
        )}
      </>
    );

    if (onFilter && filterKey) {
      return (
        <li>
          <button
            type="button"
            className="pano-legend-item"
            aria-pressed={isFiltered}
            onClick={() => onFilter(isFiltered ? null : filterKey)}
          >
            {content}
          </button>
        </li>
      );
    }
    return <li className="pano-legend-item">{content}</li>;
  };

  return (
    <div className="pano-legend-grid" dir={ar ? "rtl" : "ltr"}>
      {/* Group 1: Pathology & Open Problems */}
      <div className="pano-legend-sec">
        <h5 className="pano-legend-head">{ar ? "تشخيص وأمراض" : "Pathology & Problems"}</h5>
        <ul className="odonto-legend pano-legend" style={{ margin: 0, flexDirection: "column", gap: ".25rem" }}>
          {item(
            <rect x="2" y="2" width="18" height="12" rx="3" className="ptooth-problem" />,
            ar ? "مشكلة نشطة (تشخيص)" : "Open problem (diagnosis)",
            "problems",
            counts?.problems
          )}
          {item(
            <rect x="3" y="3" width="16" height="10" className="psurf disease" />,
            ar ? "تسوس أو كسر على السطح" : "Caries or fracture on surface",
            "disease",
            counts?.caries
          )}
          {item(
            <circle cx="11" cy="8" r="6" className="lesion" />,
            ar ? "آفة / خراج عند الذروة" : "Lesion / apical abscess",
            "rct",
            counts?.lesion
          )}
        </ul>
      </div>

      {/* Group 2: Restorations & Endodontics */}
      <div className="pano-legend-sec">
        <h5 className="pano-legend-head">{ar ? "علاجات وتعويضات" : "Restorations & Endo"}</h5>
        <ul className="odonto-legend pano-legend" style={{ margin: 0, flexDirection: "column", gap: ".25rem" }}>
          {item(
            <rect x="3" y="3" width="16" height="10" className="pano-work-legend" />,
            ar ? "حشوة أو تاج أو عمل موجود" : "Filling, crown or existing work",
            "work",
            counts?.work
          )}
          {item(
            <line x1="11" y1="1" x2="11" y2="15" className="canal rct" />,
            ar ? "علاج عصب (حشو القناة)" : "Root canal treatment",
            "rct",
            counts?.rct
          )}
          {item(
            <path d="M 8,2 L 14,2 L 13,14 L 9,14 Z" className="implant-legend" />,
            ar ? "زرعة سنية" : "Dental implant",
            "missing",
            counts?.implant
          )}
        </ul>
      </div>

      {/* Group 3: Periodontal & Anatomy */}
      <div className="pano-legend-sec">
        <h5 className="pano-legend-head">{ar ? "اللثة والفك" : "Periodontal & Anatomy"}</h5>
        <ul className="odonto-legend pano-legend" style={{ margin: 0, flexDirection: "column", gap: ".25rem" }}>
          {item(
            <path d="M 4,8 Q 11,3 18,8" className="gum receded" />,
            ar ? "انحسار اللثة" : "Gingival recession",
            "recession",
            counts?.receded
          )}
          {item(
            <path d="M 5,2 L 17,2 L 15,14 L 7,14 Z" className="ghost-legend" />,
            ar ? "مفقود أو مخلوع" : "Missing or extracted",
            "missing",
            counts?.absent
          )}
          {item(
            <rect x="3" y="3" width="16" height="10" className="nodata-legend" />,
            ar ? "لا بيانات فحص مسجلة" : "No exam data recorded",
            undefined,
            counts?.nodata
          )}
        </ul>
      </div>

      {/* Group 4: Clinical Tracking */}
      <div className="pano-legend-sec">
        <h5 className="pano-legend-head">{ar ? "الإجراءات والمتابعة" : "Clinical Activity"}</h5>
        <ul className="odonto-legend pano-legend" style={{ margin: 0, flexDirection: "column", gap: ".25rem" }}>
          {item(
            <circle cx="11" cy="8" r="3.5" className="mk-proc" />,
            ar ? "إجراء سريري مسجل" : "Procedure recorded",
            undefined,
            counts?.proc
          )}
          {item(
            <rect x="8" y="5" width="7" height="7" rx="1" className="mk-img" />,
            ar ? "صورة أو أشعة للسن" : "Image / X-ray linked",
            undefined,
            counts?.img
          )}
          {item(
            <path d="M 7.5,12 l 4,-7 l 4,7 z" className="mk-plan" />,
            ar ? "علاج مخطط بالخطة" : "Planned in treatment plan",
            "planned",
            counts?.plan
          )}
        </ul>
      </div>
    </div>
  );
}
