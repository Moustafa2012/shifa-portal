"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/ui/client";
import { explainError, getTz } from "@/lib/auth";
import { parseExamForm } from "@/lib/dental";
import { parseShapes } from "@/lib/dental-imaging";
import { ENTITIES } from "@/lib/entities";
import { parseEntityForm } from "@/lib/entity-form";
import { localDate } from "@/lib/format";
import { i18n } from "@/lib/i18n";
import { CONTRIB_ENTITY } from "@/lib/labels";
import { parsePerioTeeth, type PerioTooth } from "@/lib/perio";
import { buildPerioPlan } from "@/lib/perio-plan";
import { dxErrorText, parseDx } from "@/lib/perio-staging";
import { clearShareSession, clientMeta, getShareSession, setShareSession, validToken } from "@/lib/share";
import { contribState, signaturePng } from "@/lib/share-contrib";
import type { SharePerio } from "@/lib/share-types";
import { BUCKET } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { COST_KIND, CURRENCIES, treatmentError } from "@/lib/treatment";
import { parseTreatmentItem } from "@/lib/treatment-form";
import { UUID_RE } from "@/lib/uuid";

const field = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? "").trim().slice(0, max);

/** The doctor's PIN gate. Every failure path returns a generic message; the database enforces limits. */
export async function openShare(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const rawPin = String(fd.get("pin") ?? "").trim();
  // Support ASCII digits as well as Arabic-Indic digits (٠-٩) and strip dashes/spaces
  const pin = rawPin
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[\s-]/g, "");

  const generic = t("الرابط غير صالح، أو منتهي، أو ملغى.", "This link is invalid, expired or revoked.");
  if (!validToken(token)) return { error: generic };
  if (!pin) return { error: t("أدخل رمز PIN المكوّن من 6 أرقام.", "Enter the 6-digit PIN."), field: "pin" };
  if (!/^\d{6}$/.test(pin)) {
    return { error: t("أدخل رمز PIN المكوّن من 6 أرقام.", "Enter the 6-digit PIN."), field: "pin" };
  }

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_open", {
    p_token: token,
    p_pin: pin,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error || !data) return { error: t("تعذر التحقق الآن. حاول لاحقاً.", "Could not verify right now. Try again later.") };

  const r = data as {
    status: string;
    session_token?: string;
    expires_at?: string;
    attempts_left?: number;
    retry_after_seconds?: number;
  };

  if (r.status === "ok" && r.session_token && r.expires_at) {
    setShareSession(token, r.session_token, Math.floor((Date.parse(r.expires_at) - Date.now()) / 1000));
    return { ok: true, redirectTo: `/s/${token}/view` };
  }

  if (r.status === "invalid_pin") {
    return {
      error: t(
        `الرمز غير صحيح. المحاولات المتبقية: ${r.attempts_left ?? 0}`,
        `Incorrect PIN. Attempts left: ${r.attempts_left ?? 0}`
      ),
      field: "pin",
    };
  }

  if (r.status === "locked") {
    return {
      error: t(
        `تم قفل الرابط مؤقتاً. حاول بعد ${Math.ceil((r.retry_after_seconds ?? 900) / 60)} دقيقة.`,
        `This link is temporarily locked. Try again in ${Math.ceil((r.retry_after_seconds ?? 900) / 60)} minutes.`
      ),
      field: "pin",
    };
  }

  if (r.status === "throttled") {
    return { error: t("محاولات كثيرة من هذا الجهاز. انتظر قليلاً.", "Too many attempts from this device. Please wait.") };
  }

  return { error: generic };
}

export async function endShare(fd: FormData) {
  const token = String(fd.get("_t") ?? "").trim();
  if (!validToken(token)) redirect("/");
  const session = getShareSession(token);
  if (session) {
    const { ipHash, ua } = clientMeta();
    await createAdminClient().rpc("share_end_session", {
      p_session_token: session,
      p_ip_hash: ipHash,
      p_user_agent: ua,
    });
  }
  clearShareSession(token);
  redirect(`/s/${token}?ended=1`);
}

