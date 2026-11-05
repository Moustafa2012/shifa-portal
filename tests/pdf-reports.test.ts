import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  REPORT_CATALOG,
  renderPdf,
  buildEncounterReport,
  buildTreatmentPlanReport,
  buildEmergencyReport,
  type ReportMeta,
  type Block,
} from "@/lib/pdf";
import type { PatientRow } from "@/lib/types";

const mockPatient: PatientRow = {
  id: "11111111-1111-1111-1111-111111111111",
  mrn: "MRN-1001",
  full_name: "أحمد عبد الله",
  full_name_en: "Ahmed Abdullah",
  date_of_birth: "1988-06-15",
  sex: "male",
  nationality: "SA",
  blood_abo: "O",
  blood_rh: "+",
  blood_group_verified: true,
  phone: "+966500000000",
  allergy_assertion: "verified",
  national_id: null,
  record_status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deletion_requested_at: null,
  photo_path: null,
  created_by: null,
  updated_by: null,
};

describe("PDF Reports Master Catalog", () => {
  it("indexes all core report types", () => {
    const ids = REPORT_CATALOG.map((r) => r.id);
    expect(ids).toContain("full");
    expect(ids).toContain("summary");
    expect(ids).toContain("vitals");
    expect(ids).toContain("labs");
    expect(ids).toContain("dental-summary");
    expect(ids).toContain("emergency");
  });

  it("builds valid URLs for each report with language and download options", () => {
    const full = REPORT_CATALOG.find((r) => r.id === "full")!;
    expect(full.buildUrl("test-pid", { lang: "en", dl: true })).toBe("/api/patients/test-pid/report?scope=full&lang=en&dl=1");
    expect(full.buildUrl("test-pid", { lang: "ar" })).toBe("/api/patients/test-pid/report?scope=full&lang=ar");

    const vitals = REPORT_CATALOG.find((r) => r.id === "vitals")!;
    const vitalsUrl = vitals.buildUrl("test-pid", { range: "30", type: "bp", lang: "ar" });
    expect(vitalsUrl).toContain("scope=vitals");
    expect(vitalsUrl).toContain("range=30");
    expect(vitalsUrl).toContain("type=bp");
    expect(vitalsUrl).toContain("lang=ar");
  });
});

describe("PDF Engine Rendering", () => {
  it("renders a valid PDF buffer with TOC and zebra tables", async () => {
    const meta: ReportMeta = {
      lang: "ar",
      title: "تقرير تجريبي",
      brand: "بوابة شفاء",
      docRef: "MRN-1001-TEST",
      headline: { name: "أحمد عبد الله", lines: ["MRN-1001", "36 سنة", "ذكر"] },
      generatedAt: "2026-11-05 12:00",
      footerNote: "ملاحظة أمان وتنبيه تجريبي.",
    };

    const blocks: Block[] = [
      {
        t: "toc",
        title: "فهرس المحتويات",
        items: [
          { label: "معلومات السلامة", count: 2, badge: "تنبيه" },
          { label: "الأمراض والتشخيصات", count: 4 },
          { label: "القياسات الحيوية", count: 12 },
        ],
      },
      { t: "h", text: "الفصل الأول: القياسات" },
      { t: "p", text: "قراءات سريرية ضمن الحدود الطبيعية." },
      { t: "alert", tone: "ok", title: "مستقر", text: "كل المؤشرات مستقرة." },
      {
        t: "table",
        cols: [
          { label: "القياس", w: 4 },
          { label: "القيمة", w: 3 },
          { label: "التصنيف", w: 3 },
        ],
        rows: [
          ["ضغط الدم", "120/80", { text: "طبيعي", tone: "ok" }],
          ["سكر الدم", "95", { text: "طبيعي", tone: "ok" }],
          ["النبض", "72", { text: "طبيعي", tone: "ok" }],
        ],
      },
      { t: "divider" },
      { t: "kv", rows: [["الطبيب المعالج", "د. عبد الرحمن"], ["المنشأة", "عيادات الشفاء"]] },
    ];

    const buffer = await renderPdf(meta, blocks);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
    // PDF magic number header: %PDF-1.7
    expect(buffer.toString("utf-8", 0, 8)).toContain("%PDF-");
  });
});

