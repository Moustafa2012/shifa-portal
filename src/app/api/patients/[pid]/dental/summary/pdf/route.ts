import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { localDate } from "@/lib/format";
import { loadPatientDentalSummary } from "@/lib/dental-summary-server";
import { buildDentalSummaryReport } from "@/lib/pdf/dental-summary-report";
import { patientFromRow } from "@/lib/pdf/rx-reports";
import { pdfResponse } from "@/lib/pdf/respond";
import type { PatientRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/dental/summary/pdf[?dl=1][&lang=ar|en] — the dental summary of the file (RLS decides access). */
export async function GET(request: NextRequest, { params }: { params: { pid: string } }) {
  if (!UUID_RE.test(params.pid)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const { data: p } = await createClient().from("patients").select("*").eq("id", params.pid).maybeSingle();
  if (!p) return new NextResponse("Not found", { status: 404 });
  const q = request.nextUrl.searchParams;
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  const tz = getTz();
  try {
    const { summary, alerts } = await loadPatientDentalSummary(params.pid, localDate(new Date(), tz));
    const { meta, blocks, filename } = buildDentalSummaryReport(patientFromRow(p as PatientRow), summary, { lang, tz, alerts });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