export async function addShareNote(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  const name = String(fd.get("author_name") ?? "").trim();
  const body = String(fd.get("body") ?? "").trim();

  if (!session) return { error: t("انتهت الجلسة. أدخل الرمز من جديد.", "Session ended. Enter the PIN again.") };
  if (name.length < 2) return { error: t("أدخل اسمك كاملاً.", "Enter your full name."), field: "author_name" };
  if (body.length < 1) return { error: t("أدخل نص الملاحظة.", "Enter the note text."), field: "body" };
  if (body.length > 4000) return { error: t("الملاحظة طويلة جداً (الحد الأقصى 4000 حرف).", "The note is too long (4000 characters maximum)."), field: "body" };

  const { ipHash, ua } = clientMeta();
  const { data } = await createAdminClient().rpc("share_add_note", {
    p_session_token: session,
    p_author_name: name.slice(0, 120),
    p_body: body,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const st = (data as { status?: string } | null)?.status;
  if (st === "ok") {
    revalidatePath(`/s/${token}/view`);
    return { ok: true, message: t("أُرسلت الملاحظة للمريض بنجاح.", "Your note was sent to the patient successfully.") };
  }
  if (st === "limit") return { error: t("بلغت الحد الأقصى للملاحظات.", "Note limit reached.") };
  if (st === "forbidden") return { error: t("الملاحظات غير مسموحة في هذه المشاركة.", "Notes are not allowed on this share.") };
  return { error: t("انتهت الجلسة. أدخل الرمز من جديد.", "Session ended. Enter the PIN again.") };
}

/** The clinician states who they are and signs on screen; required once per session before adding anything. */
export async function identifyContributor(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  if (!session) return { error: t("انتهت الجلسة. أدخل الرمز من جديد.", "Session ended. Enter the PIN again.") };

  const name = field(fd, "full_name", 120);
  if (name.length < 3) return { error: t("اكتب اسمك الكامل.", "Enter your full name."), field: "full_name" };
  if (fd.get("attest") !== "on") return { error: t("أكّد الإقرار قبل المتابعة.", "Confirm the statement to continue."), field: "attest" };

  const png = signaturePng(String(fd.get("signature") ?? ""));
  if (!png) return { error: t("وقّع في المربع أولاً.", "Sign in the box first."), field: "signature" };

  const st = await contribState(session);
  if (st.status !== "ok" || !st.patient_id) {
    return { error: t("الإضافة غير مسموحة في هذه المشاركة أو انتهت الجلسة.", "Adding is not allowed on this share, or the session ended.") };
  }
  if (st.contributor) return { ok: true };

  const admin = createAdminClient();
  const path = `${st.patient_id}/signatures/${randomUUID()}.png`;
  const up = await admin.storage.from(BUCKET).upload(path, png, { contentType: "image/png", upsert: false, cacheControl: "0" });
  if (up.error) return { error: t("تعذر حفظ التوقيع. حاول مرة أخرى.", "Could not save the signature. Try again.") };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await admin.rpc("share_identify", {
    p_session_token: session,
    p_full_name: name,
    p_specialty: field(fd, "specialty", 120),
    p_license_no: field(fd, "license_no", 60),
    p_facility: field(fd, "facility", 200),
    p_phone: field(fd, "phone", 40),
    p_signature_path: path,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const status = (data as { status?: string } | null)?.status;
  if (error || status !== "ok") {
    await admin.storage.from(BUCKET).remove([path]);
    return { error: error ? explainError(error, t) : t("الإضافة غير مسموحة في هذه المشاركة.", "Adding is not allowed on this share.") };
  }

  revalidatePath(`/s/${token}/view`);
  return { ok: true, message: t("تم. يمكنك الآن الإضافة إلى الملف.", "Done. You can now add to the file.") };
}

/** The doctor confirms, with one click, that they are the doctor the patient named on the link. */
export async function confirmClinician(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  if (!session) return { error: t("انتهت الجلسة. أدخل الرمز من جديد.", "Session ended. Enter the PIN again.") };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_confirm_clinician", {
    p_session_token: session,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const status = (data as { status?: string } | null)?.status;
  if (error || status !== "ok") {
    return { error: error ? explainError(error, t) : t("الإضافة غير مسموحة في هذه المشاركة أو انتهت الجلسة.", "Adding is not allowed on this share, or the session ended.") };
  }

  revalidatePath(`/s/${token}/view`);
  return { ok: true };
}

const CONTRIB_STATUS: Record<string, [string, string]> = {
  expired: ["انتهت الجلسة أو أُلغيت المشاركة. أدخل الرمز من جديد.", "The session ended or the share was revoked. Enter the PIN again."],
  forbidden: ["هذا النوع من الإضافة غير مسموح في هذه المشاركة.", "This kind of addition is not allowed on this share."],
  identify_first: ["عرّف بنفسك ووقّع أولاً.", "Identify yourself and sign first."],
  limit: ["بلغت هذه المشاركة الحد الأقصى للإضافات.", "This share has reached its limit of additions."],
  invalid: ["بيانات غير صالحة.", "Invalid data."],
  not_found: ["لم يُعثر على السجل أو سبق سحبه.", "Record not found or already withdrawn."],
  reason_required: ["اكتب سبب السحب.", "Enter the reason for withdrawing."],
};

/** Adds one record (visit, diagnosis, procedure, note, medication, appointment, test request, imaging study). */
export async function contributeRecord(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  if (!session) return { error: t(...CONTRIB_STATUS.expired) };

  const table = String(fd.get("_table") ?? "");
  const def = ENTITIES[CONTRIB_ENTITY[table] ?? ""];
  if (!def) return { error: t(...CONTRIB_STATUS.invalid) };

  const parsed = parseEntityForm(def, fd, t);
  if ("error" in parsed) return { error: parsed.error };

  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.row)) {
    if (v !== null && !["source", "source_detail", "specialty_id"].includes(k)) payload[k] = v;
  }

  const enc = String(fd.get("_encounter") ?? "").trim();
  if (enc) {
    if (!UUID_RE.test(enc)) return { error: t(...CONTRIB_STATUS.invalid) };
    payload.encounter_id = enc;
  }

  const who = String(fd.get("_who") ?? "").trim().slice(0, 120);
  if (who) {
    if (table === "clinical_notes" && !payload.author_name) payload.author_name = who;
    if (table === "test_orders" && !payload.ordered_by) payload.ordered_by = who;
    if (table === "medications" && !payload.prescriber_name) payload.prescriber_name = who;
    if (table === "procedures" && !payload.operator_name) payload.operator_name = who;
    if (table === "encounters" && !payload.practitioner_name) payload.practitioner_name = who;
  }

  // The clinic the patient named on the link: the doctor does not type it
  if (["encounters", "procedures", "imaging_studies", "appointments"].includes(table) && !payload.facility_name) {
    const facility = await namedFacility(session);
    if (facility) payload.facility_name = facility;
  }

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_contribute", {
    p_session_token: session,
    p_table: table,
    p_payload: payload,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error) return { error: explainError(error, t) };
  const st = (data as { status?: string } | null)?.status ?? "invalid";
  if (st !== "ok") return { error: t(...(CONTRIB_STATUS[st] ?? CONTRIB_STATUS.invalid)) };

  revalidatePath(`/s/${token}/view`);
  return { ok: true, message: t("أُضيف إلى ملف المريض باسمك.", "Added to the patient's file under your name.") };
}

/** The clinician withdraws something added through this share; it stays in the history with the reason. */
export async function retractContribution(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  if (!session) return { error: t(...CONTRIB_STATUS.expired) };

  const id = String(fd.get("_id") ?? "").trim();
  if (!UUID_RE.test(id)) return { error: t(...CONTRIB_STATUS.invalid) };

  const reason = field(fd, "reason", 400);
  if (reason.length < 3) return { error: t("اكتب سبب السحب (3 أحرف على الأقل).", "Enter the reason for withdrawing (at least 3 characters)."), field: "reason" };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_retract", {
    p_session_token: session,
    p_table: String(fd.get("_table") ?? ""),
    p_id: id,
    p_reason: reason,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error) return { error: explainError(error, t) };
  const st = (data as { status?: string } | null)?.status ?? "invalid";
  if (st !== "ok") return { error: t(...(CONTRIB_STATUS[st] ?? CONTRIB_STATUS.invalid)) };

  revalidatePath(`/s/${token}/view`);
  return { ok: true, message: t("سُحب السجل وبقي في التاريخ مع السبب.", "Withdrawn; it stays in the history with the reason.") };
}

