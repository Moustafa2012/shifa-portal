import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { REPORT_CATALOG } from "@/lib/pdf/index";
import { buildEncounterReport, buildTreatmentPlanReport } from "@/lib/pdf/reports";
import { buildEmergencyReport } from "@/lib/pdf/emergency";
import type { PatientRow, ObservationRow, ObservationType } from "@/lib/types";
import type { TreatmentPlan } from "@/lib/treatment";

const mockPatient: PatientRow = {
  id: "patient-1001",
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
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deletion_requested_at: null,
  photo_path: null,
  email: null,
  address_line: null,
  city: null,
  country: null,
  allergy_assertion_at: null,
  deletion_scheduled_for: null,
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
    const labsEntry = REPORT_CATALOG.find((r) => r.id === "labs");
    expect(labsEntry).toBeDefined();
    const url = labsEntry?.buildUrl("patient-1001", { lang: "ar", dl: true });
    expect(url).toBe("/api/patients/patient-1001/report?scope=labs&lang=ar&dl=1");

    const dentalEntry = REPORT_CATALOG.find((r) => r.id === "dental-summary");
    const dentalUrl = dentalEntry?.buildUrl("patient-1001", { lang: "en" });
    expect(dentalUrl).toBe("/api/patients/patient-1001/dental/summary/pdf?lang=en");
  });
});

describe("Clinical Visit Encounter Report Builder", () => {
  it("generates structured PDF blocks for an encounter", () => {
    const encounter = {
      id: "enc-55",
      patient_id: mockPatient.id,
      started_at: "2026-11-01T10:30:00Z",
      ended_at: "2026-11-01T11:00:00Z",
      kind: "consultation",
      reason: "متابعة ارتفاع ضغط الدم",
      service_type: "طب الأسرة",
      status: "completed",
      class: "ambulatory",
      priority: "routine",
      record_status: "active",
      created_at: "2026-11-01T10:30:00Z",
      updated_at: "2026-11-01T11:00:00Z",
      location: "العيادة الأولى",
    };

    const res = buildEncounterReport(mockPatient, encounter, {
      lang: "ar",
      tz: "Asia/Riyadh",
      specialtyName: "طب الأسرة",
      conditions: [{ name: "ارتفاع ضغط الدم الأساسي", clinical_status: "active" }],
      medications: [{ name_generic: "Amlodipine", dose: "5 mg", frequency: "مرة يومياً", route: "فموي" }],
      procedures: [{ name: "تخطيط قلب كهربائي", outcome: "طبيعي" }],
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
          encounter_id: encounter.id,
          report_id: null,
          context: null,
          notes: null,
          value_text: null,
          ref_low: null,
          ref_high: null,
          ref_text: null,
        } as unknown as ObservationRow,
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
          applicable_sex: null,
        } as unknown as ObservationType,
      ],
    });

    expect(res.meta.title).toBe("تقرير زيارة سريرية");
    expect(res.meta.docRef).toBe("MRN-1001-ENC-20261101");
    expect(res.filename).toContain("MRN-1001-visit-2026-11-01");
    expect(res.blocks.length).toBeGreaterThan(3);
  });
});

describe("Treatment Plan PDF Report Builder", () => {
  it("builds a treatment plan report with dental items, tooth numbers, and costs", () => {
    const plan = {
      id: "tx-plan-2",
      title: "خطة علاج شاملة - تأهيل الفم",
      status: "accepted" as const,
      version: 2,
      presented_by: "د. عبد الرحمن الشهري",
      presented_on: "2026-10-15",
      accepted_on: "2026-10-18",
      notes: "تمت مناقشة خطة العلاج وتفضيل التركيبات الزيركونية.",
      group_id: null,
      alternative_of: null,
      contributed_by: null,
      recorded_at: "2026-10-15",
      items: [
        {
          id: "item-1",
          plan_id: "tx-plan-2",
          procedure_name: "علاج عصب الضرس الأول العلوي",
          tooth_number: "16",
          surface: "MOD",
          status: "completed" as const,
          priority: "urgent" as const,
          cost: 1200,
          notes: null,
          record_status: "active" as const,
          created_at: "2026-10-15",
          updated_at: "2026-10-20",
        },
      ],
      record_status: "active" as const,
      created_at: "2026-10-15",
      updated_at: "2026-10-18",
    } as unknown as TreatmentPlan;

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
        allergies: [{ substance: "Penicillin", category: "medication", reaction: "طفح جلدي وضيق تنفس", severity: "severe" }],
        conditions: [{ name: "السكري النوع الثاني", severity: "moderate" }],
        medications: [{ name: "Metformin", strength: "500 mg", dose: "حبة واحدة", frequency: "مرتان يومياً" }],
        devices: [{ kind: "cardiac_pacemaker", name: "منظم ضربات قلب", body_site: "أعلى الصدر الأيسر", mri_safety: "conditional" }],
        contacts: [{ full_name: "فاطمة عبد الله", relation: "أخت", phone: "+966555123456", is_legal_representative: true }],
        assertions: { none_chronic_conditions: false, none_long_term_medications: false, none_devices: false },
        include_sensitive: false,
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
