import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Inbox, Minus } from "lucide-react";
import { INTERPRETATION, lbl, type Opt } from "@/lib/labels";
import type { Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Shadcn Component Primitives
import { Badge, badgeVariants, type BadgeProps } from "./badge";
import { Alert, AlertTitle, AlertDescription, alertVariants } from "./alert";
import {
  Card as ShadcnCard,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./card";
import { Button, buttonVariants } from "./button";

// -----------------------------------------------------------------------------
// Chip & Badges (rebuilt on shadcn Badge)
// -----------------------------------------------------------------------------
export type ChipTone = "ok" | "warn" | "bad" | "info" | "muted";

export function Chip({
  tone = "muted",
  children,
  title,
  className,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <Badge
      variant={tone}
      title={title}
      className={cn("chip", tone, className)}
    >
      {children}
    </Badge>
  );
}

const ICONS = { check: Check, alert: AlertTriangle, up: ArrowUp, down: ArrowDown, dash: Minus };

/** Interpretation chip: icon + text + color, never color alone. */
export function InterpChip({
  value,
  lang,
  className,
}: {
  value: string;
  lang: Lang;
  className?: string;
}) {
  const m = INTERPRETATION[value] ?? INTERPRETATION.not_assessed;
  const I = ICONS[m.icon as keyof typeof ICONS];
  return (
    <Chip tone={m.tone} className={className}>
      <I className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{m[lang]}</span>
    </Chip>
  );
}

// -----------------------------------------------------------------------------
// Banner / Admonition (rebuilt on shadcn Alert)
// -----------------------------------------------------------------------------
/* Supabase ui-patterns Admonition icons */
const AdmInfo = () => (
  <svg viewBox="0 0 21 20" fill="currentColor" aria-hidden="true" className="h-4 w-4 shrink-0">
    <path fillRule="evenodd" clipRule="evenodd" d="M0.625 9.8252C0.625 4.44043 4.99023 0.0751953 10.375 0.0751953C15.7598 0.0751953 20.125 4.44043 20.125 9.8252C20.125 15.21 15.7598 19.5752 10.375 19.5752C4.99023 19.5752 0.625 15.21 0.625 9.8252ZM9.3584 4.38135C9.45117 4.28857 9.55518 4.20996 9.66699 4.14648C9.88086 4.02539 10.1245 3.96045 10.375 3.96045C10.5845 3.96045 10.7896 4.00586 10.9766 4.09229C11.1294 4.1626 11.2705 4.26025 11.3916 4.38135C11.6611 4.65088 11.8125 5.0166 11.8125 5.39795C11.8125 5.5249 11.7959 5.6499 11.7637 5.77002C11.6987 6.01172 11.5718 6.23438 11.3916 6.41455C11.1221 6.68408 10.7563 6.83545 10.375 6.83545C9.99365 6.83545 9.62793 6.68408 9.3584 6.41455C9.08887 6.14502 8.9375 5.7793 8.9375 5.39795C8.9375 5.29492 8.94873 5.19287 8.97021 5.09375C9.02783 4.82568 9.16162 4.57812 9.3584 4.38135ZM10.375 15.6899C10.0933 15.6899 9.82275 15.5781 9.62354 15.3789C9.42432 15.1797 9.3125 14.9092 9.3125 14.6274V9.31494C9.3125 9.0332 9.42432 8.7627 9.62354 8.56348C9.82275 8.36426 10.0933 8.25244 10.375 8.25244C10.6567 8.25244 10.9272 8.36426 11.1265 8.56348C11.3257 8.7627 11.4375 9.0332 11.4375 9.31494V14.6274C11.4375 14.7944 11.3979 14.9575 11.3242 15.104C11.2739 15.2046 11.2075 15.2979 11.1265 15.3789C10.9272 15.5781 10.6567 15.6899 10.375 15.6899Z" />
  </svg>
);
const AdmSuccess = () => (
  <svg viewBox="0 0 21 20" fill="currentColor" aria-hidden="true" className="h-4 w-4 shrink-0">
    <path fillRule="evenodd" clipRule="evenodd" d="M10.5 19.5C5.25329 19.5 1 15.2467 1 10C1 4.75329 5.25329 0.5 10.5 0.5C15.7467 0.5 20 4.75329 20 10C20 15.2467 15.7467 19.5 10.5 19.5ZM14.7803 7.78033C15.0732 7.48744 15.0732 7.01256 14.7803 6.71967C14.4874 6.42678 14.0126 6.42678 13.7197 6.71967L9.25 11.1893L7.28033 9.21967C6.98744 8.92678 6.51256 8.92678 6.21967 9.21967C5.92678 9.51256 5.92678 9.98744 6.21967 10.2803L8.71967 12.7803C9.01256 13.0732 9.48744 13.0732 9.78033 12.7803L14.7803 7.78033Z" />
  </svg>
);
const AdmWarning = () => (
  <svg viewBox="0 0 22 20" fill="currentColor" aria-hidden="true" className="h-4 w-4 shrink-0">
    <path fillRule="evenodd" clipRule="evenodd" d="M8.15137 1.95117C9.30615 -0.0488281 12.1943 -0.0488281 13.3481 1.95117L20.7031 14.6992C21.8574 16.6992 20.4131 19.1992 18.104 19.1992H3.39502C1.08594 19.1992 -0.356933 16.6992 0.797364 14.6992L8.15137 1.95117ZM11.7666 16.0083C11.4971 16.2778 11.1313 16.4292 10.75 16.4292C10.3687 16.4292 10.0029 16.2778 9.7334 16.0083C9.46387 15.7388 9.3125 15.373 9.3125 14.9917C9.3125 14.9307 9.31641 14.8706 9.32373 14.811C9.33545 14.7197 9.35547 14.6304 9.38379 14.5439L9.41406 14.4609C9.48584 14.2803 9.59375 14.1147 9.7334 13.9751C10.0029 13.7056 10.3687 13.5542 10.75 13.5542C11.1313 13.5542 11.4971 13.7056 11.7666 13.9751C12.0361 14.2446 12.1875 14.6104 12.1875 14.9917C12.1875 15.373 12.0361 15.7388 11.7666 16.0083ZM10.75 4.69971C11.0317 4.69971 11.3022 4.81152 11.5015 5.01074C11.7007 5.20996 11.8125 5.48047 11.8125 5.76221V11.0747C11.8125 11.3564 11.7007 11.627 11.5015 11.8262C11.3022 12.0254 11.0317 12.1372 10.75 12.1372C10.4683 12.1372 10.1978 12.0254 9.99854 11.8262C9.79932 11.627 9.6875 11.3564 9.6875 11.0747V5.76221C9.6875 5.48047 9.79932 5.20996 9.99854 5.01074C10.1978 4.81152 10.4683 4.69971 10.75 4.69971Z" />
  </svg>
);

/**
 * Banner (rebuilt on shadcn Alert): tone maps to semantic variants (ok, warn, bad, info).
 */
export function Banner({
  tone = "info",
  title,
  children,
  actions,
  className,
}: {
  tone?: "bad" | "warn" | "ok" | "info";
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "bad" || tone === "warn" ? AdmWarning : tone === "ok" ? AdmSuccess : AdmInfo;
  return (
    <Alert
      variant={tone}
      className={cn("banner", tone, className)}
      role={tone === "bad" ? "alert" : "note"}
      data-slot="alert"
    >
      <Icon />
      <div className="flex-1 min-w-0">
        {title && <AlertTitle className="adm-title mb-1 font-semibold" data-slot="alert-title">{title}</AlertTitle>}
        {children && <AlertDescription className="text-sm" data-slot="alert-description">{children}</AlertDescription>}
        {actions && <div className="row mt-3 flex items-center gap-2">{actions}</div>}
      </div>
    </Alert>
  );
}

// -----------------------------------------------------------------------------
// PageHead
// -----------------------------------------------------------------------------
export function PageHead({
  title,
  sub,
  actions,
  className,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("page-head flex flex-wrap items-start justify-between gap-4 mb-6", className)}>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="row flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Empty (rebuilt on shadcn Empty patterns)
// -----------------------------------------------------------------------------
export function Empty({
  children,
  title,
  icon,
  actions,
  className,
}: {
  children?: React.ReactNode;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty flex flex-col items-center justify-center gap-3 p-8 text-center rounded-lg border border-dashed border-border bg-card", className)}>
      <span className="empty-icon text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className="h-6 w-6" />}
      </span>
      <div className="space-y-1">
        {title && <p className="empty-title font-medium text-foreground">{title}</p>}
        {children && <div className="text-sm text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="empty-actions mt-2 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Card (rebuilt on shadcn Card)
// -----------------------------------------------------------------------------
export function Card({
  title,
  actions,
  children,
  id,
  description,
  footer,
  className,
  dir,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  dir?: "rtl" | "ltr" | string;
}) {
  return (
    <ShadcnCard
      id={id}
      dir={dir}
      aria-labelledby={id && title ? `${id}-title` : undefined}
      className={cn("card", className)}
    >
      {(title || actions || description) && (
        <CardHeader className="card-head flex flex-row items-start justify-between gap-4 pb-4">
          <div className="space-y-1">
            {title && (
              <CardTitle id={id ? `${id}-title` : undefined} className="text-base font-semibold">
                {title}
              </CardTitle>
            )}
            {description && <CardDescription className="card-desc text-xs text-muted-foreground">{description}</CardDescription>}
          </div>
          {actions && <div className="row flex items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className="card-body p-5 pt-0 min-w-0 max-w-full">{children}</CardContent>
      {footer && <CardFooter className="card-foot border-t border-border p-4 bg-muted/40">{footer}</CardFooter>}
    </ShadcnCard>
  );
}

// -----------------------------------------------------------------------------
// KeyValue (KV)
// -----------------------------------------------------------------------------
export function KV({
  items,
  className,
}: {
  items: [string, React.ReactNode][];
  className?: string;
}) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return null;
  return (
    <dl className={cn("kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {shown.map(([k, v]) => (
        <React.Fragment key={`kv_${k}`}>
          <dt className="text-muted-foreground font-medium">{k}</dt>
          <dd className="text-foreground">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

// -----------------------------------------------------------------------------
// Select & Navigation helpers
// -----------------------------------------------------------------------------
export function OptSelect({
  name,
  options,
  value,
  lang,
  required,
  blank,
  className,
}: {
  name: string;
  options: Opt[];
  value?: string | null;
  lang: Lang;
  required?: boolean;
  blank?: string;
  className?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      required={required}
      id={`f_${name}`}
      className={cn("h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", className)}
    >
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o[lang]}
        </option>
      ))}
    </select>
  );
}

export function BackLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Button variant="ghost" size="sm" asChild className={className}>
      <Link href={href}>{children}</Link>
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Unified exports of shadcn design system primitives
// -----------------------------------------------------------------------------
export { Button, buttonVariants } from "./button";
export { Badge, badgeVariants } from "./badge";
export { Alert, AlertTitle, AlertDescription, alertVariants } from "./alert";
export {
  ShadcnCard,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
export { DirectionProvider, useDirection } from "./direction";
export { Avatar, AvatarImage, AvatarFallback } from "./avatar";
export { Skeleton } from "./skeleton";
export { Separator } from "./separator";
export { Input } from "./input";