/** The clinic the patient named on the link, so the clinician does not type it. */
async function namedFacility(session: string): Promise<string | null> {
  const { data } = await createAdminClient().rpc("share_clinician", { p_session_token: session });
  return (data as { facility?: string | null } | null)?.facility ?? null;
}

/** A whole dental exam on the chart (tooth states + findings), saved under the clinician's name in one step. */
export async function contributeDentalExam(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  if (!session) return { error: t(...CONTRIB_STATUS.expired) };

  const parsed = parseExamForm(fd, t, localDate(new Date(), getTz()));
  if ("error" in parsed) return { error: parsed.error };

  if (!parsed.exam.facility_name) {
    const facility = await namedFacility(session);
    if (facility) parsed.exam.facility_name = facility;
  }

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_contribute_dental_exam", {
    p_session_token: session,
    p_exam: parsed.exam,
    p_states: parsed.states,
    p_findings: parsed.findings,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error) return { error: explainError(error, t) };
  const st = (data as { status?: string } | null)?.status ?? "invalid";
  if (st !== "ok") return { error: t(...(CONTRIB_STATUS[st] ?? CONTRIB_STATUS.invalid)) };

  revalidatePath(`/s/${token}/view`);
  return { ok: true, message: t("حُفظ الفحص في ملف المريض باسمك.", "The exam was saved to the patient's file under your name.") };
}

