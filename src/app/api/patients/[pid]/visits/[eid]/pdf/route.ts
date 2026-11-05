import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE, getObsTypes, getSpecialties, specialtyName } from "@/lib/data";
import { i18n } from "@/lib/i18n";
import { buildEncounterReport } from "@/lib/pdf/reports";
import { pdfResponse } from "@/lib/pdf/respond";
import type { ObservationRow, PatientRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/visits/:eid/pdf[?dl=1][&lang=ar|en] — printable clinical encounter note */
export async function GET(request: NextRequest, { params }: { params: { pid: string; eid: string } }) {
  if (!UUID_RE.test(params.pid) || !UUID_RE.test(params.eid)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const [{ data: p }, { data: e }] = await Promise.all([
    supabase.from("patients").select("*").eq("id", params.pid).maybeSingle(),
    supabase.from("encounters").select("*").eq("id", params.eid).eq("patient_id", params.pid).eq("record_status", "active").maybeSingle(),
  ]);
  if (!p || !e) return new NextResponse("Not found", { status: 404 });

  const q = request.nextUrl.searchParams;
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  const tz = getTz();

  const [specs, { data: conds }, { data: meds }, { data: procs }, { data: obs }, types] = await Promise.all([
    getSpecialties(),
    supabase.from("conditions").select("name, clinical_status").eq("encounter_id", e.id).eq("patient_id", p.id).eq("record_status", "active"),
    supabase.from("medications").select("name_generic, name_brand, dose, frequency, route").eq("encounter_id", e.id).eq("patient_id", p.id).eq("record_status", "active"),
    supabase.from("procedures").select("name, kind, outcome").eq("encounter_id", e.id).eq("patient_id", p.id).eq("record_status", "active"),
    supabase.from("observations").select("*").eq("encounter_id", e.id).eq("patient_id", p.id).order("effective_at", { ascending: false }),
    getObsTypes(),
  ]);

  const specLabel = e.specialty_id ? specialtyName(specs, e.specialty_id, lang) : null;

  try {
    const { meta, blocks, filename } = buildEncounterReport(p as PatientRow, e as Record<string, unknown>, {
      lang,
      tz,
      specialtyName: specLabel,
      conditions: (conds ?? []) as { name: string; clinical_status?: string }[],
      medications: (meds ?? []) as { name_generic?: string; name_brand?: string; dose?: string; frequency?: string; route?: string }[],
      procedures: (procs ?? []) as { name: string; kind?: string; outcome?: string }[],
      observations: (obs ?? []) as ObservationRow[],
      types,
    });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (err) {
    console.error("[pdf-error]", String((err as Error)?.message ?? err).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}

