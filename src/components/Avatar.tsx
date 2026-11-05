import {
  Avatar as ShadcnAvatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Avatar component rebuilt with shadcn/ui Avatar primitives (@radix-ui/react-avatar).
 * Renders avatar image if available, falling back gracefully to uppercase initials.
 */
export function Avatar({
  name,
  src,
  size = "md",
  className,
}: {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const initials = Array.from(
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => Array.from(w)[0] ?? "")
      .join("") || "?"
  )
    .join("")
    .toUpperCase();

  const sizeClasses = {
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-12 w-12 text-base",
  };

  return (
    <ShadcnAvatar
      className={cn(
        "avatar border border-border bg-secondary text-foreground",
        sizeClasses[size],
        size === "sm" && "sm",
        size === "lg" && "lg",
        className
      )}
      aria-hidden="true"
    >
      {src && (
        <AvatarImage
          src={src}
          alt={name}
          className="avatar-img object-cover"
        />
      )}
      <AvatarFallback className="font-medium bg-secondary text-foreground">
        {initials}
      </AvatarFallback>
    </ShadcnAvatar>
  );
}