// ---------------------------------------------------------------- treatment (dentistry): propose, move along, own cost
const TX_STATUS: Record<string, [string, string]> = {
  ...CONTRIB_STATUS,
  patient_decides: ["الموافقة على العلاج قرار المريض.", "Accepting a treatment is the patient's decision."],
};

function txSession(fd: FormData): { token: string; session: string } | null {
  const token = String(fd.get("_t") ?? "").trim();
  const session = validToken(token) ? getShareSession(token) : null;
  return session ? { token, session } : null;
}

function txAnswer(data: unknown, error: { message: string } | null, t: (a: string, e: string) => string): FormState | null {
  if (error) return { error: treatmentError(error.message, t) ?? explainError(error, t) };
  const r = (data ?? {}) as { status?: string; reason?: string };
  if (r.status === "ok") return null;
  if (r.status === "invalid" && r.reason) return { error: treatmentError(r.reason, t) ?? t(...CONTRIB_STATUS.invalid) };
  return { error: t(...(TX_STATUS[r.status ?? "invalid"] ?? CONTRIB_STATUS.invalid)) };
}

/** The dentist proposes a treatment: to a proposal of theirs ("_plan"), or as a new proposed plan. */
export async function contributeTreatment(_: FormState, fd: FormData): Promise<FormState> {
  const { t, lang } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const parsed = parseTreatmentItem(fd, t);
  if ("error" in parsed) return { error: parsed.error };

  const plan = String(fd.get("_plan") ?? "new").trim();
  const { ipHash, ua } = clientMeta();
  const admin = createAdminClient();
  const item = { ...parsed.item, lang };

  const res =
    plan && plan !== "new"
      ? UUID_RE.test(plan)
        ? await admin.rpc("share_add_treatment_item", {
          p_session_token: s.session,
          p_plan: plan,
          p_item: item,
          p_ip_hash: ipHash,
          p_user_agent: ua,
        })
        : null
      : await admin.rpc("share_contribute_treatment_plan", {
        p_session_token: s.session,
        p_ip_hash: ipHash,
        p_user_agent: ua,
        p_items: [item],
        p_plan: {
          title: String(fd.get("title") ?? "").trim().slice(0, 200) || t("خطة علاج مقترحة", "Proposed treatment plan"),
          lang,
          notes: String(fd.get("plan_notes") ?? "").trim().slice(0, 4000) || null,
          alternative_of: String(fd.get("alternative_of") ?? "").trim() || null,
        },
      });

  if (!res) return { error: t(...CONTRIB_STATUS.invalid) };
  const bad = txAnswer(res.data, res.error, t);
  if (bad) return bad;

  revalidatePath(`/s/${s.token}/view`);
  return { ok: true, message: t("أُضيف العلاج مقترحاً باسمك؛ يعتمده المريض.", "The treatment was proposed under your name; the patient accepts it.") };
}

