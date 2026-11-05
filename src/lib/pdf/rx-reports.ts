import "server-only";
import { ageLabel, fmtDate, fmtDateTime } from "@/lib/format";
import { lbl, SEX } from "@/lib/labels";
import type { Block, Cell, ReportMeta } from "@/lib/pdf/engine";
import type { PatientRow } from "@/lib/types";
import { lineSig, lineTitle, RX_STATUS, type Rx } from "@/lib/prescription";
import { CONSENT_KIND, CONSENT_STATUS, SIGNER_ROLE, type ConsentRow } from "@/lib/consent";
import { reasonText, type SafetyAlert } from "@/lib/safety-rules";

/*
 * Prescription, consent and safety-alert blocks for the PDF engine. The PDF font has no glyphs for the comparison and
 * arrow signs or bullets, so every sentence here is in words.
 */

type Lang = "ar" | "en";
const tx = (lang: Lang) => (ar: string, en: string) => (lang === "ar" ? ar : en);

/** What the identity block of a PDF needs about the patient (from a file, or from a share bundle). */
export interface PdfPatient {
  mrn: string; full_name: string; full_name_en?: string | null; date_of_birth: string; sex: string; nationality?: string | null; blood?: string | null;
  verified?: boolean; phone?: string | null;
}
export const patientFromRow = (p: PatientRow): PdfPatient => ({
  mrn: p.mrn, full_name: p.full_name, full_name_en: p.full_name_en, date_of_birth: p.date_of_birth, sex: p.sex, nationality: p.nationality,
  blood: p.blood_abo ? `${p.blood_abo}${p.blood_rh ?? ""}` : null, verified: p.blood_group_verified, phone: p.phone,
});

export function headline(p: PdfPatient, lang: Lang, tz: string): ReportMeta["headline"] {
  const t = tx(lang);
  return {
    name: lang === "en" && p.full_name_en ? p.full_name_en : p.full_name,
    lines: [
      [p.mrn, ageLabel(p.date_of_birth, lang), lbl(SEX, p.sex, lang), `${t("الميلاد", "DOB")} ${fmtDate(p.date_of_birth, lang, tz)}`, p.nationality].filter(Boolean).join("  ·  "),
      [p.blood ? `${t("فصيلة الدم", "Blood group")}: ${p.blood}${p.verified ? "" : ` (${t("غير موثقة", "unverified")})`}` : t("فصيلة الدم غير مسجلة", "Blood group not recorded"), p.phone].filter(Boolean).join("  ·  "),
    ],
  };
}

const NOTE = (lang: Lang) => tx(lang)(
  "أداة لتنظيم المعلومات الصحية؛ لا تقدّم تشخيصاً ولا علاجاً. القرار السريري للطبيب المعالج.",
  "A tool to organise health information; it does not diagnose or treat. The clinical decision belongs to the treating clinician.");

