import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET } from "@/lib/storage";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { buildConsentReport, patientFromRow } from "@/lib/pdf/rx-reports";
import { pdfResponse } from "@/lib/pdf/respond";
import type { ConsentRow } from "@/lib/consent";
import type { PatientRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/consents/:id/pdf[?dl=1][&lang=ar|en] — the consent as signed, with the drawn signature (RLS decides access). */
export async function GET(request: NextRequest, { params }: { params: { pid: string; id: string } }) {
  if (!UUID_RE.test(params.pid) || !UUID_RE.test(params.id)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const [{ data: p }, { data: c }] = await Promise.all([
    supabase.from("patients").select("*").eq("id", params.pid).maybeSingle(),
    supabase.from("consents").select("*").eq("id", params.id).eq("patient_id", params.pid).eq("record_status", "active").maybeSingle(),
  ]);
  if (!p || !c) return new NextResponse("Not found", { status: 404 });
  const q = request.nextUrl.searchParams;
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  try {
    // the signature is read through the server (the bucket is private); the path was already authorised by the row above
    const { data: file } = await createAdminClient().storage.from(BUCKET).download(String(c.signature_path));
    const signature = file ? Buffer.from(await file.arrayBuffer()) : null;
    let covers: string | null = null;
    if (c.treatment_item_id) {
      const { data: it } = await supabase.from("treatment_items").select("name, teeth").eq("id", c.treatment_item_id).eq("patient_id", params.pid).maybeSingle();
      if (it) covers = `${it.name}${Array.isArray(it.teeth) && it.teeth.length ? ` (${it.teeth.join(", ")})` : ""}`;
    } else if (c.treatment_plan_id) {
      const { data: pl } = await supabase.from("treatment_plans").select("title").eq("id", c.treatment_plan_id).eq("patient_id", params.pid).maybeSingle();
      covers = pl?.title ?? null;
    }
    const { meta, blocks, filename } = buildConsentReport(patientFromRow(p as PatientRow), c as unknown as ConsentRow & { body: string }, { lang, tz: getTz(), signature, covers });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
