/**
 * Button primitive — shadcn pattern with Magnific-tuned variants.
 *
 * Variants:
 *  - default  : surface chip, dark
 *  - run      : gradient violet (CTA inside nodes + toolbar)
 *  - ghost    : transparent, hover surface
 *  - outline  : transparent + border, hover fills
 *  - destructive : red tint
 *
 * Sizes match Magnific's compact toolbar density: xs (24px) for inline
 * node controls, sm (28px) for toolbar, default (32px) for primary
 * actions.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  // Base — applies to all variants. Inline-flex for icon+text alignment,
  // focus-visible ring uses accent color so keyboard users see it.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors transition-shadow duration-150 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
    "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-surface-2 text-ink-primary border border-line-subtle hover:bg-surface-3 hover:border-line-strong",
        run:
          // The gradient + soft glow IS the visual anchor of the canvas.
          // Hover bumps the glow + lifts gradient stop. Active dampens
          // shadow so the click feels physical.
          "bg-run-gradient text-white shadow-[0_4px_14px_rgba(124,92,255,0.45)] " +
          "hover:bg-run-gradient-hover hover:shadow-[0_6px_20px_rgba(124,92,255,0.6)] " +
          "active:shadow-[0_2px_8px_rgba(124,92,255,0.4)]",
        ghost: "text-ink-muted hover:text-ink-primary hover:bg-surface-2",
        outline:
          "border border-line-subtle text-ink-primary hover:bg-surface-2 hover:border-line-strong",
        destructive:
          "bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20 hover:border-red-500/50",
      },
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-2.5 text-xs",
        default: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-sm",
        icon: "h-8 w-8",
        "icon-sm": "h-6 w-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * When `true`, render via Radix `Slot` so the styles apply to the
   * direct child instead of a `<button>`. Useful for rendering buttons
   * as `<a>` (links) or wrapping a custom element while keeping all
   * behavior + a11y.
   */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
