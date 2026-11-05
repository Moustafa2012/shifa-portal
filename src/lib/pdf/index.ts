import "server-only";

export * from "@/lib/pdf/engine";
export * from "@/lib/pdf/respond";
export * from "@/lib/pdf/reports";
export * from "@/lib/pdf/rx-reports";
export * from "@/lib/pdf/dental-summary-report";
export * from "@/lib/pdf/emergency";

export type ReportCategory = "core" | "specialty" | "legal" | "emergency";

export interface ReportCatalogEntry {
  id: string;
  category: ReportCategory;
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  badge?: { ar: string; en: string };
  icon: string;
  buildUrl: (pid: string, options?: { lang?: "ar" | "en"; dl?: boolean; range?: string; from?: string; to?: string; type?: string; costs?: boolean }) => string;
}

/**
 * Master Index of all PDF reports available in Shifa Portal.
 * Used for report navigation, directory listing, and batch export.
 */
export const REPORT_CATALOG: ReportCatalogEntry[] = [
  {
    id: "full",
    category: "core",
    name: { ar: "التقرير الطبي الشامل", en: "Complete Medical Record" },
    description: {
      ar: "سجل متكامل يتضمن بيانات المريض، معلومات السلامة، الحساسية، الأمراض، الأدوية، القياسات، التحاليل، العمليات، الأشعة، التطعيمات، خطط العلاج والمستندات.",
      en: "Comprehensive file with safety alerts, allergies, conditions, medications, vitals, labs, procedures, imaging, immunizations, care plans, and attached documents.",
    },
    badge: { ar: "شامل", en: "Comprehensive" },
    icon: "file-text",
    buildUrl: (pid, opts) => `/api/patients/${pid}/report?scope=full${opts?.lang ? `&lang=${opts.lang}` : ""}${opts?.dl ? "&dl=1" : ""}`,
  },
  {
    id: "summary",
    category: "core",
    name: { ar: "الملخص الصحي التنفيذي", en: "Executive Health Summary" },
    description: {
      ar: "ملخص موجز ومركّز يبرز معلومات السلامة الأساسية، الحساسية، الأمراض المزمنة، الأدوية الحالية، وآخر نتائج القياسات والمختبر.",
      en: "Concise summary highlighting critical safety alerts, allergies, chronic conditions, active medications, and latest vitals/labs.",
    },
    badge: { ar: "سريع", en: "Quick" },
    icon: "clipboard-list",
    buildUrl: (pid, opts) => `/api/patients/${pid}/report?scope=summary${opts?.lang ? `&lang=${opts.lang}` : ""}${opts?.dl ? "&dl=1" : ""}`,
  },
  {
    id: "vitals",
    category: "core",
    name: { ar: "تقرير القياسات الحيوية", en: "Vital Signs & Trends Report" },
    description: {
      ar: "تقرير بياني وجدولي تفصيلي لتطور ضغط الدم، السكر، النبض، الحرارة، الوزن وباقي القياسات مع المتوسطات والمجالات الطبيعية.",
      en: "Detailed tabular and charted report for blood pressure, glucose, heart rate, weight, with statistical ranges and trends.",
    },
    badge: { ar: "مخططات", en: "Charts" },
    icon: "activity",
    buildUrl: (pid, opts) => {
      const q = new URLSearchParams({ scope: "vitals" });
      if (opts?.lang) q.set("lang", opts.lang);
      if (opts?.dl) q.set("dl", "1");
      if (opts?.range) q.set("range", opts.range);
      if (opts?.from) q.set("from", opts.from);
      if (opts?.to) q.set("to", opts.to);
      if (opts?.type) q.set("type", opts.type);
      return `/api/patients/${pid}/report?${q.toString()}`;
    },
  },
  {
    id: "labs",
    category: "core",
    name: { ar: "تقرير التحاليل المخبرية", en: "Laboratory Results Report" },
    description: {
      ar: "تقرير موثق لنتائج التحاليل مرتبة حسب المجموعات المخبرية (صورة الدم، وظائف الكلى، الدهون…) مع المجالات المرجعية وتصنيفات الشذوذ.",
      en: "Documented lab results grouped by panel (CBC, renal, lipid profile) with reference ranges and abnormal flags.",
    },
    badge: { ar: "مخبري", en: "Laboratory" },
    icon: "flask-conical",
    buildUrl: (pid, opts) => `/api/patients/${pid}/report?scope=labs${opts?.lang ? `&lang=${opts.lang}` : ""}${opts?.dl ? "&dl=1" : ""}`,
  },
  {
    id: "dental-summary",
    category: "specialty",
    name: { ar: "ملخص طب الأسنان الشامل", en: "Dental Summary Report" },
    description: {
      ar: "مخطط الأسنان الحالي، الأسنان المفقودة والمرممة، حالة اللثة والجيوب، اختبارات حيوية العصب، قراءات العظم الشعاعي والمواعيد الدورية.",
      en: "Current dental charting, missing and restored teeth, periodontal status, pulp tests, bone readings, and recall schedules.",
    },
    badge: { ar: "أسنان", en: "Dental" },
    icon: "smile",
    buildUrl: (pid, opts) => `/api/patients/${pid}/dental/summary/pdf?${opts?.lang ? `lang=${opts.lang}&` : ""}${opts?.dl ? "dl=1" : ""}`.replace(/\?$/, ""),
  },
  {
    id: "emergency",
    category: "emergency",
    name: { ar: "بطاقة الطوارئ الطبية السريعة", en: "Medical Emergency Card" },
    description: {
      ar: "بطاقة طوارئ سريعة للمحفظة أو شاشة القفل، بفصيلة الدم، الحساسيات الحرجة، الأجهزة المزروعة وسلامة الرنين، وجهات الطوارئ مع رمز QR.",
      en: "Fast emergency wallet card with blood group, severe allergies, implants, MRI safety, and ICE contacts with scannable QR code.",
    },
    badge: { ar: "طوارئ", en: "Emergency" },
    icon: "siren",
    buildUrl: (pid, opts) => `/api/patients/${pid}/emergency/pdf?${opts?.lang ? `lang=${opts.lang}&` : ""}${opts?.dl ? "dl=1" : ""}`.replace(/\?$/, ""),
  },
];

