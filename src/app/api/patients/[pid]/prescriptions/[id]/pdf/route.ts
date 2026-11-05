import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { buildPrescriptionReport, patientFromRow } from "@/lib/pdf/rx-reports";
import { getClinicalContext } from "@/lib/clinical-context-server";
import { getSafetyFacts, getSafetyRules } from "@/lib/safety-server";
import { evaluateSafety } from "@/lib/safety-rules";
import { groupPrescriptions } from "@/lib/prescription";
import { pdfResponse } from "@/lib/pdf/respond";
import type { PatientRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/prescriptions/:id/pdf[?dl=1][&lang=ar|en] — a printable prescription (RLS decides access). */
export async function GET(request: NextRequest, { params }: { params: { pid: string; id: string } }) {
  if (!UUID_RE.test(params.pid) || !UUID_RE.test(params.id)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const [{ data: p }, { data: rx }, { data: meds }] = await Promise.all([
    supabase.from("patients").select("*").eq("id", params.pid).maybeSingle(),
    supabase.from("prescriptions").select("*").eq("id", params.id).eq("patient_id", params.pid).eq("record_status", "active").maybeSingle(),
    supabase.from("medications").select("*").eq("prescription_id", params.id).eq("patient_id", params.pid).eq("record_status", "active").order("recorded_at"),
  ]);
  if (!p || !rx) return new NextResponse("Not found", { status: 404 });
  const q = request.nextUrl.searchParams;
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  try {
    const [ctx, rules, facts] = await Promise.all([getClinicalContext(params.pid), getSafetyRules(), getSafetyFacts(params.pid)]);
    const [one] = groupPrescriptions([rx as Record<string, unknown>], (meds ?? []) as Record<string, unknown>[]);
    const drugs = one.lines.flatMap((l) => [l.name_generic, l.name_brand].filter((x): x is string => Boolean(x)));
    const alerts = evaluateSafety(rules, { context: ctx, drugs, labs: facts.labs, history: facts.history, specialties: "all" }).filter((a) => a.drugs.length > 0);
    const { meta, blocks, filename } = buildPrescriptionReport(patientFromRow(p as PatientRow), one, {
      lang, tz: getTz(), allergies: ctx.allergies.map((a) => a.substance), alerts,
    });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
