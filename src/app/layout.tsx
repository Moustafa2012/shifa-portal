import type { Metadata, Viewport } from "next";
import "./supabase-tokens.css";
import "./globals.css";
import { i18n } from "@/lib/i18n";
import { getSidebarMode, getTheme, getTz } from "@/lib/auth";
import { TzSetter } from "@/components/ui/client";
import { Suspense } from "react";
import { TopProgress } from "@/components/TopProgress";

export const metadata: Metadata = {
  title: { default: "بوابة شفاء · Shifa Portal", template: "%s · بوابة شفاء" },
  description: "سجل صحي إلكتروني متكامل لمتابعة الحالات الطبية ومشاركتها بأمان",
  robots: { index: false, follow: false },
  applicationName: "بوابة شفاء",
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fcfcfc" }, { media: "(prefers-color-scheme: dark)", color: "#121212" }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, dir, t } = i18n();
  const theme = getTheme();
  return (
    <html lang={lang} dir={dir} data-theme={theme ?? undefined} data-sidebar={getSidebarMode()}>
      <body>
        <a className="skip-link" href="#main">{t("تخطَّ إلى المحتوى", "Skip to content")}</a>
        <Suspense fallback={null}><TopProgress /></Suspense>
        <TzSetter current={getTz()} />
        {children}
      </body>
    </html>
  );
}
