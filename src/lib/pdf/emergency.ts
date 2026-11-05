import "server-only";
import { ageLabel, fmtDate, fmtDateTime } from "@/lib/format";
import { ALLERGY_SEVERITY, DEVICE_KIND, lbl, MRI_SAFETY, SEX } from "@/lib/labels";
import type { Block, Cell, ReportMeta } from "@/lib/pdf/engine";
import { bloodLabel, medLine, type EmergencyCard } from "@/lib/care/emergency";
import { qrPath } from "@/lib/qr";

type Lang = "ar" | "en";
const tx = (lang: Lang) => (ar: string, en: string) => (lang === "ar" ? ar : en);

/**
 * The printable emergency card: blood group and allergies first, then chronic conditions, long-term medicines, devices and the
 * emergency contacts, with a QR code of the live link when the current link is known (a token is shown once, when it is made;
 * only its hash is kept, so a card printed later has no code unless the link is regenerated).
 */
export function buildEmergencyReport(card: EmergencyCard, o: { lang: Lang; tz: string; link?: string | null; mrn?: string | null }): { meta: ReportMeta; blocks: Block[]; filename: string } {
  const { lang, tz } = o;
  const t = tx(lang);
  const p = card.patient;
  const sep = lang === "ar" ? "، " : ", ";
  const blocks: Block[] = [];
  const blood = bloodLabel(p);

  blocks.push({ t: "alert", tone: blood ? "info" : "muted", title: t("فصيلة الدم", "Blood group"),
    text: blood ? `${blood}${p.blood_group_verified ? "" : ` (${t("غير موثقة", "unverified")})`}` : t("غير مسجلة", "Not recorded") });

  blocks.push({ t: "h", text: t("الحساسية", "Allergies") });
  if (card.allergies.length) {
    blocks.push({ t: "table", cols: [{ label: t("المادة", "Substance"), w: 4 }, { label: t("التفاعل", "Reaction"), w: 4 }, { label: t("الشدة", "Severity"), w: 2 }],
      rows: card.allergies.map((a): Cell[] => [{ text: a.substance, bold: true }, a.reaction ?? "", { text: lbl(ALLERGY_SEVERITY, a.severity, lang), tone: a.severity === "severe" || a.severity === "life_threatening" ? "bad" : "muted" }]) });
  } else {
    blocks.push({ t: "p", muted: true, text: p.allergy_assertion === "none_known" ? t("لا توجد حساسية معروفة (إقرار مسجل).", "No known allergies (recorded statement).") : t("حالة الحساسية غير معروفة؛ لا يعني ذلك عدم وجودها.", "Allergy status unknown; this does not mean there are none.") });
  }

  blocks.push({ t: "h", text: t("الأمراض المزمنة", "Chronic conditions") });
  blocks.push(card.conditions.length
    ? { t: "p", text: card.conditions.map((c) => c.name).join(sep) }
    : { t: "p", muted: true, text: card.assertions.none_chronic_conditions ? t("لا يوجد (إقرار مسجل).", "None (recorded statement).") : t("غير مسجلة.", "None recorded.") });

  blocks.push({ t: "h", text: t("الأدوية الدائمة", "Long-term medicines") });
  if (card.medications.length) blocks.push({ t: "table", cols: [{ label: t("الدواء", "Medicine"), w: 6 }], rows: card.medications.map((m): Cell[] => [medLine(m)]) });
  else blocks.push({ t: "p", muted: true, text: card.assertions.none_long_term_medications ? t("لا يوجد (إقرار مسجل).", "None (recorded statement).") : t("غير مسجلة.", "None recorded.") });

  blocks.push({ t: "h", text: t("الأجهزة والزرعات", "Devices and implants") });
  if (card.devices.length) {
    blocks.push({ t: "table", cols: [{ label: t("الجهاز", "Device"), w: 5 }, { label: t("الموضع", "Site"), w: 3 }, { label: t("الرنين المغناطيسي", "MRI"), w: 3 }],
      rows: card.devices.map((d): Cell[] => [{ text: [lbl(DEVICE_KIND, d.kind, lang), d.name].filter(Boolean).join(" — "), bold: true }, d.body_site ?? "",
        d.mri_safety && d.mri_safety !== "unknown" ? { text: lbl(MRI_SAFETY, d.mri_safety, lang), tone: d.mri_safety === "unsafe" ? "bad" : d.mri_safety === "conditional" ? "warn" : "ok" } : ""]) });
  } else {
    blocks.push({ t: "p", muted: true, text: card.assertions.none_devices ? t("لا يوجد (إقرار مسجل).", "None (recorded statement).") : t("غير مسجلة.", "None recorded.") });
  }

  blocks.push({ t: "h", text: t("جهات الطوارئ", "Emergency contacts") });
  blocks.push(card.contacts.length
    ? { t: "table", cols: [{ label: t("الاسم", "Name"), w: 4 }, { label: t("الصلة", "Relation"), w: 3 }, { label: t("الهاتف", "Phone"), w: 3 }],
        rows: card.contacts.map((c): Cell[] => [{ text: c.full_name, bold: true }, [c.relation, c.is_legal_representative ? t("ممثل قانوني", "legal representative") : ""].filter(Boolean).join(" · "), c.phone]) }
    : { t: "p", muted: true, text: t("لا توجد جهات طوارئ في هذه البطاقة.", "No emergency contacts on this card.") });

  if (o.link) {
    try {
      const q = qrPath(o.link);
      blocks.push({ t: "h", text: t("الرابط المباشر", "Live link") });
      blocks.push({ t: "qr", d: q.d, size: q.size, px: 120, caption: t("امسح الرمز لفتح ملخص الطوارئ المحدّث (للقراءة فقط، بلا رمز PIN). يُلغيه المريض متى شاء.", "Scan to open the up-to-date emergency summary (read-only, no PIN). The patient can switch it off at any time.") });
      blocks.push({ t: "p", muted: true, text: o.link });
    } catch { /* a link longer than the code can hold: the card prints without it */ }
  } else {
    blocks.push({ t: "p", muted: true, text: t("لا رمز QR في هذه النسخة: يظهر الرابط مرة واحدة عند تفعيله أو تجديده، ولا يُحفظ إلا ما يتحقق منه. جدّد الرابط لطباعة بطاقة برمز.", "No QR code on this copy: the link is shown once, when it is switched on or regenerated, and only its fingerprint is kept. Regenerate the link to print a card with a code.") });
  }

  const name = lang === "en" && p.full_name_en ? p.full_name_en : p.full_name;
  const docRef = `${(o.mrn ?? "EMRG").toUpperCase()}-ICE-CARD`;
  return {
    meta: {
      lang, title: t("بطاقة الطوارئ الطبية", "Medical emergency card"), brand: t("بوابة شفاء", "Shifa Portal"), docRef,
      headline: { name, lines: [[ageLabel(p.date_of_birth, lang), lbl(SEX, p.sex, lang), `${t("الميلاد", "DOB")} ${fmtDate(p.date_of_birth, lang, tz)}`, o.mrn].filter(Boolean).join("  ·  "),
        blood ? `${t("فصيلة الدم", "Blood group")}: ${blood}` : t("فصيلة الدم غير مسجلة", "Blood group not recorded")] },
      generatedAt: `${t("أُنشئت في", "Generated")} ${fmtDateTime(new Date(), lang, tz)}`,
      footerNote: t("ملخص يختاره المريض لحالات الطوارئ؛ قد لا يكون كاملاً أو حديثاً. لا يغني عن تقييم الطبيب.", "A summary chosen by the patient for emergencies; it may be incomplete or out of date. It does not replace the clinician's assessment."),
    },
    blocks, filename: `emergency-card-${(o.mrn ?? "file").replace(/[^A-Za-z0-9-]/g, "")}.pdf`,
  };
}
