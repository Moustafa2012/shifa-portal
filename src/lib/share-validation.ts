import { localDate } from "@/lib/format";
import { UUID_RE } from "@/lib/uuid";

/*
 * The rules for everything a doctor can type, draw or upload through a share link, written once (pure, no I/O) and used
 * by three layers: the forms (HTML attributes and hints), the server actions (the authority in the web tier) and the unit
 * tests. The database repeats the same rules in the security-definer share_* functions (migration 0033), so a request that
 * skips the web tier meets them again. Messages name the field and never carry SQL text, stack traces or ids.
 */

type T = (ar: string, en: string) => string;

export interface FieldError { field: string; code: ErrorCode; message: string }
export type ErrorCode =
  | "required" | "blank" | "control" | "markup" | "short" | "long" | "format" | "enum"
  | "date_invalid" | "date_old" | "date_dob" | "date_future" | "date_past" | "date_far" | "date_range" | "date_order"
  | "number" | "range" | "precision" | "uuid" | "teeth" | "keys";

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- limits
export const MIN_DATE = "1900-01-01";
/** how far ahead a scheduled thing (appointment, follow-up, scheduled treatment) may be: ten years */
export const MAX_AHEAD_DAYS = 3650;
export const BURST_PER_MINUTE = 30;
export const MAX_NAME = 200;
export const MAX_TITLE = 200;
export const MAX_TEXT = 4000;
export const MAX_NOTE = 20000;
/** uploads through one link: how many files, and how many bytes in all */
export const MAX_SHARE_UPLOADS = 25;
export const MAX_SHARE_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 12000;                    // px: a panoramic is ~3000 wide; this refuses decompression bombs
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_FILENAME = 120;
export const MAX_SIGNATURE_BYTES = 400_000;
export const MAX_SIGNATURE_SIDE = 4000;
export const MIN_SIGNATURE_INK = 60;                    // drawn pixels
export const MIN_SIGNATURE_EXTENT = 12;                 // px in the longer side of the drawing

// ---------------------------------------------------------------- text
/** C0 controls and DEL, except tab / line feed / carriage return */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** every control character, including tab and line breaks (single-line fields) */
const LINE_CONTROL_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;
/** bidirectional overrides can make a stored name display as someone else's */
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;
const TAG_RE = /<\s*\/?\s*[A-Za-z!?]/;
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits (and the Arabic decimal / thousands marks) to plain ASCII, so a number is stored canonically. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/٫/g, ".").replace(/٬/g, "");
}

/** Keys that must never travel in a JSON payload: they only exist to pollute prototypes. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function hasUnsafeKey(v: unknown, depth = 0): boolean {
  if (depth > 12 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasUnsafeKey(x, depth + 1));
  for (const k of Object.keys(v as object)) if (UNSAFE_KEYS.has(k) || hasUnsafeKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  return false;
}
/** JSON.parse that refuses prototype-polluting keys and anything that is not valid JSON; null on refusal. */
export function parseJsonSafe(raw: string): unknown | null {
  try { const v = JSON.parse(raw); return hasUnsafeKey(v) ? null : v; } catch { return null; }
}

export type TextKind = "name" | "line" | "text";
export interface TextRule { kind: TextKind; min?: number; max: number }
export const NAME = (max = MAX_NAME, min = 2): TextRule => ({ kind: "name", min, max });
export const LINE = (max = MAX_TITLE, min = 1): TextRule => ({ kind: "line", min, max });
export const TEXT = (max = MAX_TEXT, min = 1): TextRule => ({ kind: "text", min, max });