/** The dentist moves a treatment along (schedules, starts, completes, refers…); completing it records the procedure and updates the chart. */
export async function shareTreatmentStatus(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const id = String(fd.get("_id") ?? "").trim();
  const status = String(fd.get("status") ?? "").trim();
  const date = String(fd.get("date") ?? "").trim();

  if (!UUID_RE.test(id) || !/^[a-z_]{3,20}$/.test(status) || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    return { error: t(...CONTRIB_STATUS.invalid) };
  }

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_treatment_item_status", {
    p_session_token: s.session,
    p_item: id,
    p_status: status,
    p_date: date || null,
    p_reason: String(fd.get("reason") ?? "").trim().slice(0, 500) || null,
    p_confirm: fd.get("confirm_surgical") === "on",
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const bad = txAnswer(data, error, t);
  if (bad) return bad;

  revalidatePath(`/s/${s.token}/view`);
  return {
    ok: true,
    message:
      status === "completed"
        ? t("سُجّل العلاج منجزاً باسمك، وأُضيف الإجراء وحُدّث المخطط.", "Recorded as completed under your name; the procedure was added and the chart updated.")
        : t("تغيّرت حالة العلاج.", "The treatment's status changed."),
  };
}

/** The dentist notes their own cost; the patient sees it, nobody else does. */
export async function shareSetCost(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const id = String(fd.get("_id") ?? "").trim();
  const amount = Number(
    String(fd.get("amount") ?? "")
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/[,،\s]/g, "")
  );
  const currency = String(fd.get("currency") ?? "").trim().toUpperCase();
  const kind = String(fd.get("kind") ?? "estimate").trim();

  if (!UUID_RE.test(id) || !Number.isFinite(amount) || amount < 0 || amount >= 1e10 || !CURRENCIES.includes(currency) || !COST_KIND.some((k) => k.value === kind)) {
    return { error: t("أدخل مبلغاً صحيحاً.", "Enter a valid amount."), field: "amount" };
  }

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_set_cost", {
    p_session_token: s.session,
    p_item: id,
    p_amount: amount,
    p_currency: currency,
    p_kind: kind,
    p_note: String(fd.get("note") ?? "").trim().slice(0, 300) || null,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const bad = txAnswer(data, error, t);
  if (bad) return bad;

  revalidatePath(`/s/${s.token}/view`);
  return { ok: true, message: t("حُفظت تكلفتك (تظهر لك وللمريض فقط).", "Your cost was saved (visible to you and the patient only).") };
}

