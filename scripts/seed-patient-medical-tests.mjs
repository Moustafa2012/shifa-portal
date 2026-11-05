// scripts/seed-patient-medical-tests.mjs
import { createClient } from "@supabase/supabase-js";

const url = "https://xzbdetgmggilxepsmpxs.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6YmRldGdtZ2dpbHhlcHNtcHhzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MzA0NDU2MSwiZXhwIjoyMTA4NjIwNTYxfQ.PMsAmGjBKtOjRTbpzWINclaeTFvwyqE6FkcBqEY4IOg";
const supabase = createClient(url, key);

const MRN = "SH-00000016";

async function main() {
  console.log(`Starting medical tests insertion for patient ${MRN}...`);

  // 1. Fetch patient
  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("id, mrn, full_name, sex")
    .eq("mrn", MRN)
    .single();

  if (pErr || !patient) {
    throw new Error(`Patient ${MRN} not found: ${pErr?.message}`);
  }
  console.log(`Found patient: ${patient.full_name} (${patient.id})`);

  // 2. Fetch all observation types map (code -> id)
  const { data: obsTypes, error: tErr } = await supabase
    .from("observation_types")
    .select("id, code, name_ar, default_unit, value_kind");
  if (tErr || !obsTypes) {
    throw new Error(`Could not fetch observation types: ${tErr?.message}`);
  }

  const byCode = new Map(obsTypes.map((t) => [t.code, t]));
  const getId = (code) => {
    const t = byCode.get(code);
    if (!t) throw new Error(`Missing observation type: ${code}`);
    return t.id;
  };

  // Check if reports are already seeded for this patient to prevent duplicate seeding
  const { data: existingReports } = await supabase
    .from("lab_reports")
    .select("id, title, collected_at")
    .eq("patient_id", patient.id);

  console.log(`Found ${existingReports?.length ?? 0} existing reports for this patient.`);

  // If reports already exist with these titles, delete them first to re-seed cleanly
  const titles = [
    "تقرير مخبر البراءة للتحاليل الطبية (هرمونات - كيمياء حيوية - كيمياء مناعية - مصليات)",
    "تقرير مخبر حلب للتحاليل الطبية (أمراض الدم والتخثر - كيمياء حيوية)",
    "شريط تعداد الدم الكامل الآلي (Automated CBC Parameters)",
    "تقرير مخبر الهرم للتحاليل الطبية (هرمونات - كيمياء حيوية - فحص البول العام)",
  ];

  for (const r of existingReports ?? []) {
    if (titles.includes(r.title)) {
      console.log(`Removing previous seed of report: ${r.title} (${r.id})`);
      await supabase.from("observations").delete().eq("report_id", r.id);
      await supabase.from("lab_reports").delete().eq("id", r.id);
    }
  }

  // --- REPORT 1: مخبر البراءة (Al-Baraa Lab) - 2026-11-05 ---
  console.log("Seeding Report 1 (Al-Baraa Lab - 2026-11-05)...");
  const report1 = {
    p_patient: patient.id,
    p_report: {
      title: "تقرير مخبر البراءة للتحاليل الطبية (هرمونات - كيمياء حيوية - كيمياء مناعية - مصليات)",
      lab_name: "مخبر البراءة للتحاليل الطبية",
      specimen_type: "مصل / بلازما (Serum / Plasma)",
      collected_at: "2026-11-05T09:40:00+03:00",
      performed_at: "2026-11-05T12:43:01+03:00",
      approved_at: "2026-11-05T12:53:01+03:00",
      approved_by_name: "الدكتورة نور جلب",
      status: "final",
      lab_notes: "الطبيبة المحيلة: الدكتورة سلام النهار · رقم العينة: 44 · الرقم التسلسلي: 202611050003 · برنامج الوافي",
    },
    p_results: [
      {
        type_id: getId("insulin"),
        value_num: 43.6,
        unit: "µIU/mL",
        ref_low: 2.6,
        ref_high: 25.0,
        ref_text: "2.6 - 25",
        flag: "high",
        notes: "Insulin (Fasting) إنسولين صيامي مرتفع",
      },
      {
        type_id: getId("homa_ir"),
        value_num: 7.96,
        unit: null,
        ref_low: null,
        ref_high: 1.0,
        ref_text: "< 1.0 طبيعي | > 1.9 مقاومة مبكرة | > 2.9 مقاومة كبيرة للإنسولين",
        flag: "high",
        notes: "مقاومة الإنسولين HOMA-IR مرتفعة جداً (يشير لمقاومة كبيرة)",
      },
      {
        type_id: getId("glucose_fasting_lab"),
        value_num: 74,
        unit: "mg/dL",
        ref_low: 70,
        ref_high: 110,
        ref_text: "70 - 110",
        flag: "normal",
        notes: "Glucose (Fasting) سكر صيامي طبيعي",
      },
      {
        type_id: getId("ldh"),
        value_num: 367.1,
        unit: "U/L",
        ref_low: 0,
        ref_high: 480,
        ref_text: "0 - 480",
        flag: "normal",
        notes: "Lactate Dehydrogenase (LDH)",
      },
      {
        type_id: getId("vitamin_d"),
        value_num: 21.8,
        unit: "ng/mL",
        ref_low: 32,
        ref_high: 100,
        ref_text: "Desirable: Above 32",
        flag: "low",
        notes: "25-Hydroxyvitamin D3 (منخفض)",
      },
      {
        type_id: getId("igg"),
        value_num: 857.9,
        unit: "mg/dL",
        ref_low: 600,
        ref_high: 1600,
        ref_text: "600 - 1600",
        flag: "normal",
        notes: "Immunoglobulin G (IgG)",
      },
      {
        type_id: getId("iga"),
        value_num: 218.6,
        unit: "mg/dL",
        ref_low: 70,
        ref_high: 400,
        ref_text: "70 - 400",
        flag: "normal",
        notes: "Immunoglobulin A (IgA)",
      },
      {
        type_id: getId("igm"),
        value_num: 197.4,
        unit: "mg/dL",
        ref_low: 40,
        ref_high: 230,
        ref_text: "40 - 230",
        flag: "normal",
        notes: "Immunoglobulin M (IgM)",
      },
      {
        type_id: getId("hcv_ab"),
        value_text: "0.14 (سلبي)",
        unit: null,
        ref_text: "Negative: < 1.0 | Positive: > 1.0",
        flag: "normal",
        notes: "Anti HCV سلبي",
      },
      {
        type_id: getId("ige_total"),
        value_num: 87.1,
        unit: "IU/mL",
        ref_low: 0,
        ref_high: 100,
        ref_text: "≤ 100 IU/mL (للبالغين ≥ 16 سنة) | العام: 0 - 360.9",
        flag: "normal",
        notes: "Total IgE Testing Report: 87.1 IU/mL (ضمن الحد الطبيعي)",
      },
      {
        type_id: getId("ana"),
        value_text: "13.2 (سلبي)",
        unit: null,
        ref_text: "0 - 25",
        flag: "normal",
        notes: "ANA - HEP-2 (Anti-Nuclear Antibody) IF",
      },
      {
        type_id: getId("hbsag"),
        value_text: "0.17 Index (سلبي)",
        unit: "Index",
        ref_text: "Negative: < 0.9 | Positive: > 1.0",
        flag: "normal",
        notes: "HBS-Ag Quantitative العامل الأسترالي",
      },
      {
        type_id: getId("wright_abortus"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Wright T - Abortus",
      },
      {
        type_id: getId("wright_melitensis"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Wright T - B. Melitensis",
      },
      {
        type_id: getId("widal_typhi_o"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Widal T - Typhi (O)",
      },
      {
        type_id: getId("widal_typhi_h"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Widal T - Typhi (H)",
      },
      {
        type_id: getId("widal_paratyphi_a"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Widal T - Para A (H)",
      },
      {
        type_id: getId("widal_paratyphi_b"),
        value_text: "سلبي (Negative)",
        unit: null,
        ref_text: "Negative",
        flag: "normal",
        notes: "Widal T - Para B (H)",
      },
      {
        type_id: getId("crp"),
        value_num: 3.4,
        unit: "mg/L",
        ref_low: 0,
        ref_high: 5,
        ref_text: "0 - 5",
        flag: "normal",
        notes: "CRP (Quantitative) كمي",
      },
    ],
  };

  const { data: rep1Id, error: err1 } = await supabase.rpc("create_lab_report", report1);
  if (err1) throw new Error(`Report 1 creation failed: ${err1.message}`);
  console.log(`Report 1 created successfully: ${rep1Id} (19 observations)`);

  // --- REPORT 2: مخبر حلب (Aleppo Lab) - 2026-10-24 ---
  console.log("Seeding Report 2 (Aleppo Lab - 2026-10-24)...");
  const report2 = {
    p_patient: patient.id,
    p_report: {
      title: "تقرير مخبر حلب للتحاليل الطبية (أمراض الدم والتخثر - كيمياء حيوية)",
      lab_name: "مخبر حلب للتحاليل الطبية",
      specimen_type: "دم وريدي (Venous Blood)",
      collected_at: "2026-10-24T10:30:00+03:00",
      performed_at: "2026-10-24T11:00:00+03:00",
      approved_at: "2026-10-24T11:30:00+03:00",
      approved_by_name: "الدكتورة هبة الله حبو / الدكتور أحمد الشاهر",
      status: "final",
      lab_notes: "رقم العينة: 4 · الباب - دوار العلم - جانب صيدلية البيان · هاتف: +905063156197",
    },
    p_results: [
      {
        type_id: getId("hemoglobin"),
        value_num: 14.8,
        unit: "g/dL",
        ref_low: 13.0,
        ref_high: 18.0,
        ref_text: "13 - 18 (ذكور)",
        flag: "normal",
        notes: "Hemoglobin (الخضاب)",
      },
      {
        type_id: getId("hematocrit"),
        value_num: 45.1,
        unit: "%",
        ref_low: 40.0,
        ref_high: 54.0,
        ref_text: "40 - 54 (ذكور)",
        flag: "normal",
        notes: "Hematocrite (الهيماتوكريت)",
      },
      {
        type_id: getId("esr"),
        value_num: 3,
        unit: "mm/h",
        ref_low: 0,
        ref_high: 15,
        ref_text: "0 - 15 mm/1hr",
        flag: "normal",
        notes: "ESR (1 hr) سرعة التثفل بالساعة الأولى (الساعة الثانية: غير مدون)",
      },
      {
        type_id: getId("blood_group"),
        value_text: "A Positive (A+)",
        unit: null,
        ref_text: null,
        flag: "normal",
        notes: "الزمرة الدموية A ، عامل الريزوس Rh(D): إيجابي (+)",
      },
      {
        type_id: getId("urea"),
        value_num: 28,
        unit: "mg/dL",
        ref_low: 5,
        ref_high: 45,
        ref_text: "5 - 45",
        flag: "normal",
        notes: "Urea (البولة الدموية)",
      },
      {
        type_id: getId("creatinine"),
        value_num: 0.54,
        unit: "mg/dL",
        ref_low: 0.5,
        ref_high: 1.3,
        ref_text: "0.5 - 1.3",
        flag: "normal",
        notes: "Creatinine (كرياتنين)",
      },
      {
        type_id: getId("alt"),
        value_num: 44.2,
        unit: "U/L",
        ref_low: 5,
        ref_high: 45,
        ref_text: "5 - 45",
        flag: "normal",
        notes: "ALT (SGPT)",
      },
    ],
  };

  const { data: rep2Id, error: err2 } = await supabase.rpc("create_lab_report", report2);
  if (err2) throw new Error(`Report 2 creation failed: ${err2.message}`);
  console.log(`Report 2 created successfully: ${rep2Id} (7 observations)`);

  // --- REPORT 3: شريط جهاز تحليل الدم الآلي CBC - 2026-10-24 ---
  console.log("Seeding Report 3 (Automated CBC Analysis - 2026-10-24)...");
  const report3 = {
    p_patient: patient.id,
    p_report: {
      title: "شريط تعداد الدم الكامل الآلي (Automated CBC Parameters)",
      lab_name: "جهاز تحليل الدم الآلي (Automated Counter)",
      specimen_type: "دم كامل (Whole Blood EDTA)",
      collected_at: "2026-10-24T11:45:00+03:00",
      performed_at: "2026-10-24T11:58:00+03:00",
      approved_at: "2026-10-24T12:00:00+03:00",
      approved_by_name: "المخبر الآلي (ID: 000000h00170)",
      status: "final",
      lab_notes: "معرف الجهاز: 000000h00170 · اسم العينة: 3 · الوقت والتاريخ: 2026-10-24 11:58",
    },
    p_results: [
      { type_id: getId("wbc"), value_num: 6.8, unit: "10^3/µL", ref_low: 4.0, ref_high: 10.0, ref_text: "4.0 - 10.0 10^9/L", flag: "normal", notes: "كريات الدم البيضاء الكلية WBC" },
      { type_id: getId("lymphocytes_pct"), value_num: 28.7, unit: "%", ref_low: 20.0, ref_high: 40.0, ref_text: "20.0 - 40.0 %", flag: "normal", notes: "النسبة المئوية للخلايا اللمفاوية LYM%" },
      { type_id: getId("mid_pct"), value_num: 6.9, unit: "%", ref_low: 3.0, ref_high: 12.0, ref_text: "3.0 - 12.0 %", flag: "normal", notes: "النسبة المئوية للخلايا المتوسطة MID%" },
      { type_id: getId("gran_pct"), value_num: 64.4, unit: "%", ref_low: 50.0, ref_high: 70.0, ref_text: "50.0 - 70.0 %", flag: "normal", notes: "النسبة المئوية للخلايا الحبيبية GRAN%" },
      { type_id: getId("lymphocytes_abs"), value_num: 1.9, unit: "10^3/µL", ref_low: 1.0, ref_high: 3.7, ref_text: "1.0 - 3.7 10^9/L", flag: "normal", notes: "العدد المطلق للخلايا اللمفاوية LYM#" },
      { type_id: getId("mid_abs"), value_num: 0.4, unit: "10^3/µL", ref_low: 0.1, ref_high: 1.2, ref_text: "0.1 - 1.2 10^9/L", flag: "normal", notes: "العدد المطلق للخلايا المتوسطة MID#" },
      { type_id: getId("gran_abs"), value_num: 4.5, unit: "10^3/µL", ref_low: 2.0, ref_high: 7.0, ref_text: "2.0 - 7.0 10^9/L", flag: "normal", notes: "العدد المطلق للخلايا الحبيبية GRAN#" },
      { type_id: getId("rbc"), value_num: 5.04, unit: "10^6/µL", ref_low: 4.30, ref_high: 5.90, ref_text: "4.3 - 5.9 10^12/L", flag: "normal", notes: "كريات الدم الحمراء RBC" },
      { type_id: getId("hemoglobin"), value_num: 14.8, unit: "g/dL", ref_low: 13.0, ref_high: 17.5, ref_text: "13.0 - 17.5 g/dl", flag: "normal", notes: "الخضاب HGB" },
      { type_id: getId("hematocrit"), value_num: 45.1, unit: "%", ref_low: 40.0, ref_high: 52.0, ref_text: "40.0 - 52.0 %", flag: "normal", notes: "الهيماتوكريت HCT" },
      { type_id: getId("mcv"), value_num: 89.6, unit: "fL", ref_low: 80.0, ref_high: 99.0, ref_text: "80.0 - 99.0 fL", flag: "normal", notes: "متوسط حجم الكرية الحمراء MCV" },
      { type_id: getId("mch"), value_num: 29.3, unit: "pg", ref_low: 27.0, ref_high: 34.0, ref_text: "27.0 - 34.0 pg", flag: "normal", notes: "متوسط خضاب الكرية الحمراء MCH" },
      { type_id: getId("mchc"), value_num: 32.8, unit: "g/dL", ref_low: 32.0, ref_high: 36.0, ref_text: "32.0 - 36.0 g/dl", flag: "normal", notes: "تركيز خضاب الكرية الحمراء MCHC" },
      { type_id: getId("rdw_cv"), value_num: 16.4, unit: "%", ref_low: 11.5, ref_high: 14.5, ref_text: "11.5 - 14.5 %", flag: "high", notes: "سعة توزيع الكريات الحمراء RDW-CV" },
      { type_id: getId("rdw_sd"), value_num: 47.0, unit: "fL", ref_low: 39.0, ref_high: 46.0, ref_text: "39.0 - 46.0 fL", flag: "high", notes: "سعة توزيع الكريات الحمراء RDW-SD" },
      { type_id: getId("platelets"), value_num: 167, unit: "10^3/µL", ref_low: 150, ref_high: 450, ref_text: "150 - 450 10^9/L", flag: "normal", notes: "الصفيحات الدموية PLT" },
      { type_id: getId("mpv"), value_num: 7.1, unit: "fL", ref_low: 7.0, ref_high: 11.0, ref_text: "7.0 - 11.0 fL", flag: "normal", notes: "الحجم الوسطي للصفيحات MPV" },
      { type_id: getId("pdw"), value_num: 10.2, unit: "fL", ref_low: 9.0, ref_high: 17.0, ref_text: "9.0 - 17.0 fL", flag: "normal", notes: "سعة توزيع الصفيحات PDW" },
      { type_id: getId("pct"), value_num: 0.11, unit: "%", ref_low: 0.10, ref_high: 0.28, ref_text: "0.10 - 0.28 %", flag: "normal", notes: "نسبة الصفيحات الكتلية PCT" },
      { type_id: getId("p_lcr"), value_num: 15.4, unit: "%", ref_low: 13.0, ref_high: 43.0, ref_text: "13.0 - 43.0 %", flag: "normal", notes: "نسبة الصفيحات الكبيرة P-LCR" },
      { type_id: getId("p_lcc"), value_num: 25, unit: "10^3/µL", ref_low: 30, ref_high: 90, ref_text: "30 - 90 10^9/L", flag: "low", notes: "تعداد الصفيحات الكبيرة P-LCC" },
    ],
  };

  const { data: rep3Id, error: err3 } = await supabase.rpc("create_lab_report", report3);
  if (err3) throw new Error(`Report 3 creation failed: ${err3.message}`);
  console.log(`Report 3 created successfully: ${rep3Id} (21 observations)`);

  // --- REPORT 4: مخبر الهرم (Al-Haram Lab) - 2026-10-26 ---
  console.log("Seeding Report 4 (Al-Haram Lab - 2026-10-26)...");
  const report4 = {
    p_patient: patient.id,
    p_report: {
      title: "تقرير مخبر الهرم للتحاليل الطبية (هرمونات - كيمياء حيوية - فحص البول العام)",
      lab_name: "مخبر الهرم للتحاليل الطبية",
      specimen_type: "دم وريدي وبول (Blood & Urine)",
      collected_at: "2026-10-26T09:00:00+03:00",
      performed_at: "2026-10-26T10:30:00+03:00",
      approved_at: "2026-10-26T11:30:00+03:00",
      approved_by_name: "إدارة مخبر الهرم للتحاليل الطبية",
      status: "final",
      lab_notes: "رقم التقرير: 124 · الباب - مقابل الجامع الكبير - بناية حوالات الهرم - داخل القبو · هاتف: +963994904651 · برنامج الوافي",
    },
    p_results: [
      // Blood Tests (Hormones & Biochemistry)
      { type_id: getId("ft4"), value_num: 11.2, unit: "ng/L", ref_low: 9.3, ref_high: 17.1, ref_text: "9.3 - 17.1 ng/l", flag: "normal", notes: "Free T4, Free Thyroxin" },
      { type_id: getId("tsh"), value_num: 1.04, unit: "µIU/mL", ref_low: 0.27, ref_high: 5.10, ref_text: "0.27 - 5.10 µIU/ml", flag: "normal", notes: "TSH 3rd Generation" },
      { type_id: getId("urea"), value_num: 29, unit: "mg/dL", ref_low: 5, ref_high: 45, ref_text: "5 - 45", flag: "normal", notes: "البولة الدموية Urea (فحص سابق: 39 بتاريخ 22/09/2026)" },
      { type_id: getId("creatinine"), value_num: 1.12, unit: "mg/dL", ref_low: 0.7, ref_high: 1.4, ref_text: "0.7 - 1.4", flag: "normal", notes: "كرياتنين Creatinine (فحص سابق: 0.91 بتاريخ 22/09/2026)" },
      { type_id: getId("iron"), value_num: 80, unit: "µg/dL", ref_low: 59, ref_high: 204, ref_text: "59 - 204 µg/dl", flag: "normal", notes: "Iron (Fe) الحديد المصلي" },
      { type_id: getId("ferritin"), value_num: 59.3, unit: "ng/mL", ref_low: 30, ref_high: 400, ref_text: "30 - 400 (بالغين ذكور)", flag: "normal", notes: "Ferritin الفيريتين" },
      { type_id: getId("vitamin_b12"), value_num: 528, unit: "pg/mL", ref_low: 211, ref_high: 946, ref_text: "211 - 946 pg/ml", flag: "normal", notes: "Vitamin B12 (Quantitative) كمي" },
      { type_id: getId("hba1c"), value_num: 5.46, unit: "%", ref_low: null, ref_high: 6.0, ref_text: "طبيعي: < 6% | الهدف لمريض السكري: < 7%", flag: "normal", notes: "Glycosylated, HbA1c خضاب السكري" },
      { type_id: getId("vitamin_d"), value_num: 12.9, unit: "ng/mL", ref_low: 30, ref_high: 100, ref_text: "منخفض: 10 - 30 | طبيعي: 30 - 100", flag: "low", notes: "25-Hydroxyvitamin D3 (منخفض: 12.9)" },

      // Urinalysis: Physical and Chemical
      { type_id: getId("urine_color"), value_text: "Yellow (أصفر)", unit: null, ref_text: "Yellow", flag: "normal", notes: "Color اللون" },
      { type_id: getId("urine_appearance"), value_text: "Slight Turbid (عكر قليلاً)", unit: null, ref_text: "Clear", flag: "borderline", notes: "Appearence المظهر" },
      { type_id: getId("urine_specific_gravity"), value_num: 1.025, unit: "SG", ref_low: 1.005, ref_high: 1.030, ref_text: "1.005 - 1.030", flag: "normal", notes: "Specific Gravity الثقل النوعي" },
      { type_id: getId("urine_ph"), value_num: 5.0, unit: "pH", ref_low: 4.5, ref_high: 8.0, ref_text: "4.5 - 8.0", flag: "normal", notes: "pH الحموضة" },
      { type_id: getId("urine_glucose"), value_text: "Neg. (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Glucose الغلوكوز" },
      { type_id: getId("urine_protein"), value_text: "Neg. (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Protein البروتين" },
      { type_id: getId("urine_blood"), value_text: "trace (أثر)", unit: null, ref_text: "Negative", flag: "borderline", notes: "Hemoglobin الخضاب (أثر خضاب دم في البول)" },
      { type_id: getId("urine_urobilinogen"), value_text: "Normal (طبيعي)", unit: null, ref_text: "Normal", flag: "normal", notes: "Urobilinogen مولد اليوروبيلين" },
      { type_id: getId("urine_bilirubin"), value_text: "Neg. (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Bilirubin البيليروبين" },
      { type_id: getId("urine_nitrite"), value_text: "Neg. (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Nitrite النتريت" },
      { type_id: getId("urine_ketones"), value_text: "Neg. (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Ketone الكيتون" },

      // Urinalysis: Microscopic
      { type_id: getId("urine_wbc"), value_text: "2 - 3 /field", unit: null, ref_text: "0 - 5 /field", flag: "normal", notes: "Leucocytes الكريات البيض المجهرية" },
      { type_id: getId("urine_rbc"), value_text: "3 - 5 /field", unit: null, ref_text: "0 - 2 /field", flag: "high", notes: "Erythrocytes الكريات الحمر المجهرية (حد أعلى/خفيف)" },
      { type_id: getId("urine_epithelial"), value_text: "1 - 2 /field", unit: null, ref_text: "Few", flag: "normal", notes: "Epithelial Cells الخلايا الظهارية" },
      { type_id: getId("urine_casts"), value_text: "0 /field (سلبي)", unit: null, ref_text: "Negative", flag: "normal", notes: "Cylinders الأسطوانات" },
      { type_id: getId("urine_calcium_oxalate"), value_text: "(-) سلبي", unit: null, ref_text: "Negative", flag: "normal", notes: "Ca. Oxalate أوكسالات الكالسيوم" },
      { type_id: getId("urine_urate"), value_text: "(-) سلبي", unit: null, ref_text: "Negative", flag: "normal", notes: "Urate اليورات" },
      { type_id: getId("urine_uric_acid"), value_text: "(-) سلبي", unit: null, ref_text: "Negative", flag: "normal", notes: "Uric Acid حمض البول" },
      { type_id: getId("urine_phosphate"), value_text: "(-) سلبي", unit: null, ref_text: "Negative", flag: "normal", notes: "Phosphate الفوسفات" },
      { type_id: getId("urine_crystals"), value_text: "سلبي (لا توجد بلورات)", unit: null, ref_text: "Negative", flag: "normal", notes: "بلورات البول العامة" },
      { type_id: getId("urine_mucus"), value_text: "+ (إيجابي)", unit: null, ref_text: "Negative", flag: "high", notes: "Mucus المخاط (وجود خيوط مخاطية)" },
    ],
  };

  const { data: rep4Id, error: err4 } = await supabase.rpc("create_lab_report", report4);
  if (err4) throw new Error(`Report 4 creation failed: ${err4.message}`);
  console.log(`Report 4 created successfully: ${rep4Id} (30 observations)`);

  console.log("=========================================");
  console.log("ALL 4 LAB REPORTS AND OBSERVATIONS SEEDED SUCCESSFULLY!");
  console.log("=========================================");
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});