const msgs: Record<ErrorCode, [string, string]> = {
  required: ["الحقل مطلوب: {f}.", "{f} is required."],
  blank: ["{f}: لا يُقبل نص من الفراغات فقط.", "{f}: text made only of spaces is not accepted."],
  control: ["{f}: يحتوي رموزاً غير مسموحة (رموز تحكم).", "{f}: contains characters that are not allowed (control characters)."],
  markup: ["{f}: لا تُقبل الرموز < و > (لا نقبل وسوماً).", "{f}: the characters < and > (markup) are not accepted."],
  short: ["{f}: قصير جداً (الحد الأدنى {n} أحرف).", "{f}: too short (at least {n} characters)."],
  long: ["{f}: طويل جداً (الحد الأقصى {n} حرفاً).", "{f}: too long (at most {n} characters)."],
  format: ["{f}: الصيغة غير صحيحة.", "{f}: the format is not valid."],
  enum: ["{f}: اختيار غير مسموح.", "{f}: that choice is not allowed."],
  date_invalid: ["{f}: تاريخ غير صالح (تحقق من اليوم والشهر).", "{f}: not a valid date (check the day and month)."],
  date_old: ["{f}: التاريخ قبل 1900.", "{f}: the date is before 1900."],
  date_dob: ["{f}: التاريخ قبل ميلاد المريض.", "{f}: the date is before the patient was born."],
  date_future: ["{f}: التاريخ في المستقبل.", "{f}: the date is in the future."],
  date_past: ["{f}: يجب أن يكون التاريخ اليوم أو لاحقاً.", "{f}: the date must be today or later."],
  date_far: ["{f}: التاريخ بعيد جداً (حتى 10 سنوات).", "{f}: the date is too far ahead (10 years at most)."],
  date_range: ["{f}: خارج الفترة التي تشملها المشاركة ({r}).", "{f}: outside the period this share covers ({r})."],
  date_order: ["{f}: يجب ألا يسبق {o}.", "{f}: must not be earlier than {o}."],
  number: ["{f}: أدخل رقماً صحيحاً.", "{f}: enter a valid number."],
  range: ["{f}: القيمة خارج المدى ({r}).", "{f}: the value is out of range ({r})."],
  precision: ["{f}: عدد المنازل العشرية كبير (الحد الأقصى {n}).", "{f}: too many decimal places (at most {n})."],
  uuid: ["{f}: معرّف غير صالح.", "{f}: invalid reference."],
  teeth: ["{f}: أرقام أسنان غير صالحة (FDI: 11–48 للدائمة، 51–85 للبنية).", "{f}: invalid tooth numbers (FDI: 11–48 permanent, 51–85 primary)."],
  keys: ["بيانات غير متوقعة في الطلب.", "Unexpected data in the request."],
};
export function fieldError(t: T, field: string, label: string, code: ErrorCode, p: { n?: number; r?: string; o?: string } = {}): FieldError {
  const [ar, en] = msgs[code];
  const fill = (s: string) => s.replace("{f}", label).replace("{n}", String(p.n ?? "")).replace("{r}", p.r ?? "").replace("{o}", p.o ?? "");
  return { field, code, message: t(fill(ar), fill(en)) };
}

/** The raw text rules, without messages: the code of the first failure, or null. `raw` is what the form sent (not yet trimmed). */
export function textProblem(raw: string, rule: TextRule, required: boolean): ErrorCode | null {
  const text = raw.replace(/\r\n?/g, "\n");
  if (rule.kind === "text" ? CONTROL_RE.test(text) : LINE_CONTROL_RE.test(text)) return "control";
  if (BIDI_RE.test(text)) return "control";
  const v = text.trim();
  if (v === "") return text.length > 0 ? "blank" : required ? "required" : null;
  if (rule.kind === "name" && /[<>]/.test(v)) return "markup";
  if (rule.kind !== "name" && TAG_RE.test(v)) return "markup";
  if (v.length < (rule.min ?? 1)) return "short";
  if (v.length > rule.max) return "long";
  return null;
}
/** Validates and cleans a text value. An empty optional field gives null. */
export function checkText(raw: unknown, rule: TextRule, field: string, label: string, t: T, required = false): { value: string | null } | { error: FieldError } {
  if (raw === undefined || raw === null) raw = "";
  if (typeof raw !== "string") return { error: fieldError(t, field, label, "format") };
  const code = textProblem(raw, rule, required);
  if (code) return { error: fieldError(t, field, label, code, { n: code === "short" ? rule.min : rule.max }) };
  const v = raw.replace(/\r\n?/g, "\n").trim();
  return { value: v === "" ? null : v };
}

// ---------------------------------------------------------------- numbers
export interface NumberRule { min: number; max: number; int?: boolean; decimals?: number }
/** "٣٧٫٥" and "37.5" are the same number; exponents, "NaN", "Infinity", hex and thousands separators are refused. */
export function parseNumber(raw: unknown, rule: NumberRule): { value: number } | { code: "number" | "range" | "precision" } {
  if (typeof raw === "number") raw = String(raw);
  if (typeof raw !== "string") return { code: "number" };
  const s = normalizeDigits(raw.trim());
  if (!/^-?\d{1,15}(\.\d{1,12})?$/.test(s)) return { code: "number" };
  const n = Number(s);
  if (!Number.isFinite(n)) return { code: "number" };
  if (rule.int && !Number.isInteger(n)) return { code: "number" };
  const dec = s.includes(".") ? s.split(".")[1].replace(/0+$/, "").length : 0;
  if (rule.decimals !== undefined && dec > rule.decimals) return { code: "precision" };
  if (n < rule.min || n > rule.max) return { code: "range" };
  return { value: n };
}
export function checkNumber(raw: unknown, rule: NumberRule, field: string, label: string, t: T, required = false): { value: number | null } | { error: FieldError } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return required ? { error: fieldError(t, field, label, "required") } : { value: null };
  const r = parseNumber(raw, rule);
  if ("code" in r) return { error: fieldError(t, field, label, r.code, { r: `${rule.min}–${rule.max}`, n: rule.decimals }) };
  return { value: r.value };
}

