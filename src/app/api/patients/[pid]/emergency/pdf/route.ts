import { NextResponse, type NextRequest } from "next/server";
import { currentUser, getTz } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/uuid";
import { i18n } from "@/lib/i18n";
import { siteUrl } from "@/lib/env";
import { asCard, emergencyLink, tokenFromForm } from "@/lib/care/emergency";
import { buildEmergencyReport } from "@/lib/pdf/emergency";
import { pdfResponse } from "@/lib/pdf/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function render(request: NextRequest, pid: string, token: string | null) {
  if (!UUID_RE.test(pid)) return new NextResponse("Not found", { status: 404 });
  if (!(await currentUser())) return new NextResponse("Unauthorized", { status: 401 });
  const supabase = createClient();
  const [{ data: raw }, { data: p }] = await Promise.all([supabase.rpc("emergency_preview", { p_patient: pid }), supabase.from("patients").select("mrn").eq("id", pid).maybeSingle()]);
  const card = asCard(raw);
  if (!card || !p) return new NextResponse("Not found", { status: 404 });
  // a QR only for the file's current token: the database checks it, so a stale or foreign token draws no code
  let link: string | null = null;
  if (token) {
    const { data: ok } = await supabase.rpc("emergency_token_ok", { p_patient: pid, p_token: token });
    if (ok === true) link = emergencyLink(process.env.NEXT_PUBLIC_SITE_URL ? siteUrl() : request.headers.get("origin") ?? request.nextUrl.origin, token);
  }
  try {
    const requestedLang = request.nextUrl.searchParams.get("lang");
    const lang: "ar" | "en" = requestedLang === "ar" || requestedLang === "en" ? requestedLang : i18n().lang;
    const { meta, blocks, filename } = buildEmergencyReport(card, { lang, tz: getTz(), link, mrn: p.mrn as string });
    return await pdfResponse(meta, blocks, filename, {}, request.nextUrl.searchParams.get("dl") === "1");
  } catch (e) {
    console.error("[pdf-error]", String((e as Error)?.message ?? e).slice(0, 300));
    return new NextResponse("Could not create the PDF", { status: 500 });
  }
}

/** GET /api/patients/:pid/emergency/pdf — the printable card without a QR (the token is not kept, so it cannot be drawn later). */
export async function GET(request: NextRequest, { params }: { params: { pid: string } }) {
  return render(request, params.pid, null);
}

/** POST (a form with the token just made) — the same card with the QR of the live link. The token travels in the body, never in a URL. */
export async function POST(request: NextRequest, { params }: { params: { pid: string } }) {
  const fd = await request.formData().catch(() => null);
  return render(request, params.pid, fd ? tokenFromForm(fd.get("token")) : null);
}
