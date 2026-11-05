"use client";

import * as React from "react";
import Link from "next/link";
import {
  Users,
  UserCheck,
  HeartHandshake,
  ShieldAlert,
  TriangleAlert,
  Search,
  X,
  LayoutGrid,
  List,
  ArrowUpDown,
  Plus,
  ArrowLeft,
  ArrowRight,
  Droplets,
  Smile,
  Activity,
  FileText,
  Calendar,
  Share2,
  MoreVertical,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  Settings,
} from "lucide-react";

import { useDirection } from "@/components/ui/direction";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Banner, Empty } from "@/components/ui";
import { Avatar } from "@/components/Avatar";
import { ageLabel } from "@/lib/format";
import { lbl, SEX } from "@/lib/labels";
import { attentionBadges, type AttentionCode } from "@/lib/care/attention";
import type { PatientRow } from "@/lib/types";

interface PatientsDirectoryProps {
  patients: PatientRow[];
  roles: Record<string, string>;
  allergicIds: string[];
  attentionMap: Record<string, Partial<Record<AttentionCode, number>>>;
  deletedNotice?: string;
  lang: "ar" | "en";
}

type FilterTab = "all" | "self" | "family" | "attention" | "allergies";
type SortOption = "newest" | "name" | "age_asc" | "age_desc" | "attention";

