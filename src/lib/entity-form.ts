import type { EntityDef, FieldDef } from "@/lib/entities";
import { SOURCE } from "@/lib/labels";
import { UUID_RE } from "@/lib/uuid";
import { isPrecision, normalizePartialDate } from "@/lib/format";
import { parseTeeth } from "@/lib/dental";
import { boneLevelsFromForm } from "@/lib/dental-imaging";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and validates a submitted form against the entity definition. Unknown fields are ignored. */
export function parseEntityForm(def: EntityDef, fd: FormData, t: (ar: string, en: string) => string): { row: Record<string, unknown> } | { error: string; field?: string } {
  const row: Record<string, unknown> = {};
  // a form says which fields it showed (`_fields`); the others are left as they are instead of being cleared
  const shown = fd.has("_fields") ? new Set(String(fd.get("_fields")).split(",")) : null;
  const fields: FieldDef[] = [
    ...def.fields.filter((x) => !shown || shown.has(x.name)),
    { name: "source", ar: "المصدر", en: "Source", kind: "select", options: SOURCE },
    { name: "source_detail", ar: "تفاصيل المصدر", en: "Source detail", kind: "text", maxLength: 300 },
  ];
  for (const fld of fields) {
    const label = t(fld.ar, fld.en);
    if (fld.kind === "checkbox") { row[fld.name] = fd.get(fld.name) === "on"; continue; }
    if (fld.kind === "bonelevels") {
      const r = boneLevelsFromForm((n) => String(fd.get(n) ?? ""));
      if ("error" in r) return { error: t(`قراءة مستوى العظم غير صالحة: ${label}`, `Invalid bone level reading: ${label}`), field: fld.name };
      row[fld.name] = r.levels;
      continue;
    }
    const raw = String(fd.get(fld.name) ?? "").trim();
    if (raw === "") {
      if (fld.required) return { error: t(`الحقل مطلوب: ${label}`, `Required: ${label}`), field: fld.name };
      if (fld.name === "source") { row.source = "self"; continue; }
      row[fld.name] = null;
      if (fld.kind === "date" && fld.precision) row[fld.precision] = "day";
      continue;
    }
    switch (fld.kind) {
      case "text": case "textarea":
        if (raw.length > (fld.maxLength ?? 4000)) return { error: t(`النص طويل جداً: ${label}`, `Too long: ${label}`), field: fld.name };
        row[fld.name] = raw; break;
      case "date": {
        if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) return { error: t(`تاريخ غير صالح: ${label}`, `Invalid date: ${label}`), field: fld.name };
        if (!fld.precision) { row[fld.name] = raw; break; }
        const p = String(fd.get(fld.precision) ?? "day");
        if (!isPrecision(p)) return { error: t(`دقة تاريخ غير صالحة: ${label}`, `Invalid date precision: ${label}`), field: fld.name };
        row[fld.name] = normalizePartialDate(raw, p);
        row[fld.precision] = p;
        break;
      }
      case "datetime": {
        const d = new Date(raw);
        if (Number.isNaN(+d)) return { error: t(`وقت غير صالح: ${label}`, `Invalid time: ${label}`), field: fld.name };
        row[fld.name] = d.toISOString(); break;
      }
      case "number": {
        const n = Number(raw);
        if (!Number.isFinite(n) || (fld.min != null && n < fld.min) || (fld.max != null && n > fld.max)) return { error: t(`رقم غير صالح: ${label}`, `Invalid number: ${label}`), field: fld.name };
        row[fld.name] = n; break;
      }
      case "select":
        if (!fld.options?.some((o) => o.value === raw)) return { error: t(`اختيار غير صالح: ${label}`, `Invalid choice: ${label}`), field: fld.name };
        row[fld.name] = raw; break;
      case "teeth": {
        const teeth = parseTeeth(raw);
        if (!teeth) return { error: t(`أرقام أسنان غير صالحة (FDI: 11–48، اللبنية 51–85): ${label}`, `Invalid tooth numbers (FDI: 11–48, primary 51–85): ${label}`), field: fld.name };
        row[fld.name] = teeth.length ? teeth : null; break;
      }
      case "imaging_order":
        if (!UUID_RE.test(raw)) return { error: t("طلب تصوير غير صالح.", "Invalid imaging request."), field: fld.name };
        row[fld.name] = raw; break;
      case "specialty":
        if (!UUID_RE.test(raw)) return { error: t(`تخصص غير صالح`, `Invalid specialty`), field: fld.name };
        row[fld.name] = raw; break;
      case "link":
        if (!UUID_RE.test(raw)) return { error: t(`ارتباط غير صالح: ${label}`, `Invalid link: ${label}`), field: fld.name };
        row[fld.name] = raw; break;
    }
  }
  return { row };
}
