import { i18n } from "@/lib/i18n";
import { LogoMark } from "@/components/Logo";

export function Footer() {
  const { t } = i18n();
  return (
    <footer className="site-footer no-print">
      <div className="site-footer-in">
        <span className="brand"><LogoMark size={24} /><strong>{t("بوابة شفاء", "Shifa Portal")}</strong></span>
        <span>{t("منصة تنظيم المعلومات الصحية.", "A platform of organise health information.")}</span>
      </div>
    </footer>
  );
}
