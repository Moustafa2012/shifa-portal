import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 text-start [&>svg~*]:ps-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:start-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground border-border",
        destructive:
          "border-destructive/50 bg-[hsl(var(--sb-destructive-200))] dark:bg-[hsl(var(--sb-destructive-600)/.12)] text-foreground [&>svg]:text-destructive",
        bad:
          "border-destructive/50 bg-[hsl(var(--sb-destructive-200))] dark:bg-[hsl(var(--sb-destructive-600)/.12)] text-foreground [&>svg]:text-destructive",
        info: "border-border bg-card text-foreground [&>svg]:text-foreground",
        warn: "border-[hsl(var(--sb-warning-400)/.4)] bg-[hsl(var(--sb-warning-200))] dark:bg-[hsl(var(--sb-warning-600)/.12)] text-foreground [&>svg]:text-[hsl(var(--sb-warning-600))] dark:[&>svg]:text-[hsl(var(--sb-warning-400))]",
        ok: "border-[hsl(var(--sb-brand-500)/.35)] bg-[hsl(var(--sb-brand-default)/.08)] text-foreground [&>svg]:text-[hsl(var(--sb-brand-600))] dark:[&>svg]:text-[hsl(var(--sb-brand-400))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
))
Alert.displayName = "Alert"

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  />
))
AlertTitle.displayName = "AlertTitle"

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

export { Alert, AlertTitle, AlertDescription, alertVariants }