// ---------------------------------------------------------------- dates
const daysIn = (y: number, m: number) => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
/** A real calendar date: "2026-02-30" is refused (the platform's Date.parse would roll it into March in some engines). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface DateCtx {
  /** the viewer's local date */
  today: string;
  dob?: string | null;
  /** the period the share covers, when it limits one */
  from?: string | null;
  to?: string | null;
}
export type DateWhen = "past" | "future";
export type DateCode = "date_invalid" | "date_old" | "date_dob" | "date_future" | "date_past" | "date_far" | "date_range";

/**
 * An event date. "past": not after today. "future": today or later (appointments, follow-ups, scheduled treatments), at most ten
 * years ahead. Never before 1900 or before the patient was born; a past event must lie inside the period the share covers.
 */
export function dateProblem(v: unknown, when: DateWhen, ctx: DateCtx): DateCode | null {
  if (!isCalendarDate(v)) return "date_invalid";
  if (v < MIN_DATE) return "date_old";
  if (ctx.dob && v < ctx.dob) return "date_dob";
  if (when === "past") {
    if (v > ctx.today) return "date_future";
    if ((ctx.from && v < ctx.from) || (ctx.to && v > ctx.to)) return "date_range";
  } else {
    if (v < ctx.today) return "date_past";
    if (v > addDays(ctx.today, MAX_AHEAD_DAYS)) return "date_far";
  }
  return null;
}
export const rangeText = (ctx: DateCtx) => `${ctx.from ?? "…"} → ${ctx.to ?? "…"}`;
export function checkDate(v: unknown, when: DateWhen, ctx: DateCtx, field: string, label: string, t: T): FieldError | null {
  const code = dateProblem(v, when, ctx);
  return code ? fieldError(t, field, label, code, { r: rangeText(ctx) }) : null;
}
/** The calendar date, in the viewer's time zone, of an ISO instant; null when it is not an instant. */
export function instantDate(iso: unknown, tz: string): string | null {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) return null;
  const d = new Date(iso);
  return Number.isNaN(+d) || !isCalendarDate(iso.slice(0, 10)) ? null : localDate(d, tz);
}
/** An instant ("when did it happen"): past ones may be at most five minutes ahead of the clock (clock skew). */
export function checkInstant(iso: unknown, when: DateWhen, ctx: DateCtx, tz: string, field: string, label: string, t: T, nowMs = Date.now()): FieldError | null {
  const day = instantDate(iso, tz);
  if (!day) return fieldError(t, field, label, "date_invalid");
  if (when === "past" && Date.parse(String(iso)) > nowMs + 5 * 60_000) return fieldError(t, field, label, "date_future");
  const code = dateProblem(day, when === "past" ? "past" : "future", { ...ctx, today: when === "past" ? addDays(ctx.today, 1) : ctx.today });
  return code ? fieldError(t, field, label, code, { r: rangeText(ctx) }) : null;
}
export function checkOrder(later: string | null | undefined, earlier: string | null | undefined, field: string, label: string, otherLabel: string, t: T): FieldError | null {
  return later && earlier && later < earlier ? fieldError(t, field, label, "date_order", { o: otherLabel }) : null;
}

// ---------------------------------------------------------------- ids
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// ---------------------------------------------------------------- the fields a doctor fills, per table
interface CF { text?: TextRule; icd?: boolean; example?: [string, string]; unit?: [string, string]; auto?: string; input?: "tel" }
const N = (r: TextRule, extra: Partial<CF> = {}): CF => ({ text: r, ...extra });
const ex = (ar: string, en: string): [string, string] => [ar, en];