/** The safety alerts of a plan or a prescription: each with its reason, the treatments or drugs it concerns, and whether its rule was reviewed. */
export function safetyBlocks(alerts: SafetyAlert[], lang: Lang): Block[] {
  if (!alerts.length) return [];
  const t = tx(lang);
  const sep = lang === "ar" ? "، " : ", ";
  const out: Block[] = [{ t: "h", text: t("تنبيهات السلامة لهذه الحالة", "Safety alerts for this case") }];
  for (const a of alerts) {
    const concerns = [
      a.items.length ? `${t("تخص", "Concerns")}: ${a.items.map((i) => `${i.name}${i.teeth?.length ? ` (${i.teeth.join(",")})` : ""}`).join(sep)}` : "",
      a.drugs.length ? `${t("الأدوية", "Drugs")}: ${a.drugs.join(sep)}` : "",
    ].filter(Boolean).join(" · ");
    out.push({
      t: "alert", tone: a.severity === "danger" ? "bad" : a.severity === "warn" ? "warn" : "info",
      title: lang === "ar" ? a.title_ar : a.title_en,
      text: [lang === "ar" ? a.message_ar : a.message_en, `${t("بسبب", "Because of")}: ${a.reasons.map((r) => reasonText(r, lang)).join(sep)}`, concerns].filter(Boolean).join(" — "),
    });
  }
  if (alerts.some((a) => !a.reviewed)) {
    out.push({ t: "p", muted: true, text: t("بعض القواعد لم تُراجع سريرياً بعد؛ هذه تذكيرات للمراجعة وليست تشخيصاً.", "Some of these rules have not been clinically reviewed yet; they are reminders to review, not a diagnosis.") });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ a prescription
export function buildPrescriptionReport(p: PdfPatient, rx: Rx, o: {
  lang: Lang; tz: string; allergies: string[] | null; alerts?: SafetyAlert[]; byShare?: boolean;
}): { meta: ReportMeta; blocks: Block[]; filename: string } {
  const { lang, tz } = o;
  const t = tx(lang);
  const day = (v: string | null | undefined) => (v ? fmtDate(v, lang, tz) : "");
  const blocks: Block[] = [];
  if (o.allergies) {
    blocks.push(o.allergies.length
      ? { t: "alert", tone: "bad", title: t("حساسية موثقة", "Documented allergies"), text: o.allergies.join(lang === "ar" ? "، " : ", ") }
      : { t: "p", muted: true, text: t("لا حساسية مسجلة في الملف (لا يعني عدم وجودها).", "No allergy recorded in the file (not proof of none).") });
  }
  if (rx.status !== "active") {
    blocks.push({ t: "alert", tone: "warn", title: lbl(RX_STATUS, rx.status, lang), text: rx.status_reason ?? "" });
  }
  blocks.push({ t: "h", text: t("الوصفة الطبية", "Prescription") });
  blocks.push({ t: "kv", rows: ([
    [t("رقم الوصفة", "Prescription no."), rx.id.slice(0, 8).toUpperCase()],
    [t("التاريخ", "Date"), day(rx.issued_on)],
    [t("الطبيب الواصف", "Prescriber"), rx.prescriber_name],
    [t("رقم الترخيص", "Licence no."), rx.prescriber_license ?? ""],
    [t("المنشأة", "Facility"), rx.facility_name ?? ""],
    [t("الحالة", "Status"), lbl(RX_STATUS, rx.status, lang)],
    [t("ملاحظات", "Notes"), rx.notes ?? ""],
  ] as [string, string][]).filter(([, v]) => v) });
  blocks.push({ t: "table", cols: [
    { label: "#", w: 1 }, { label: t("الدواء", "Medicine"), w: 5 }, { label: t("طريقة الاستخدام", "Directions"), w: 6 },
  ], rows: rx.lines.map((l, i): Cell[] => [
    String(i + 1),
    { text: lineTitle(l, lang), bold: true },
    [lineSig(l, lang), l.instructions, l.indication && `${t("لـ", "For")}: ${l.indication}`].filter(Boolean).join(" · "),
  ]) });
  if (o.alerts?.length) blocks.push(...safetyBlocks(o.alerts, lang));
  blocks.push({ t: "space", h: 14 });
  const line = "____________________";
  blocks.push({ t: "table", cols: [{ label: "", w: 3 }, { label: t("الاسم", "Name"), w: 4 }, { label: t("التوقيع والختم", "Signature and stamp"), w: 5 }, { label: t("التاريخ", "Date"), w: 3 }], rows: [
    [{ text: t("الطبيب الواصف", "Prescriber"), bold: true }, rx.prescriber_name, line, day(rx.issued_on)],
  ] });
  const docRef = `${p.mrn}-RX-${(rx.issued_on ?? "").replace(/-/g, "")}-${rx.id.slice(0, 8).toUpperCase()}`;
  return {
    meta: {
      lang, title: t("وصفة طبية", "Prescription"), subtitle: rx.prescriber_name, brand: t("بوابة شفاء", "Shifa Portal"), headline: headline(p, lang, tz),
      docRef,
      generatedAt: `${t("أُنشئ في", "Generated")} ${fmtDateTime(new Date(), lang, tz)}`,
      footerNote: o.byShare
        ? t("وصفة سجّلها الطبيب عبر رابط المشاركة. الصرف والمتابعة بإشراف الطبيب والصيدلي.", "A prescription recorded by the doctor through the share link. Dispensing and follow-up are under the doctor and the pharmacist.")
        : NOTE(lang),
    },
    blocks, filename: `${p.mrn}-rx-${rx.issued_on}-${rx.id.slice(0, 8)}.pdf`,
  };
}

// ------------------------------------------------------------------------------------------------ a consent, with the drawn signature
export function buildConsentReport(p: PdfPatient, c: ConsentRow & { body: string }, o: {
  lang: Lang; tz: string; signature: Buffer | null; covers?: string | null;
}): { meta: ReportMeta; blocks: Block[]; filename: string } {
  const { lang, tz } = o;
  const t = tx(lang);
  const blocks: Block[] = [];
  if (c.status === "withdrawn") {
    blocks.push({ t: "alert", tone: "bad", title: t("مسحوبة", "Withdrawn"), text: `${c.withdrawn_at ? fmtDateTime(c.withdrawn_at, lang, tz) : ""} — ${c.withdrawn_reason ?? ""}` });
  } else if (c.status === "superseded") {
    blocks.push({ t: "alert", tone: "warn", title: t("استُبدلت بنسخة أحدث", "Superseded by a newer version"), text: t("هذه النسخة محفوظة للتاريخ، والنسخة الأحدث هي السارية.", "This version is kept for the record; the newer version is the one in force.") });
  }
  blocks.push({ t: "h", text: c.title });
  blocks.push({ t: "kv", rows: ([
    [t("نوع الموافقة", "Kind"), lbl(CONSENT_KIND, c.kind, lang)],
    [t("النسخة", "Version"), String(c.version)],
    [t("الحالة", "Status"), lbl(CONSENT_STATUS, c.status, lang)],
    [t("تشمل", "Covers"), o.covers ?? ""],
    [t("قدّمها", "Presented by"), c.presented_by ?? ""],
  ] as [string, string][]).filter(([, v]) => v) });
  for (const para of c.body.split(/\n{2,}/)) blocks.push({ t: "p", text: para.trim() });
  blocks.push({ t: "h", text: t("التوقيع", "Signature") });
  blocks.push({ t: "kv", rows: ([
    [t("الموقّع", "Signed by"), c.signer_name],
    [t("الصفة", "Capacity"), lbl(SIGNER_ROLE, c.signer_role, lang)],
    [t("وقت التوقيع", "Signed at"), fmtDateTime(c.signed_at, lang, tz)],
    [t("الشاهد", "Witness"), c.witness_name ?? ""],
  ] as [string, string][]).filter(([, v]) => v) });
  if (o.signature) blocks.push({ t: "image", data: o.signature, w: 230, h: 90, caption: t("التوقيع المرسوم على الشاشة", "Signature drawn on the screen") });
  else blocks.push({ t: "p", muted: true, text: t("صورة التوقيع غير متاحة.", "The signature image is not available.") });
  const docRef = `${p.mrn}-CONSENT-V${c.version}-${c.id.slice(0, 8).toUpperCase()}`;
  return {
    meta: {
      lang, title: t("موافقة موقّعة", "Signed consent"), subtitle: c.title, brand: t("بوابة شفاء", "Shifa Portal"), headline: headline(p, lang, tz),
      docRef,
      generatedAt: `${t("أُنشئ في", "Generated")} ${fmtDateTime(new Date(), lang, tz)}`, footerNote: NOTE(lang),
    },
    blocks, filename: `${p.mrn}-consent-v${c.version}-${c.id.slice(0, 8)}.pdf`,
  };
}