describe("Clinical Encounter / Visit Report Builder", () => {
  it("builds a complete encounter report with clinical presentation and signatures", () => {
    const encounter = {
      id: "enc-12345678-0000",
      started_at: "2026-11-01T10:30:00Z",
      kind: "outpatient",
      reason: "متابعة دورية لارتفاع ضغط الدم",
      practitioner_name: "د. سامي الأحمد",
      facility_name: "المركز الطبي الجامعي",
      symptoms: "صداع خفيف صباحي",
      history_of_present_illness: "منذ 3 أيام بشكل متقطع",
      examination: "الصدر والقلب سليم، لا توجد وذمات",
      assessment: "ارتفاع ضغط دم أولي مضبوط",
      plan: "الاستمرار على نفس الجرعة الدوائية ومتابعة الضغط أسبوعياً",
      instructions: "تقليل استهلاك الملح وممارسة المشي نصف ساعة يومياً",
      follow_up_date: "2026-12-01",
    };

    const res = buildEncounterReport(mockPatient, encounter, {
      lang: "ar",
      tz: "Asia/Riyadh",
      specialtyName: "طب الأسرة",
      conditions: [{ name: "ارتفاع ضغط الدم", clinical_status: "active" }],
      medications: [{ name_generic: "Amlodipine", dose: "5 mg", frequency: "مرة يومياً" }],
      observations: [
        {
          id: "obs-1",
          patient_id: mockPatient.id,
          type_id: "bp-type",
          value_num: 125,
          value_num2: 82,
          unit: "mmHg",
          effective_at: "2026-11-01T10:35:00Z",
          interpretation: "normal",
          status: "final",
          recorded_at: "2026-11-01T10:35:00Z",
          entered_by: null,
          encounter_id: encounter.id,
          lab_report_id: null,
          record_status: "active",
          context: null,
          notes: null,
          value_text: null,
          ref_low: null,
          ref_high: null,
          ref_text: null,
        },
      ],
      types: [
        {
          id: "bp-type",
          code: "bp",
          name_ar: "ضغط الدم",
          name_en: "Blood pressure",
          category: "vital",
          value_kind: "bp",
          default_unit: "mmHg",
          decimals: 0,
          sort: 1,
          lab_group: null,
          applies_to_sex: null,
        },
      ],
    });

    expect(res.meta.title).toBe("تقرير زيارة سريرية");
    expect(res.meta.docRef).toBe("MRN-1001-ENC-20261101");
    expect(res.filename).toContain("MRN-1001-visit-2026-11-01");
    expect(res.blocks.length).toBeGreaterThan(5);

    const tableBlocks = res.blocks.filter((b) => b.t === "table");
    expect(tableBlocks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Treatment Plan Report Builder", () => {
  it("builds a plan report with docRef, items, and consent agreement", () => {
    const plan = {
      id: "plan-1",
      patient_id: mockPatient.id,
      title: "خطة ترميم وزراعة شاملة",
      status: "accepted" as const,
      version: 2,
      presented_by: "د. إبراهيم خليل",
      presented_on: "2026-10-15",
      accepted_on: "2026-10-18",
      notes: "تمت مناقشة الخطة والبدائل بالتفصيل",
      items: [
        {
          id: "item-1",
          plan_id: "plan-1",
          patient_id: mockPatient.id,
          name: "حشوة كومبوزيت ضوئية",
          teeth: [16],
          surfaces: ["M", "O"],
          phase: 1,
          status: "completed" as const,
          sort: 1,
          surgical: false,
          condition_id: null,
          catalog_code: "rest_comp",
          scheduled_for: null,
          completed_on: "2026-10-20",
          clinician_name: "د. إبراهيم",
          facility_name: "مجمع الشفاء لطب الأسنان",
          encounter_id: null,
          notes: null,
          record_status: "active" as const,
          created_at: "2026-10-15",
          updated_at: "2026-10-20",
        },
      ],
      record_status: "active" as const,
      created_at: "2026-10-15",
      updated_at: "2026-10-18",
    };

    const res = buildTreatmentPlanReport(mockPatient, plan, {
      lang: "ar",
      tz: "Asia/Riyadh",
      problems: [],
    });

    expect(res.meta.title).toBe("خطة علاج الأسنان");
    expect(res.meta.docRef).toBe("MRN-1001-TXP-V2");
    expect(res.filename).toBe("MRN-1001-treatment-plan-v2.pdf");
    expect(res.blocks.some((b) => b.t === "h" && b.text.includes("الموافقة على العلاج"))).toBe(true);
  });
});

describe("Emergency Medical Card Builder", () => {
  it("builds an emergency report with docRef, blood group, allergies, and contacts", () => {
    const res = buildEmergencyReport(
      {
        patient: {
          full_name: mockPatient.full_name,
          full_name_en: mockPatient.full_name_en,
          date_of_birth: mockPatient.date_of_birth,
          sex: mockPatient.sex,
          blood_abo: mockPatient.blood_abo,
          blood_rh: mockPatient.blood_rh,
          blood_group_verified: true,
          allergy_assertion: "verified",
        },
        allergies: [{ substance: "Penicillin", reaction: "طفح جلدي وضيق تنفس", severity: "severe" }],
        conditions: [{ name: "السكري النوع الثاني" }],
        medications: [{ name_generic: "Metformin", strength: "500 mg", dose: "حبة واحدة", frequency: "مرتان يومياً", route: "فموي" }],
        devices: [{ kind: "cardiac_pacemaker", name: "منظم ضربات قلب", body_site: "أعلى الصدر الأيسر", mri_safety: "conditional" }],
        contacts: [{ full_name: "فاطمة عبد الله", relation: "أخت", phone: "+966555123456", is_legal_representative: true }],
        assertions: { none_chronic_conditions: false, none_long_term_medications: false, none_devices: false },
      },
      {
        lang: "ar",
        tz: "Asia/Riyadh",
        mrn: mockPatient.mrn,
        link: "https://shifa.app/emergency/test-token",
      }
    );

    expect(res.meta.title).toBe("بطاقة الطوارئ الطبية");
    expect(res.meta.docRef).toBe("MRN-1001-ICE-CARD");
    expect(res.blocks.some((b) => b.t === "qr")).toBe(true);
    expect(res.blocks.some((b) => b.t === "h" && b.text.includes("جهات الطوارئ"))).toBe(true);
  });
});