/** The text fields of each table a link can add to; the other kinds (selects, dates, teeth) are checked against the entity definition. */
export const CONTRIB_FIELDS: Record<string, Record<string, CF>> = {
  encounters: {
    facility_name: N(NAME()), practitioner_name: N(NAME()), reason: N(LINE(300, 2), { example: ex("مثال: ألم في الضرس السفلي", "e.g. pain in a lower molar") }),
    symptoms: N(TEXT()), history_of_present_illness: N(TEXT()), examination: N(TEXT()), assessment: N(TEXT()), plan: N(TEXT()), summary: N(TEXT()),
    anesthetic: N(LINE(300), { example: ex("أرتيكائين 4% — أمبولتان", "Articaine 4% — 2 cartridges") }), materials: N(LINE(1000)), complications: N(TEXT()), instructions: N(TEXT()),
  },
  conditions: {
    name: N(LINE(200, 2), { example: ex("مثال: تسوس عميق في الضرس 16", "e.g. deep caries, tooth 16") }),
    icd10_code: { icd: true, text: LINE(12), example: ex("مثال: K02.1", "e.g. K02.1") }, notes: N(TEXT()),
  },
  procedures: {
    name: N(LINE(200, 2), { example: ex("مثال: حشوة ضوئية", "e.g. composite filling") }), body_site: N(LINE(200)), facility_name: N(NAME()), operator_name: N(NAME()),
    anesthesia: N(LINE(200)), indication: N(LINE(500)), outcome: N(TEXT()), complications: N(TEXT()), notes: N(TEXT()),
  },
  clinical_notes: { title: N(LINE(200)), body: N(TEXT(MAX_NOTE)), author_name: N(NAME()) },
  medications: {
    name_generic: N(LINE(200, 2), { example: ex("مثال: أموكسيسيلين", "e.g. amoxicillin") }), name_brand: N(LINE(200, 2)), strength: N(LINE(60), { example: ex("مثال: 500 ملغ", "e.g. 500 mg") }),
    dose: N(LINE(100), { example: ex("مثال: كبسولة واحدة", "e.g. 1 capsule") }), frequency: N(LINE(100), { example: ex("مثال: ثلاث مرات يومياً", "e.g. three times a day") }),
    indication: N(LINE(500)), prescriber_name: N(NAME()), instructions: N(TEXT(2000)), adverse_effects: N(TEXT(2000)), notes: N(TEXT()),
  },
  appointments: { facility_name: N(NAME()), practitioner_name: N(NAME()), reason: N(LINE(300, 2), { example: ex("مثال: مراجعة بعد الحشو", "e.g. review after the filling") }), notes: N(TEXT()) },
  test_orders: { name: N(LINE(200, 2), { example: ex("مثال: صورة بانورامية", "e.g. panoramic X-ray") }), ordered_by: N(NAME()), reason: N(TEXT(2000)), notes: N(TEXT()) },
  imaging_studies: { body_site: N(LINE(200)), facility_name: N(NAME()), radiologist_name: N(NAME()), findings: N(TEXT()), impression: N(TEXT()) },
};
/** The fields of each table that are not free text (choices, dates, flags, teeth, links); with CONTRIB_FIELDS they are everything a doctor may send. */
export const CONTRIB_OTHER: Record<string, string[]> = {
  encounters: ["kind", "status", "started_at", "ended_at", "follow_up_date", "teeth", "anesthesia_kind"],
  conditions: ["category", "clinical_status", "certainty", "severity", "onset_date", "date_precision", "resolved_date", "sensitive", "encounter_id", "teeth", "evidence", "specialty_id"],
  procedures: ["kind", "performed_on", "date_precision", "encounter_id", "teeth", "specialty_id"],
  clinical_notes: ["kind", "noted_at", "encounter_id", "specialty_id"],
  medications: ["form", "route", "as_needed", "origin", "status", "start_date", "date_precision", "end_date", "sensitive", "encounter_id", "specialty_id"],
  appointments: ["scheduled_at", "status", "encounter_id", "specialty_id"],
  test_orders: ["kind", "priority", "status", "requested_on", "encounter_id", "specialty_id"],
  imaging_studies: ["modality", "performed_on", "date_precision", "encounter_id", "teeth", "bone_levels", "specialty_id"],
};
/** every field name a doctor may send for a table (the database refuses any other key) */
export function contribAllowed(table: string): Set<string> {
  return new Set([...Object.keys(own(CONTRIB_FIELDS, table) ? CONTRIB_FIELDS[table] : {}), ...(own(CONTRIB_OTHER, table) ? CONTRIB_OTHER[table] : [])]);
}
const ICD_RE = /^[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?$/;

/** The hints and HTML attributes a form puts on one field, from the same rules the server applies. */
export interface FieldHints { minLength?: number; maxLength?: number; pattern?: string; title?: string; example?: string; autoComplete?: string; dateMin?: string; dateMax?: string; unit?: string; spellCheck?: boolean }
export function fieldHints(table: string, name: string, lang: "ar" | "en", ctx?: DateCtx, kind?: "date" | "datetime", whenFuture = false): FieldHints | undefined {
  const f = CONTRIB_FIELDS[table]?.[name];
  const i = lang === "ar" ? 0 : 1;
  const h: FieldHints = {};
  if (f?.text) {
    h.maxLength = f.text.max; if ((f.text.min ?? 1) > 1) h.minLength = f.text.min;
    if (f.text.kind === "name") h.autoComplete = "off";
  }
  if (f?.icd) { h.pattern = ICD_RE.source; h.title = lang === "ar" ? "رمز ICD-10، مثل K02.1" : "An ICD-10 code, e.g. K02.1"; }
  if (f?.example) h.example = f.example[i];
  if (kind && ctx) {
    const lo = [MIN_DATE, ctx.dob ?? ""].sort().pop()!;
    if (whenFuture) { h.dateMin = ctx.today; h.dateMax = addDays(ctx.today, MAX_AHEAD_DAYS); }
    else { h.dateMin = [lo, ctx.from ?? ""].sort().pop()!; h.dateMax = ctx.to && ctx.to < ctx.today ? ctx.to : ctx.today; }
  }
  return Object.keys(h).length ? h : undefined;
}

/** Which fields of a table take a date that lies in the past or the future, depending on the status chosen. */
const DATE_FIELDS: Record<string, { name: string; kind: "date" | "instant"; label: [string, string]; future?: (row: Record<string, unknown>) => boolean }[]> = {
  encounters: [
    { name: "started_at", kind: "instant", label: ["بداية الزيارة", "Visit start"], future: (r) => r.status === "planned" },
    { name: "ended_at", kind: "instant", label: ["نهاية الزيارة", "Visit end"], future: (r) => r.status === "planned" },
    { name: "follow_up_date", kind: "date", label: ["موعد المتابعة", "Follow-up date"], future: () => true },
  ],
  conditions: [
    { name: "onset_date", kind: "date", label: ["تاريخ البداية", "Onset date"] },
    { name: "resolved_date", kind: "date", label: ["تاريخ الشفاء / الانتهاء", "Resolved date"] },
  ],
  procedures: [{ name: "performed_on", kind: "date", label: ["تاريخ الإجراء", "Date"] }],
  clinical_notes: [{ name: "noted_at", kind: "instant", label: ["وقت الملاحظة", "Noted at"] }],
  medications: [
    { name: "start_date", kind: "date", label: ["تاريخ البدء", "Start date"] },
    { name: "end_date", kind: "date", label: ["تاريخ الإيقاف", "Stop date"], future: () => true },
  ],
  appointments: [{ name: "scheduled_at", kind: "instant", label: ["موعد الحضور", "Scheduled for"], future: (r) => (r.status ?? "scheduled") === "scheduled" }],
  test_orders: [{ name: "requested_on", kind: "date", label: ["تاريخ الطلب", "Requested on"] }],
  imaging_studies: [{ name: "performed_on", kind: "date", label: ["تاريخ الفحص", "Date"] }],
};
/** pairs that must be in order: [later, earlier] */
const ORDERS: Record<string, [string, string, [string, string]][]> = {
  encounters: [["ended_at", "started_at", ["بداية الزيارة", "the visit start"]]],
  conditions: [["resolved_date", "onset_date", ["تاريخ البداية", "the onset date"]]],
  medications: [["end_date", "start_date", ["تاريخ البدء", "the start date"]]],
};
/** whether a date field of this table (given the current form values) is a scheduled one */
export function isFutureField(table: string, name: string, row: Record<string, unknown> = {}): boolean {
  return Boolean(DATE_FIELDS[table]?.find((d) => d.name === name)?.future?.(row));
}

/** Pre-pass over the raw text of a submitted form (before it is parsed): control characters, markup, blank, lengths. */
export function checkContributionText(table: string, get: (name: string) => string, shown: Set<string> | null, labelOf: (name: string) => string, t: T, requiredOf: (name: string) => boolean): FieldError | null {
  const rules = CONTRIB_FIELDS[table];
  if (!rules) return null;
  for (const [name, f] of Object.entries(rules)) {
    if (shown && !shown.has(name)) continue;
    const raw = get(name);
    const label = labelOf(name);
    const r = checkText(raw, f.text!, name, label, t, requiredOf(name));
    if ("error" in r) return r.error;
    if (f.icd && r.value && !ICD_RE.test(r.value)) return fieldError(t, name, label, "format");
  }
  return null;
}
/** After parsing: the dates of a record (calendar, past or future, patient's birth, period of the share, order). */
export function checkContributionDates(table: string, row: Record<string, unknown>, ctx: DateCtx, tz: string, t: T): FieldError | null {
  const fields = DATE_FIELDS[table] ?? [];
  for (const f of fields) {
    const v = row[f.name];
    if (v === null || v === undefined || v === "") continue;
    const label = t(...f.label);
    const when: DateWhen = f.future?.(row) ? "future" : "past";
    // a stop date may be in the future (a planned course) but not far ahead; a follow-up is checked against the visit date below
    const err = f.kind === "instant" ? checkInstant(v, when, ctx, tz, f.name, label, t) : checkDate(v, when, ctx, f.name, label, t);
    if (err) return err;
  }
  for (const [later, earlier, otherLabel] of ORDERS[table] ?? []) {
    const lv = row[later], ev = row[earlier];
    const l = typeof lv === "string" ? lv : null, e = typeof ev === "string" ? ev : null;
    if (l && e && l < e) return fieldError(t, later, t(...(fields.find((x) => x.name === later)?.label ?? [later, later])), "date_order", { o: t(...otherLabel) });
  }
  // a follow-up is on or after the visit it follows
  if (table === "encounters" && typeof row.follow_up_date === "string" && typeof row.started_at === "string") {
    const day = instantDate(row.started_at, tz);
    if (day && row.follow_up_date < day) return fieldError(t, "follow_up_date", t("موعد المتابعة", "Follow-up date"), "date_order", { o: t("يوم الزيارة", "the visit date") });
  }
  return null;
}

// ---------------------------------------------------------------- the clinician's identity (when the link does not name them)
export interface Identity { full_name: string; specialty: string | null; license_no: string | null; facility: string | null; phone: string | null }
export function validateIdentity(get: (k: string) => string, t: T): { value: Identity } | { error: FieldError } {
  const name = checkText(get("full_name"), NAME(120, 3), "full_name", t("الاسم الكامل", "Full name"), t, true);
  if ("error" in name) return name;
  const spec = checkText(get("specialty"), LINE(120), "specialty", t("التخصص", "Specialty"), t);
  if ("error" in spec) return spec;
  const lic = checkText(get("license_no"), LINE(60), "license_no", t("رقم الترخيص", "License number"), t);
  if ("error" in lic) return lic;
  if (lic.value && !/^[A-Za-z0-9][A-Za-z0-9 ./_-]{1,59}$/.test(lic.value)) return { error: fieldError(t, "license_no", t("رقم الترخيص", "License number"), "format") };
  const fac = checkText(get("facility"), NAME(), "facility", t("العيادة / المنشأة", "Clinic / facility"), t);
  if ("error" in fac) return fac;
  const phone = checkPhone(get("phone"), "phone", t("الهاتف", "Phone"), t);
  if ("error" in phone) return phone;
  return { value: { full_name: name.value!, specialty: spec.value, license_no: lic.value, facility: fac.value, phone: phone.value } };
}
/** A phone number: digits (Arabic digits are accepted and stored as ASCII), an optional leading +, spaces, dashes and brackets; 7 to 15 digits. */
export function checkPhone(raw: string, field: string, label: string, t: T): { value: string | null } | { error: FieldError } {
  const s = normalizeDigits(raw.trim());
  if (s === "") return { value: null };
  if (!/^\+?[0-9 ()-]{6,24}$/.test(s)) return { error: fieldError(t, field, label, "format") };
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { error: fieldError(t, field, label, "format") };
  return { value: s };
}

/** The reason given when something is withdrawn or amended: 3 to the limit characters, a line. */
export function checkReason(raw: string, field: string, t: T, max = 400): { value: string } | { error: FieldError } {
  const r = checkText(raw, LINE(max, 3), field, t("السبب", "Reason"), t, true);
  return "error" in r ? r : { value: r.value! };
}

// ---------------------------------------------------------------- a treatment cost
export const COST_RULE: NumberRule = { min: 0, max: 9_999_999_999, decimals: 2 };
export function checkCost(amountRaw: string, t: T): { value: number } | { error: FieldError } {
  const r = checkNumber(amountRaw, COST_RULE, "amount", t("المبلغ", "Amount"), t, true);
  return "error" in r ? r : { value: r.value! };
}

// ---------------------------------------------------------------- a prescription line: what makes it complete
export interface RxLineCheck { name_generic?: unknown; name_brand?: unknown; strength?: unknown; dose?: unknown; frequency?: unknown; duration_days?: unknown; as_needed?: unknown }
/** A line needs a medicine name, a dose or strength, a frequency (or "as needed") and a duration of 1 to 3650 days. */
export function rxLineProblem(l: RxLineCheck): "name" | "dose" | "frequency" | "duration" | null {
  if (!l.name_generic && !l.name_brand) return "name";
  if (!l.dose && !l.strength) return "dose";
  if (!l.frequency && !l.as_needed) return "frequency";
  const d = Number(l.duration_days);
  if (!Number.isInteger(d) || d < 1 || d > 3650) return "duration";
  return null;
}

// ---------------------------------------------------------------- files
export type UploadCode = "no_file" | "too_large" | "empty" | "bad_type" | "ext_mismatch" | "active_content" | "image_too_big" | "bad_name" | "limit_files" | "limit_bytes" | "bad_form";
export const UPLOAD_MESSAGES: Record<UploadCode, [string, string]> = {
  no_file: ["اختر ملفاً.", "Choose a file."],
  too_large: ["الملف أكبر من 20 ميغابايت.", "The file is larger than 20 MB."],
  empty: ["الملف فارغ.", "The file is empty."],
  bad_type: ["نوع الملف غير مسموح (PDF أو JPG أو PNG أو WebP).", "File type not allowed (PDF, JPG, PNG or WebP)."],
  ext_mismatch: ["امتداد الملف لا يطابق محتواه.", "The file extension does not match its content."],
  active_content: ["رُفض ملف PDF لاحتوائه على محتوى نشط.", "This PDF was rejected because it contains active content."],
  image_too_big: ["أبعاد الصورة كبيرة جداً.", "The image dimensions are too large."],
  bad_name: ["اسم الملف غير صالح.", "The file name is not valid."],
  limit_files: ["بلغت هذه المشاركة الحد الأقصى لعدد الملفات المرفوعة.", "This share has reached its limit of uploaded files."],
  limit_bytes: ["بلغت هذه المشاركة الحد الأقصى لحجم الملفات المرفوعة.", "This share has reached its limit of uploaded file size."],
  bad_form: ["بيانات النموذج غير صالحة.", "The form data is not valid."],
};
const EXT_OK: Record<string, string[]> = { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg", "jpe"], "image/png": ["png"], "image/webp": ["webp"] };
/** A file name as stored: no path, no controls, no leading dots, bounded. Never used as a path. */
export function sanitizeFilename(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.normalize("NFC").replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[. ]+/, "").trim().slice(0, MAX_FILENAME);
  return clean || "file";
}
/** The extension in the name must be one the sniffed content allows (name, content and declared type must agree). */
export function extensionMatches(name: string, mime: string, declared?: string): boolean {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1].toLowerCase();
  if (!ext) return true;                                     // no extension: the content decides
  if (!(EXT_OK[mime] ?? []).includes(ext)) return false;
  return !declared || declared === "application/octet-stream" || declared === mime || (mime === "image/jpeg" && declared === "image/jpg");
}
/** Width and height from the header of a PNG, JPEG or WebP, or null when the header cannot be read. */
export function imageSize(b: Uint8Array, mime: string): { w: number; h: number } | null {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (mime === "image/png") return b.length >= 24 ? { w: u32(16), h: u32(20) } : null;
  if (mime === "image/webp") {
    if (b.length < 30) return null;
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (tag === "VP8 ") return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (tag === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) }; }
    return null;
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  return null;
}
export interface UploadInput { name: unknown; size: number; bytes: Uint8Array; declaredMime?: string; sniff: (b: Uint8Array) => string | null; activePdf: (b: Uint8Array) => boolean; maxBytes: number }
/** Everything about one uploaded file that can be decided from the file itself; the per-share totals are checked by the database. */
export function checkUpload(f: UploadInput): { mime: string; filename: string; size: { w: number; h: number } | null } | { code: UploadCode } {
  if (f.size === 0 || f.bytes.length === 0) return { code: "empty" };
  if (f.size > f.maxBytes || f.bytes.length > f.maxBytes) return { code: "too_large" };
  const mime = f.sniff(f.bytes);
  if (!mime) return { code: "bad_type" };
  const filename = sanitizeFilename(f.name);
  if (typeof f.name === "string" && /[\u0000]/.test(f.name)) return { code: "bad_name" };
  if (!extensionMatches(filename, mime, f.declaredMime)) return { code: "ext_mismatch" };
  if (mime === "application/pdf" && f.activePdf(f.bytes)) return { code: "active_content" };
  let size: { w: number; h: number } | null = null;
  if (mime !== "application/pdf") {
    size = imageSize(f.bytes, mime);
    if (!size || size.w < 1 || size.h < 1) return { code: "bad_type" };
    if (size.w > MAX_IMAGE_SIDE || size.h > MAX_IMAGE_SIDE || size.w * size.h > MAX_IMAGE_PIXELS) return { code: "image_too_big" };
  }
  return { mime, filename, size };
}

