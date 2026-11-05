import Link from "next/link";
import { Plus } from "lucide-react";
import { i18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { PageHead } from "@/components/ui";
import { Button } from "@/components/ui/button";
import type { PatientRow } from "@/lib/types";
import { getAttention } from "@/lib/care/server";
import { countsByPatient } from "@/lib/care/attention";
import { PatientsDirectory } from "@/components/patients/PatientsDirectory";

export const metadata = { title: "المرضى" };

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: { deleted?: string };
}) {
  const { lang, t } = i18n();
  const supabase = createClient();
  const [{ data: patients }, { data: members }, { data: allergies }, attention] =
    await Promise.all([
      supabase.from("patients").select("*").order("created_at"),
      supabase
        .from("patient_members")
        .select("patient_id, role")
        .is("revoked_at", null),
      supabase
        .from("allergies")
        .select("patient_id")
        .eq("status", "active")
        .eq("record_status", "active"),
      getAttention(),
    ]);

  const attn = countsByPatient(attention);
  const attentionMap = Object.fromEntries(attn.entries());
  const roles = Object.fromEntries(
    (members ?? []).map((m) => [m.patient_id as string, m.role as string])
  );
  const allergicIds = (allergies ?? []).map((a) => a.patient_id as string);
  const list = (patients ?? []) as PatientRow[];

  return (
    <>
      <PageHead
        title={t("ملفات المرضى", "Patient Files")}
        sub={t(
          "لكل مريض ملف صحي مستقل. يمكنك إدارة ملفك وملفات من ترعاهم (الأطفال مثلاً) والوصول السريع لكافة البيانات.",
          "Each patient has an independent health file. Manage your own and those you care for, such as children, with quick access to all clinical records."
        )}
        actions={
          <Button asChild className="gap-2">
            <Link href="/patients/new">
              <Plus className="size-4" aria-hidden="true" />
              {t("ملف جديد", "New file")}
            </Link>
          </Button>
        }
      />

      <PatientsDirectory
        patients={list}
        roles={roles}
        allergicIds={allergicIds}
        attentionMap={attentionMap}
        deletedNotice={searchParams.deleted}
        lang={lang}
      />
    </>
  );
}
