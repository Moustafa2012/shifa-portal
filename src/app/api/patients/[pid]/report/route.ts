import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getObsTypes } from "@/lib/data";
import { UUID_RE } from "@/lib/uuid";
import { getTz } from "@/lib/auth";
import { i18n } from "@/lib/i18n";
import { buildPatientReport, type ReportScope } from "@/lib/pdf/reports";
import { getClinicalContext } from "@/lib/clinical-context-server";
import { pdfResponse } from "@/lib/pdf/respond";
import type { PatientRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES: ReportScope[] = ["summary", "vitals", "labs", "full"];

/** GET /api/patients/:pid/report?scope=summary|vitals|labs|full[&type=code&range=30|90|365|all&from=&to=][&dl=1][&lang=ar|en]
 *  A real vector PDF (selectable text, vector charts). Runs as the signed-in user, so RLS decides what is included. */
export async function GET(request: NextRequest, { params }: { params: { pid: string } }) {
  if (!UUID_RE.test(params.pid)) return new NextResponse("Not found", { status: 404 });
  const supabase = createClient();
  const auth = { user: await currentUser() };
  if (!auth.user) return new NextResponse("Unauthorized", { status: 401 });
  const { data: p } = await supabase.from("patients").select("*").eq("id", params.pid).maybeSingle();
  if (!p) return new NextResponse("Not found", { status: 404 });

  const q = request.nextUrl.searchParams;
  const scope = (SCOPES as string[]).includes(q.get("scope") ?? "") ? (q.get("scope") as ReportScope) : "full";
  const typeCode = /^[a-z0-9_]+$/.test(q.get("type") ?? "") ? (q.get("type") as string) : undefined;
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;

  try {
    const { meta, blocks, filename } = await buildPatientReport(supabase, p as PatientRow, {
      lang, tz: getTz(), scope, typeCode, range: q.get("range") ?? undefined, from: date(q.get("from")), to: date(q.get("to")), types: await getObsTypes(),
      ctx: scope === "summary" || scope === "full" ? await getClinicalContext((p as PatientRow).id) : undefined,
    });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