// ---------------------------------------------------------------- the database's reasons ("field:code") in words
const REASON_LABELS: Record<string, [string, string]> = {
  exam_date: ["تاريخ الفحص", "Exam date"], issued_on: ["تاريخ الوصفة", "Prescription date"], document_date: ["تاريخ المستند", "Document date"], date: ["التاريخ", "Date"],
  amount: ["المبلغ", "Amount"], currency: ["العملة", "Currency"], kind: ["النوع", "Type"], status: ["الحالة", "Status"], reason: ["السبب", "Reason"], body: ["النص", "Text"],
  title: ["العنوان", "Title"], note: ["الملاحظة", "Note"], notes: ["الملاحظات", "Notes"], teeth: ["الأسنان", "Teeth"], surfaces: ["الأسطح", "Surfaces"], phase: ["المرحلة", "Phase"],
  depth: ["قياسات اللثة", "Gum measurements"], signer_name: ["اسم الموقّع", "Signer name"], signer_role: ["صفة الموقّع", "Signer role"], witness_name: ["اسم الشاهد", "Witness name"],
  author_name: ["اسمك", "Your name"], full_name: ["الاسم الكامل", "Full name"], specialty: ["التخصص", "Specialty"], license_no: ["رقم الترخيص", "License number"],
  facility: ["العيادة / المنشأة", "Clinic / facility"], phone: ["الهاتف", "Phone"], file: ["الملف", "File"], doc_type: ["نوع المستند", "Document type"],
  title_: ["العنوان", "Title"], plan: ["الخطة", "Plan"], item: ["العلاج", "Treatment"], catalog_code: ["الإجراء", "Procedure"], signature: ["التوقيع", "Signature"],
  dx_rbl_pct: ["فقد العظم %", "Bone loss %"], dx_teeth_lost_perio: ["الأسنان المفقودة لثوياً", "Teeth lost to gum disease"], dentition: ["الأسنان", "Dentition"],
  encounter_id: ["الزيارة", "Visit"], rx: ["الوصفة", "Prescription"], consent: ["الموافقة", "Consent"], exam: ["الفحص", "Exam"], payload: ["البيانات", "Data"],
  tooth_note: ["ملاحظة السن", "Tooth note"], finding_notes: ["ملاحظات الموجود", "Finding notes"], pulp_note: ["نتيجة اختبار الحيوية", "Pulp test result"],
};
/** Field names of the forms (the input `name`) behind a reason's field, when they differ. */
const REASON_INPUT: Record<string, string> = { tooth_note: "states", finding_notes: "findings", pulp_note: "pulp_tests", depth: "teeth", signature: "signature", item: "name" };
export interface Explained { error: string; field?: string }
/**
 * Words for a reason from the database ("onset_date:date_future"). `labels` names fields of the form being filled; a reason on a
 * prescription line ("l0_dose:required") says which line. Nothing of the reason is shown except the label: no SQL, no ids.
 */