/** The dentist amends their own signed note: added next to the original, with the reason. */
export async function shareAmendNote(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const id = String(fd.get("_id") ?? "").trim();
  const body = String(fd.get("body") ?? "").trim().slice(0, 20000);
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 500);

  if (!UUID_RE.test(id)) return { error: t(...CONTRIB_STATUS.invalid) };
  if (!body) return { error: t("أدخل نص التعديل.", "Enter the amendment text."), field: "body" };
  if (reason.length < 3) return { error: t("اكتب سبب التعديل (3 أحرف على الأقل).", "Give the reason for the amendment (at least 3 characters)."), field: "reason" };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_amend_note", {
    p_session_token: s.session,
    p_note: id,
    p_body: body,
    p_reason: reason,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  const bad = txAnswer(data, error, t);
  if (bad) return bad;

  revalidatePath(`/s/${s.token}/view`);
  return { ok: true, message: t("أُضيف التعديل الموثّق؛ النص الأصلي محفوظ.", "The amendment was added; the original text is kept.") };
}

/** The dentist draws on an image of the patient (arrows, circles, rectangles, text). Saved under their name; the file is not changed. */
export async function shareAddAnnotation(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const imaging = String(fd.get("imaging_id") ?? "").trim();
  const doc = String(fd.get("document_id") ?? "").trim();
  if (!UUID_RE.test(imaging) || !UUID_RE.test(doc)) return { error: t(...CONTRIB_STATUS.invalid) };

  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("shapes") ?? "[]"));
  } catch {
    return { error: t("الرسم غير صالح.", "Invalid drawing.") };
  }

  const parsed = parseShapes(raw);
  if ("error" in parsed) return { error: t("ارسم شكلاً واحداً على الأقل (حتى 50).", "Draw at least one shape (up to 50).") };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_add_annotation", {
    p_session_token: s.session,
    p_imaging: imaging,
    p_document: doc,
    p_shapes: parsed.shapes,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error) return { error: explainError(error, t) };
  const st = (data as { status?: string } | null)?.status ?? "invalid";
  if (st !== "ok") return { error: t(...(CONTRIB_STATUS[st] ?? CONTRIB_STATUS.invalid)) };

  revalidatePath(`/s/${s.token}/view`);
  return { ok: true, message: t("حُفظ التعليق باسمك (الصورة الأصلية لم تتغير).", "The annotation was saved under your name (the original image is unchanged).") };
}

