import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { buildPerioReport } from "@/lib/pdf/reports";
import { pdfResponse } from "@/lib/pdf/respond";
import type { PatientRow } from "@/lib/types";
import type { PerioExam, PerioTooth } from "@/lib/perio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/perio/:id/pdf[?dl=1][&lang=ar|en] — one periodontal chart, with the change since the final chart before it (RLS decides access). */
export async function GET(request: NextRequest, { params }: { params: { pid: string; id: string } }) {
  if (!UUID_RE.test(params.pid) || !UUID_RE.test(params.id)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const [{ data: p }, { data: exam }] = await Promise.all([
    supabase.from("patients").select("*").eq("id", params.pid).maybeSingle(),
    supabase.from("perio_exams").select("*").eq("id", params.id).eq("patient_id", params.pid).eq("record_status", "active").maybeSingle(),
  ]);
  if (!p || !exam) return new NextResponse("Not found", { status: 404 });
  const { data: prev } = await supabase.from("perio_exams").select("*").eq("patient_id", params.pid).eq("record_status", "active").eq("status", "final")
    .lt("exam_date", exam.exam_date as string).order("exam_date", { ascending: false }).limit(1).maybeSingle();
  const ids = [exam.id as string, ...(prev ? [prev.id as string] : [])];
  const { data: teeth } = await supabase.from("perio_teeth").select("*").eq("patient_id", params.pid).in("exam_id", ids);
  const withTeeth = (e: Record<string, unknown>) => ({ ...e, teeth: ((teeth ?? []) as (PerioTooth & { exam_id: string })[]).filter((x) => x.exam_id === e.id) }) as unknown as PerioExam;
  const q = request.nextUrl.searchParams;
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  try {
    const { meta, blocks, filename } = buildPerioReport(p as PatientRow, withTeeth(exam), { lang, tz: getTz(), previous: prev ? withTeeth(prev) : null });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
