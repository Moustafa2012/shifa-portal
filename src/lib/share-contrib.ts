import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHash } from "node:crypto";
import { inspectSignature } from "@/lib/signature";
import type { DateCtx } from "@/lib/share-validation";

export interface ContribItem { table: string; id: string; label: string | null; at: string | null; record_status: string; by: string; mine: boolean }
/** the doctor as the patient named them on the link */
export interface ShareClinician { name: string; specialty: string | null; facility: string | null; city: string | null; license: string | null; phone: string | null }
export interface ContribState {
  status: string;
  clinician?: ShareClinician | null;
  patient_id?: string;               // server-side only (storage paths); never rendered
  modules?: string[];
  max?: number;
  used?: number;
  contributor?: { id: string; full_name: string; specialty: string | null; license_no: string | null; facility: string | null } | null;
  items?: ContribItem[];
  encounters?: { id: string; started_at: string; reason: string | null; kind: string }[];
  /** diagnoses this clinician added through the share (dental findings can point at them) */
  conditions?: { id: string; name: string; teeth: number[] | null }[];
  covers_dentistry?: boolean;
}

/** What the clinician in this share session may add, who they said they are, and what was added through the share. */
export async function contribState(session: string): Promise<ContribState> {
  const admin = createAdminClient();
  const [{ data, error }, { data: cl }] = await Promise.all([
    admin.rpc("share_contrib_state", { p_session_token: session }),
    admin.rpc("share_clinician", { p_session_token: session }),
  ]);
  if (error || !data) return { status: "error" };
  const c = cl as (ShareClinician & { status?: string }) | null;
  return { ...(data as ContribState), clinician: c?.status === "ok" && c.name ? c : null };
}

/** Decodes an on-screen signature (PNG data URL); null when it is not a real, reasonably sized, non-blank PNG. */
export function signaturePng(dataUrl: string): Buffer | null {
  const r = inspectSignature(dataUrl);
  return r.ok ? r.bytes : null;
}

// ---------------------------------------------------------------- limits and the gate (migration 0033)
export interface ShareLimits {
  status: string; dob?: string | null; date_from?: string | null; date_to?: string | null; created_at?: string; expires_at?: string; session_expires_at?: string | null;
  uploads?: number; upload_bytes?: number; max?: number; used?: number; contributor_name?: string | null; facility?: string | null;
}
/** What a form needs to apply the rules (and the actions use as the authority): the patient's birth, the period of the link, what is left. */
export async function shareLimits(session: string): Promise<ShareLimits> {
  const { data, error } = await createAdminClient().rpc("share_limits", { p_session_token: session });
  return error || !data ? { status: "error" } : (data as ShareLimits);
}
export const dateCtxOf = (l: ShareLimits, today: string): DateCtx => ({ today, dob: l.dob ?? null, from: l.date_from ?? null, to: l.date_to ?? null });

/** The key of one submission: the action and every field except the identity of the session. Two identical submissions share a key. */
export function submissionKey(action: string, fd: FormData): string {
  const parts: string[] = [action];
  for (const [k, v] of fd.entries()) if (typeof v === "string" && k !== "_t" && !k.startsWith("$ACTION")) parts.push(`${k}=${v}`);
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}
export type Gate = "ok" | "duplicate" | "rate_limited" | "expired";
export async function claimSubmission(session: string, key: string): Promise<Gate> {
  const { data, error } = await createAdminClient().rpc("share_claim_submission", { p_session_token: session, p_key: key });
  const st = (data as { status?: string } | null)?.status;
  if (error) return "ok";                              // the gate is a convenience; the database still enforces the burst limit
  return st === "duplicate" || st === "rate_limited" || st === "expired" ? st : "ok";
}
export async function releaseSubmission(session: string, key: string): Promise<void> {
  await createAdminClient().rpc("share_release_submission", { p_session_token: session, p_key: key });
}