export function explainReason(reason: string | undefined, t: T, labels: Record<string, [string, string]> = {}): Explained {
  const [rawField, code = ""] = String(reason ?? "").split(":");
  const line = /^l(\d+)_(.+)$/.exec(rawField);
  const key = line ? line[2] : rawField;
  const base = own(labels, key) ? labels[key] : own(REASON_LABELS, key) ? REASON_LABELS[key] : undefined;
  const label = base ? t(...base) : t("حقل", "A field");
  const where = line ? t(`السطر ${Number(line[1]) + 1}: ${label}`, `Line ${Number(line[1]) + 1}: ${label}`) : label;
  const input = line ? rawField : own(REASON_INPUT, rawField) ? REASON_INPUT[rawField] : rawField;
  if (code === "keys") return { error: t(...msgs.keys) };
  const plain: Partial<Record<ErrorCode, [string, string]>> = {
    short: ["{f}: قصير جداً.", "{f}: too short."], long: ["{f}: طويل جداً.", "{f}: too long."], range: ["{f}: القيمة خارج المدى المسموح.", "{f}: the value is out of the allowed range."],
    date_range: ["{f}: خارج الفترة التي تشملها المشاركة.", "{f}: outside the period this share covers."], date_order: ["{f}: ترتيب التواريخ غير صحيح.", "{f}: the dates are not in order."],
    precision: ["{f}: عدد المنازل العشرية كبير.", "{f}: too many decimal places."],
  };
  const field = /^[a-z][a-z0-9_]*$/.test(input) ? input : undefined;
  const p = own(plain, code) ? plain[code as ErrorCode] : undefined;
  if (p) return { error: t(p[0].replace("{f}", where), p[1].replace("{f}", where)), field };
  if (own(msgs, code)) return { error: fieldError(t, input, where, code as ErrorCode).message, field };
  const extra: Record<string, [string, string]> = {
    bad_name: UPLOAD_MESSAGES.bad_name, bad_type: UPLOAD_MESSAGES.bad_type, too_large: UPLOAD_MESSAGES.too_large,
  };
  return own(extra, code) ? { error: t(...extra[code]), field: input } : { error: t("بيانات غير صالحة.", "Invalid data.") };
}