// ---------------------------------------------------------------- the periodontal chart through the link
/** The periodontist saves their chart as a draft, or finalises it (with the periodontal diagnosis and the visit it belongs to). */
export async function sharePerioSave(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const finalize = fd.get("_finalize") === "1";
  const id = String(fd.get("_id") ?? "").trim();
  if (id && !UUID_RE.test(id)) return { error: t(...CONTRIB_STATUS.invalid) };

  const date = String(fd.get("exam_date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: t("أدخل تاريخ الفحص.", "Enter the exam date."), field: "exam_date" };
  if (date > localDate(new Date(), getTz())) return { error: t("تاريخ الفحص في المستقبل.", "The exam date is in the future."), field: "exam_date" };

  const parsed = parsePerioTeeth(String(fd.get("teeth") ?? "[]"));
  if ("error" in parsed) {
    return {
      error:
        parsed.error === "range"
          ? t("قيمة خارج النطاق: العمق 0–20 مم، حافة اللثة من −15 إلى +15 مم، الحركة 0–3، انقسام الجذور 0–3.", "A value is out of range: depth 0–20 mm, margin −15 to +15 mm, mobility 0–3, furcation 0–3.")
          : t("بيانات المخطط غير صالحة.", "The chart data is invalid."),
    };
  }

  if (finalize && !parsed.teeth.some((x) => x.missing || x.pd)) {
    return { error: t("لا يُعتمد مخطط فارغ: سجّل أعماق الجيوب أولاً.", "An empty chart is not finalised: record the pocket depths first.") };
  }

  const dx = parseDx((k) => String(fd.get(k) ?? ""), finalize);
  if ("error" in dx) return { error: dxErrorText(dx.error, t) ?? t(...CONTRIB_STATUS.invalid) };

  const enc = String(fd.get("encounter_id") ?? "").trim();
  if (enc && !UUID_RE.test(enc)) return { error: t(...CONTRIB_STATUS.invalid) };

  const { ipHash, ua } = clientMeta();
  const { data, error } = await createAdminClient().rpc("share_perio_save", {
    p_session_token: s.session,
    p_exam_id: id || null,
    p_exam: {
      exam_date: date,
      notes: String(fd.get("notes") ?? "").slice(0, 4000),
      facility_name: String(fd.get("facility_name") ?? "").slice(0, 200),
      encounter_id: enc || null,
      ...dx.dx,
    },
    p_teeth: parsed.teeth,
    p_finalize: finalize,
    p_ip_hash: ipHash,
    p_user_agent: ua,
  });

  if (error) return { error: dxErrorText(error.message, t) ?? explainError(error, t) };
  const r = (data ?? {}) as { status?: string; id?: string; reason?: string };

  if (r.status !== "ok") {
    if (r.status === "invalid" && r.reason) {
      if (/exam_empty/.test(r.reason)) return { error: t("لا يُعتمد مخطط فارغ.", "An empty chart is not finalised.") };
      return { error: dxErrorText(r.reason, t) ?? t(...CONTRIB_STATUS.invalid) };
    }
    return { error: t(...(CONTRIB_STATUS[r.status ?? "invalid"] ?? CONTRIB_STATUS.invalid)) };
  }

  revalidatePath(`/s/${s.token}/view`);
  return {
    ok: true,
    data: { id: String(r.id ?? id) },
    redirectTo: finalize ? `/s/${s.token}/view?pdone=1#perio` : undefined,
    message: finalize ? t("اعتُمد مخطط اللثة باسمك.", "The periodontal chart was finalised under your name.") : t("حُفظت المسودة.", "Draft saved."),
  };
}

/** The periodontist lays out the phased plan from a final chart in range (proposed under their name; the patient accepts it). */
export async function sharePerioPlan(_: FormState, fd: FormData): Promise<FormState> {
  const { t, lang } = i18n();
  const s = txSession(fd);
  if (!s) return { error: t(...CONTRIB_STATUS.expired) };

  const id = String(fd.get("_id") ?? "").trim();
  if (!UUID_RE.test(id)) return { error: t(...CONTRIB_STATUS.invalid) };

  const admin = createAdminClient();
  const { data: pd } = await admin.rpc("share_perio", { p_session_token: s.session });
  const perio = pd as SharePerio | null;
  const exam = perio?.status === "ok" ? perio.exams.find((e) => e.id === id && e.status === "final") : undefined;
  if (!exam) return { error: t(...CONTRIB_STATUS.not_found) };

  const plan = buildPerioPlan({ examDate: exam.exam_date, teeth: exam.teeth as PerioTooth[], dx: exam, lang });
  const { ipHash, ua } = clientMeta();
  const { data, error } = await admin.rpc("share_contribute_treatment_plan", {
    p_session_token: s.session,
    p_ip_hash: ipHash,
    p_user_agent: ua,
    p_items: plan.items,
    p_plan: { title: plan.title, lang, notes: plan.notes },
  });

  const bad = txAnswer(data, error, t);
  if (bad) return bad;

  revalidatePath(`/s/${s.token}/view`);
  return { ok: true, message: t("اقترحت خطة اللثة بمراحلها باسمك؛ يعتمدها المريض.", "The phased gum plan was proposed under your name; the patient accepts it.") };
}
