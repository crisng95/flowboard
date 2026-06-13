/**
 * Badge — status/label chips for Flowboard dark theme.
 *
 * Variants:
 *  - default    : subtle surface chip
 *  - accent     : violet tint (matches accent color)
 *  - queued     : amber — job waiting
 *  - running    : violet with pulse — job in flight
 *  - done       : emerald — job complete
 *  - error      : red — job failed
 */
import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-surface-3 text-ink-muted border border-line-subtle",
        accent: "bg-accent/20 text-accent-400 border border-accent/30",
        queued: "bg-amber-500/15 text-amber-300 border border-amber-500/25",
        running:
          "bg-accent/15 text-accent-400 border border-accent/25 animate-pulse-soft",
        done: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25",
        error: "bg-red-500/15 text-red-300 border border-red-500/25",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
