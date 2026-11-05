import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { buildTreatmentPlanReport } from "@/lib/pdf/reports";
import { getClinicalContext } from "@/lib/clinical-context-server";
import { pdfResponse } from "@/lib/pdf/respond";
import { getProcedureCatalog } from "@/lib/data";
import { getSafetyFacts, getSafetyRules } from "@/lib/safety-server";
import { evaluateSafety } from "@/lib/safety-rules";
import { OPEN_ITEM } from "@/lib/treatment";
import type { PatientRow } from "@/lib/types";
import type { TreatmentCost, TreatmentItem, TreatmentPlan } from "@/lib/treatment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/patients/:pid/treatment-plans/:id/pdf[?costs=1][&dl=1][&lang=ar|en] — the plan with its consent section (RLS decides access). */
export async function GET(request: NextRequest, { params }: { params: { pid: string; id: string } }) {
  if (!UUID_RE.test(params.pid) || !UUID_RE.test(params.id)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const q = request.nextUrl.searchParams;
  const [{ data: p }, { data: plan }, { data: items }, { data: conds }] = await Promise.all([
    supabase.from("patients").select("*").eq("id", params.pid).maybeSingle(),
    supabase.from("treatment_plans").select("*").eq("id", params.id).eq("patient_id", params.pid).eq("record_status", "active").maybeSingle(),
    supabase.from("treatment_items").select("*").eq("plan_id", params.id).eq("patient_id", params.pid).eq("record_status", "active").order("phase").order("sort"),
    supabase.from("conditions").select("id, name").eq("patient_id", params.pid).eq("record_status", "active"),
  ]);
  if (!p || !plan) return new NextResponse("Not found", { status: 404 });
  const withCosts = q.get("costs") === "1";
  const { data: costs } = withCosts
    ? await supabase.from("treatment_costs").select("*").eq("patient_id", params.pid).eq("record_status", "active").in("item_id", (items ?? []).map((i) => i.id as string))
    : { data: null };
  const requestedLang = q.get("lang");
  const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
  try {
    const ctx = await getClinicalContext(params.pid);
    // safety alerts: the reviewable rules against the file and this plan's treatments that are still to happen
    const [rules, facts, catalog] = await Promise.all([getSafetyRules(), getSafetyFacts(params.pid), getProcedureCatalog()]);
    const alerts = evaluateSafety(rules, {
      context: ctx, labs: facts.labs, history: facts.history,
      items: ((items ?? []) as TreatmentItem[]).filter((i) => OPEN_ITEM.has(i.status))
        .map((i) => ({ id: i.id, name: i.name, catalog_code: i.catalog_code, category: catalog.find((c) => c.code === i.catalog_code)?.category ?? null, teeth: i.teeth })),
    });
    const { meta, blocks, filename } = buildTreatmentPlanReport(p as PatientRow, { ...(plan as TreatmentPlan), items: (items ?? []) as TreatmentItem[] }, {
      lang, tz: getTz(), ctx, alerts, problems: (conds ?? []) as { id: string; name: string }[],
      costs: withCosts ? ((costs ?? []) as TreatmentCost[]) : null,
    });
    return await pdfResponse(meta, blocks, filename, {}, q.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}