export function PatientsDirectory({
  patients,
  roles,
  allergicIds,
  attentionMap,
  deletedNotice,
  lang,
}: PatientsDirectoryProps) {
  const direction = useDirection();
  const isRtl = direction === "rtl" || lang === "ar";
  const t = React.useCallback(
    (ar: string, en: string) => (lang === "ar" ? ar : en),
    [lang]
  );

  const [searchQuery, setSearchQuery] = React.useState("");
  const [filterTab, setFilterTab] = React.useState<FilterTab>("all");
  const [sortBy, setSortBy] = React.useState<SortOption>("newest");
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const allergicSet = React.useMemo(() => new Set(allergicIds), [allergicIds]);

  // Compute counts for KPI ribbon and tab badges
  const totalCount = patients.length;
  const selfPatient = patients.find((p) => roles[p.id] === "owner");
  const selfCount = selfPatient ? 1 : 0;
  const familyCount = patients.filter((p) => roles[p.id] !== "owner").length;
  const attentionCount = patients.filter((p) => {
    const badges = attentionBadges(attentionMap[p.id], t);
    return badges.length > 0;
  }).length;
  const allergyCount = patients.filter((p) => allergicSet.has(p.id)).length;

  const handleCopyMrn = (e: React.MouseEvent, mrn: string, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(mrn);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 2000);
  };

  // Filtered and sorted patients
  const filteredPatients = React.useMemo(() => {
    return patients
      .filter((p) => {
        // Tab Filter
        if (filterTab === "self" && roles[p.id] !== "owner") return false;
        if (filterTab === "family" && roles[p.id] === "owner") return false;
        if (filterTab === "allergies" && !allergicSet.has(p.id)) return false;
        if (filterTab === "attention") {
          const badges = attentionBadges(attentionMap[p.id], t);
          if (badges.length === 0) return false;
        }

        // Search Query
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase().trim();
        const matchNameAr = p.full_name?.toLowerCase().includes(q);
        const matchNameEn = p.full_name_en?.toLowerCase().includes(q);
        const matchMrn = p.mrn?.toLowerCase().includes(q);
        const matchPhone = p.phone?.toLowerCase().includes(q);
        const matchCity = p.city?.toLowerCase().includes(q);

        return matchNameAr || matchNameEn || matchMrn || matchPhone || matchCity;
      })
      .sort((a, b) => {
        if (sortBy === "name") {
          const nameA = (lang === "en" && a.full_name_en ? a.full_name_en : a.full_name) || "";
          const nameB = (lang === "en" && b.full_name_en ? b.full_name_en : b.full_name) || "";
          return nameA.localeCompare(nameB, lang === "ar" ? "ar" : "en");
        }
        if (sortBy === "age_asc") {
          return new Date(b.date_of_birth).getTime() - new Date(a.date_of_birth).getTime();
        }
        if (sortBy === "age_desc") {
          return new Date(a.date_of_birth).getTime() - new Date(b.date_of_birth).getTime();
        }
        if (sortBy === "attention") {
          const attnA = attentionBadges(attentionMap[a.id], t).length;
          const attnB = attentionBadges(attentionMap[b.id], t).length;
          return attnB - attnA;
        }
        // "newest" by default
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [patients, filterTab, searchQuery, sortBy, roles, allergicSet, attentionMap, lang, t]);

  if (patients.length === 0) {
    return (
      <Empty>
        <Users className="size-12 text-muted-foreground mb-2" />
        <h3 className="text-lg font-semibold">{t("لا توجد ملفات صحية بعد", "No health files yet")}</h3>
        <p className="text-muted-foreground max-w-md text-sm">
          {t(
            "ابدأ بإنشاء ملفك الصحي الشخصي أو ملف لأحد أفراد عائلتك لمتابعة الفحوصات والزيارات والتاريخ الطبي.",
            "Start by creating your own health file or a dependent's file to track medical visits, tests, and care."
          )}
        </p>
        <Button asChild className="gap-2 mt-4">
          <Link href="/patients/new">
            <Plus className="size-4" />
            {t("إنشاء ملف جديد", "Create a file")}
          </Link>
        </Button>
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      {/* Permanent Deletion Notification */}
      {deletedNotice && (
        <Banner tone="ok">
          {t("حُذف الملف نهائياً بنجاح.", "The patient file was permanently deleted.")}
        </Banner>
      )}

      {/* KPI Stats Ribbon */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Files */}
        <Card className="p-4 flex items-center justify-between border border-border/40 shadow-sm hover:shadow transition-shadow">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("إجمالي الملفات", "Total Files")}
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {totalCount}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("ملف تحت إدارتك", "Files managed")}
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
            <Users className="size-5" />
          </div>
        </Card>

        {/* My File */}
        <Card className="p-4 flex items-center justify-between border border-border/40 shadow-sm hover:shadow transition-shadow">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("الملف الشخصي", "My Profile")}
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {selfPatient ? (
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="size-4 inline" /> {t("مُفعّل", "Active")}
                </span>
              ) : (
                <span className="text-sm font-medium text-muted-foreground">
                  {t("لم يُنشأ", "Not created")}
                </span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground truncate max-w-[120px]">
              {selfPatient
                ? (lang === "en" && selfPatient.full_name_en ? selfPatient.full_name_en : selfPatient.full_name)
                : t("سجلك الأساسي", "Primary record")}
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <UserCheck className="size-5" />
          </div>
        </Card>

        {/* Family & Dependents */}
        <Card className="p-4 flex items-center justify-between border border-border/40 shadow-sm hover:shadow transition-shadow">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("العائلة والرعاية", "Family & Dependents")}
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {familyCount}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("أطفال ومعالون", "Children & wards")}
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
            <HeartHandshake className="size-5" />
          </div>
        </Card>

        {/* Attention / Alerts */}
        <Card className="p-4 flex items-center justify-between border border-border/40 shadow-sm hover:shadow transition-shadow">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("بحاجة لمراجعة", "Needs Attention")}
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {attentionCount > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{attentionCount}</span>
              ) : (
                <span className="text-muted-foreground text-base font-normal">0</span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {attentionCount > 0 ? t("فحوصات أو تنبيهات", "Alerts or tests") : t("كل شيء محدّث", "All up to date")}
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-5" />
          </div>
        </Card>
      </div>

      {/* Toolbar: Search, Filter Tabs, Sort, and View Controls */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-card p-3 shadow-sm">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("ابحث بالاسم، رقم الملف MRN، أو الهاتف...", "Search by name, MRN, phone...")}
              className="ps-9 pe-9 h-9 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute end-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-full"
                aria-label={t("مسح البحث", "Clear search")}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Sort & View Mode Switches */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Sort Selector */}
            <div className="flex items-center gap-1.5 border border-border/40 rounded-md px-2 py-1 bg-background text-xs text-muted-foreground">
              <ArrowUpDown className="size-3.5" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="bg-transparent border-none text-foreground text-xs focus:outline-none cursor-pointer"
                aria-label={t("ترتيب حسب", "Sort by")}
              >
                <option value="newest">{t("الأحدث إضافة", "Newest added")}</option>
                <option value="name">{t("الاسم أبجدياً", "Name A-Z")}</option>
                <option value="age_asc">{t("الأصغر سناً", "Youngest")}</option>
                <option value="age_desc">{t("الأكبر سناً", "Oldest")}</option>
                <option value="attention">{t("الأولوية للمتابعة", "Needs Attention first")}</option>
              </select>
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center border border-border/40 rounded-md p-0.5 bg-background">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded text-xs transition-colors ${
                  viewMode === "grid"
                    ? "bg-accent text-accent-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={t("عرض شبكي", "Grid view")}
                aria-label={t("عرض شبكي", "Grid view")}
              >
                <LayoutGrid className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`p-1.5 rounded text-xs transition-colors ${
                  viewMode === "table"
                    ? "bg-accent text-accent-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={t("عرض جدولي", "Table view")}
                aria-label={t("عرض جدولي", "Table view")}
              >
                <List className="size-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Filter Pills / Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/50">
          <Button
            type="button"
            variant={filterTab === "all" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilterTab("all")}
            className="h-7 text-xs px-2.5 rounded-full"
          >
            {t("الكل", "All")}
            <span className="ms-1.5 text-[11px] opacity-75 font-mono">{totalCount}</span>
          </Button>

          {selfCount > 0 && (
            <Button
              type="button"
              variant={filterTab === "self" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilterTab("self")}
              className="h-7 text-xs px-2.5 rounded-full"
            >
              <UserCheck className="size-3 me-1" />
              {t("ملفي الشخصي", "My File")}
            </Button>
          )}

          {familyCount > 0 && (
            <Button
              type="button"
              variant={filterTab === "family" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilterTab("family")}
              className="h-7 text-xs px-2.5 rounded-full"
            >
              <HeartHandshake className="size-3 me-1" />
              {t("العائلة والرعاية", "Family & Care")}
              <span className="ms-1.5 text-[11px] opacity-75 font-mono">{familyCount}</span>
            </Button>
          )}

          {attentionCount > 0 && (
            <Button
              type="button"
              variant={filterTab === "attention" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilterTab("attention")}
              className="h-7 text-xs px-2.5 rounded-full text-amber-700 dark:text-amber-300 font-medium"
            >
              <ShieldAlert className="size-3 me-1" />
              {t("تحتاج متابعة", "Needs Attention")}
              <span className="ms-1.5 text-[11px] opacity-90 font-mono">{attentionCount}</span>
            </Button>
          )}

          {allergyCount > 0 && (
            <Button
              type="button"
              variant={filterTab === "allergies" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilterTab("allergies")}
              className="h-7 text-xs px-2.5 rounded-full text-rose-700 dark:text-rose-300 font-medium"
            >
              <TriangleAlert className="size-3 me-1" />
              {t("حساسية موثقة", "Documented Allergies")}
              <span className="ms-1.5 text-[11px] opacity-90 font-mono">{allergyCount}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Zero search results state */}
      {filteredPatients.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <AlertCircle className="size-8 mx-auto text-muted-foreground" />
          <h4 className="font-semibold text-base">
            {t("لم يتم العثور على أي ملف يطابق بحثك", "No files match your search")}
          </h4>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {t(
              "جرّب البحث باسم آخر أو إزالة التصفية لعرض جميع ملفات المرضى المسجلة.",
              "Try searching with a different term or clearing active filters to see all patient files."
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery("");
              setFilterTab("all");
            }}
          >
            {t("إعادة ضبط البحث والتصفية", "Reset search & filters")}
          </Button>
        </Card>
      ) : viewMode === "grid" ? (
        /* GRID VIEW */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredPatients.map((p) => {
            const role = roles[p.id];
            const badges = attentionBadges(attentionMap[p.id], t);
            const hasAllergy = allergicSet.has(p.id);
            const isOwner = role === "owner";
            const displayName =
              lang === "en" && p.full_name_en ? p.full_name_en : p.full_name;
            const secondaryName =
              lang === "ar" ? p.full_name_en : p.full_name;
            const isCopied = copiedId === p.id;

            return (
              <Card
                key={p.id}
                className="group relative flex flex-col justify-between overflow-hidden border border-border/40 bg-card hover:border-primary/40 hover:shadow-md transition-all duration-200"
              >
                <div className="p-5 space-y-4">
                  {/* Card Header: Avatar, Name, MRN, Role & Dropdown */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <Link
                        href={`/patients/${p.id}`}
                        className="shrink-0 transition-transform hover:scale-105"
                      >
                        <Avatar
                          size="md"
                          name={displayName}
                          src={
                            p.photo_path
                              ? `/api/avatar?p=${p.id}&v=${encodeURIComponent(p.updated_at)}`
                              : null
                          }
                        />
                      </Link>

                      <div className="min-w-0 space-y-0.5">
                        <Link
                          href={`/patients/${p.id}`}
                          className="font-semibold text-foreground hover:text-primary transition-colors text-base line-clamp-1"
                        >
                          {displayName}
                        </Link>
                        {secondaryName && secondaryName !== displayName && (
                          <p className="text-xs text-muted-foreground truncate">
                            {secondaryName}
                          </p>
                        )}

                        {/* MRN Tag with Copy */}
                        <div className="pt-1 flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => handleCopyMrn(e, p.mrn, p.id)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title={t("نسخ رقم الملف", "Copy MRN")}
                          >
                            <span className="ltr font-mono">{p.mrn}</span>
                            {isCopied ? (
                              <Check className="size-3 text-emerald-500" />
                            ) : (
                              <Copy className="size-3 opacity-60 hover:opacity-100" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Role & Menu */}
                    <div className="flex items-center gap-1 shrink-0">
                      {isOwner ? (
                        <Badge variant="ok" className="text-xs px-2.5 py-0.5">
                          {t("ملفك", "Your file")}
                        </Badge>
                      ) : role === "guardian" ? (
                        <Badge variant="secondary" className="text-xs px-2.5 py-0.5">
                          {t("ولي أمر", "Guardian")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs px-2.5 py-0.5">
                          {t("رعاية", "Care")}
                        </Badge>
                      )}

                      {/* Dropdown Menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            aria-label={t("خيارات الملف", "File options")}
                          >
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align={isRtl ? "start" : "end"} className="w-48">
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}`} className="flex items-center gap-2">
                              <FileText className="size-4 text-primary" />
                              <span>{t("فتح الملف الطبي", "Open Medical File")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/dental`} className="flex items-center gap-2">
                              <Smile className="size-4 text-emerald-500" />
                              <span>{t("مخطط الأسنان", "Dental Chart")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/vitals`} className="flex items-center gap-2">
                              <Activity className="size-4 text-blue-500" />
                              <span>{t("المؤشرات والفحوصات", "Vitals & Labs")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/visits`} className="flex items-center gap-2">
                              <Calendar className="size-4 text-purple-500" />
                              <span>{t("سجل الزيارات", "Visits & Encounters")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/emergency`} className="flex items-center gap-2">
                              <ShieldAlert className="size-4 text-red-500" />
                              <span>{t("بطاقة الطوارئ", "Emergency Profile")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/sharing`} className="flex items-center gap-2">
                              <Share2 className="size-4 text-muted-foreground" />
                              <span>{t("المشاركة والأذونات", "Sharing & Access")}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/patients/${p.id}/profile`} className="flex items-center gap-2">
                              <Settings className="size-4 text-muted-foreground" />
                              <span>{t("تعديل البيانات", "Edit Profile")}</span>
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Demographics Row: Age, Sex, Blood Group, City */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground pt-1">
                    <span className="font-medium text-foreground">
                      {ageLabel(p.date_of_birth, lang)}
                    </span>
                    <span>•</span>
                    <span>{lbl(SEX, p.sex, lang)}</span>

                    {p.blood_abo && (
                      <>
                        <span>•</span>
                        <span className="inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold text-foreground px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400">
                          <Droplets className="size-3 inline" />
                          <span className="ltr font-mono">{p.blood_abo}{p.blood_rh}</span>
                        </span>
                      </>
                    )}

                    {p.city && (
                      <>
                        <span>•</span>
                        <span>{p.city}</span>
                      </>
                    )}
                  </div>

                  {/* Alerts & Attention Chips */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {p.deletion_requested_at && (
                      <Badge variant="warn">
                        {t("مجدول للحذف", "Scheduled for deletion")}
                      </Badge>
                    )}

                    {hasAllergy && (
                      <Badge variant="bad" className="gap-1">
                        <TriangleAlert className="size-3" />
                        {t("حساسية موثقة", "Allergies on file")}
                      </Badge>
                    )}

                    {badges.map((b) => (
                      <Badge key={b.code} variant={b.tone}>
                        {b.text}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Card Footer: Quick Actions */}
                <div className="border-t border-border/30 bg-muted/20 px-5 py-3 flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 justify-between text-xs h-8 group-hover:border-primary/40 group-hover:bg-primary/5 transition-colors"
                    asChild
                  >
                    <Link href={`/patients/${p.id}`}>
                      <span>{t("فتح الملف الطبي", "Open Medical File")}</span>
                      {isRtl ? (
                        <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-1" />
                      ) : (
                        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
                      )}
                    </Link>
                  </Button>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-foreground"
                      title={t("مخطط الأسنان", "Dental chart")}
                      asChild
                    >
                      <Link href={`/patients/${p.id}/dental`}>
                        <Smile className="size-4" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-foreground"
                      title={t("بطاقة الطوارئ", "Emergency profile")}
                      asChild
                    >
                      <Link href={`/patients/${p.id}/emergency`}>
                        <ShieldAlert className="size-4" />
                      </Link>
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        /* TABLE VIEW */
        <div className="rounded-xl border border-border/40 bg-card overflow-hidden shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-[300px]">{t("المريض", "Patient")}</TableHead>
                <TableHead>{t("العلاقة", "Relationship")}</TableHead>
                <TableHead>{t("العمر والنوع", "Demographics")}</TableHead>
                <TableHead>{t("فصيلة الدم", "Blood Group")}</TableHead>
                <TableHead>{t("الحالة والتنبيهات", "Clinical Status")}</TableHead>
                <TableHead className="text-end">{t("الإجراءات", "Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPatients.map((p) => {
                const role = roles[p.id];
                const badges = attentionBadges(attentionMap[p.id], t);
                const hasAllergy = allergicSet.has(p.id);
                const isOwner = role === "owner";
                const displayName =
                  lang === "en" && p.full_name_en ? p.full_name_en : p.full_name;
                const isCopied = copiedId === p.id;

                return (
                  <TableRow
                    key={p.id}
                    className="hover:bg-accent/40 transition-colors cursor-pointer group"
                  >
                    {/* Patient Column */}
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-3">
                        <Avatar
                          size="sm"
                          name={displayName}
                          src={
                            p.photo_path
                              ? `/api/avatar?p=${p.id}&v=${encodeURIComponent(p.updated_at)}`
                              : null
                          }
                        />
                        <div className="min-w-0">
                          <Link
                            href={`/patients/${p.id}`}
                            className="font-semibold text-foreground hover:text-primary transition-colors text-sm block truncate"
                          >
                            {displayName}
                          </Link>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                            <span className="ltr">{p.mrn}</span>
                            <button
                              type="button"
                              onClick={(e) => handleCopyMrn(e, p.mrn, p.id)}
                              className="text-muted-foreground hover:text-foreground p-0.5"
                              title={t("نسخ", "Copy")}
                            >
                              {isCopied ? (
                                <Check className="size-3 text-emerald-500" />
                              ) : (
                                <Copy className="size-3 opacity-60 hover:opacity-100" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </TableCell>

                    {/* Role */}
                    <TableCell>
                      {isOwner ? (
                        <Badge variant="ok" className="text-xs">
                          {t("ملفك الشخصي", "Your file")}
                        </Badge>
                      ) : role === "guardian" ? (
                        <Badge variant="secondary" className="text-xs">
                          {t("ولي أمر", "Guardian")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          {t("رعاية", "Care")}
                        </Badge>
                      )}
                    </TableCell>

                    {/* Demographics */}
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{ageLabel(p.date_of_birth, lang)}</div>
                      <div>{lbl(SEX, p.sex, lang)}</div>
                    </TableCell>

                    {/* Blood Group */}
                    <TableCell>
                      {p.blood_abo ? (
                        <span className="inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400 font-semibold">
                          <Droplets className="size-3" />
                          <span className="ltr font-mono">{p.blood_abo}{p.blood_rh}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>

                    {/* Clinical Status & Alerts */}
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {p.deletion_requested_at && (
                          <Badge variant="warn" className="text-xs">
                            {t("مجدول للحذف", "Scheduled for deletion")}
                          </Badge>
                        )}
                        {hasAllergy && (
                          <Badge variant="bad" className="text-xs gap-1">
                            <TriangleAlert className="size-3" />
                            {t("حساسية", "Allergy")}
                          </Badge>
                        )}
                        {badges.slice(0, 2).map((b) => (
                          <Badge key={b.code} variant={b.tone} className="text-xs">
                            {b.text}
                          </Badge>
                        ))}
                        {badges.length > 2 && (
                          <Badge variant="outline" className="text-xs">
                            +{badges.length - 2}
                          </Badge>
                        )}
                        {!hasAllergy && badges.length === 0 && !p.deletion_requested_at && (
                          <span className="text-xs text-muted-foreground">
                            {t("مستقر", "Stable")}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2.5 text-xs text-primary hover:text-primary hover:bg-primary/10"
                          asChild
                        >
                          <Link href={`/patients/${p.id}`}>
                            {t("عرض", "View")}
                          </Link>
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-foreground"
                            >
                              <MoreVertical className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align={isRtl ? "start" : "end"} className="w-48">
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}`} className="flex items-center gap-2">
                                <FileText className="size-4 text-primary" />
                                <span>{t("فتح الملف الطبي", "Open Medical File")}</span>
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}/dental`} className="flex items-center gap-2">
                                <Smile className="size-4 text-emerald-500" />
                                <span>{t("مخطط الأسنان", "Dental Chart")}</span>
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}/vitals`} className="flex items-center gap-2">
                                <Activity className="size-4 text-blue-500" />
                                <span>{t("المؤشرات والفحوصات", "Vitals & Labs")}</span>
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}/emergency`} className="flex items-center gap-2">
                                <ShieldAlert className="size-4 text-red-500" />
                                <span>{t("بطاقة الطوارئ", "Emergency Profile")}</span>
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}/sharing`} className="flex items-center gap-2">
                                <Share2 className="size-4 text-muted-foreground" />
                                <span>{t("المشاركة والأذونات", "Sharing & Access")}</span>
                              </Link>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

