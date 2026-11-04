import { notFound } from "next/navigation";
import Link from "next/link";
import { FileText, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { getShareSession, validToken } from "@/lib/share";
import { Banner } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui/client";
import { openShare } from "@/app/actions/share-viewer";

export const dynamic = "force-dynamic";

  export default function ShareGate({
    params,
    searchParams,
  }: {
    params: { token: string };
    searchParams: { expired?: string; ended?: string };
  }) {
    const { t } = i18n();
    if (!validToken(params.token)) notFound();
    const hasSession = Boolean(getShareSession(params.token));

    return (
        <div className="auth-main">
          <div className="card auth-card">
            <div className="card-head between">
              <span className="chip info">
                <Lock size={13} aria-hidden="true" />
                {t("ملف طبي مشارك", "Shared medical file")}
              </span>
              <span className="chip muted">
                <KeyRound size={13} aria-hidden="true" />
                {t("رمز مرور", "Passcode")}
              </span>
            </div>

            <div className="stack" style={{ gap: ".5rem", marginBlockEnd: "1.25rem" }}>
              <h1 style={{ margin: 0, fontSize: "1.35rem" }}>{t("فتح السجل الطبي", "Unlock medical record")}</h1>
              <p className="muted" style={{ margin: 0 }}>
                {t(
                  "أدخل رمز PIN المكوّن من 6 أرقام الذي شاركه المريض معك للوصول إلى الملف.",
                  "Enter the 6-digit PIN shared by the patient to access this file."
                )}
              </p>
            </div>

            {searchParams.expired && (
              <Banner tone="warn" title={t("انتهت الجلسة أو المشاركة", "Session or share ended")}>
                {t(
                  "انتهت الجلسة أو أُلغيت المشاركة. أدخل الرمز من جديد إن كانت المشاركة سارية.",
                  "The session or share has ended. Enter the PIN again if the share is still valid."
                )}
              </Banner>
            )}

            {searchParams.ended && (
              <Banner tone="ok" title={t("تم إنهاء الجلسة", "Session ended")}>
                {t("أنهيت الجلسة بنجاح وتم تسجيل الخروج بأمان.", "You ended the session successfully and have been logged out securely.")}
              </Banner>
            )}

            {hasSession && (
              <Banner tone="info" title={t("جلسة نشطة متوفرة", "Active session available")}>
                <p style={{ margin: 0 }}>
                  {t("لديك بالفعل جلسة تحقق سارية لهذا الملف الطبي.", "You already have an active verified session for this medical file.")}
                </p>
                <div className="row" style={{ marginBlockStart: ".5rem" }}>
                  <Link href={`/s/${params.token}/view`} className="btn ghost sm">
                    <FileText size={14} aria-hidden="true" />
                    {t("متابعة الجلسة الحالية", "Continue current session")}
                  </Link>
                </div>
              </Banner>
            )}

            <ActionForm action={openShare} className="stack" resetOnSuccess={false}>
              <input type="hidden" name="_t" value={params.token} />
              <div className="field">
                <div className="row between">
                  <label htmlFor="pin">{t("رمز الدخول (PIN)", "Passcode (PIN)")}</label>
                  <span className="hint">{t("6 أرقام", "6 digits")}</span>
                </div>
                <input
                  id="pin"
                  name="pin"
                  className="pin-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoFocus
                  placeholder="••••••"
                  aria-label={t("رمز PIN المكوّن من 6 أرقام", "6-digit PIN")}
                />
              </div>

              <SubmitButton
                className="btn primary lg"
                pending={t("جارٍ التحقق…", "Verifying…")}
                icon={<KeyRound size={18} aria-hidden="true" />}
              >
                {t("فتح الملف الطبي", "Open medical file")}
              </SubmitButton>
            </ActionForm>

            <div className="card-foot">
              <ShieldCheck size={16} aria-hidden="true" />
              <p className="small muted" style={{ margin: 0 }}>
                {t(
                  "الوصول مسجّل ومشفّر. الرابط محدد المدة وقد يُلغى في أي لحظة من المريض.",
                  "Access is logged and encrypted. The link is time-limited and can be revoked by the patient at any moment."
                )}
              </p>
            </div>
          </div>
        </div>
        );
}
