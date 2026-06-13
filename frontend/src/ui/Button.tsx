/**
 * Button — shadcn pattern with Flowboard dark-theme variants.
 *
 * Variants:
 *  - default     : dark surface chip
 *  - primary     : solid accent (#7c5cff)
 *  - run         : gradient violet (CTA in nodes + toolbar)
 *  - ghost       : transparent, hover surface
 *  - outline     : transparent + border, hover fills
 *  - destructive : red tint
 *
 * Added: active:scale-[0.97] micro-press + smoother 200ms transitions.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-all duration-200 ease-out select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
    "disabled:pointer-events-none disabled:opacity-40 " +
    "active:scale-[0.97]",
  {
    variants: {
      variant: {
        default:
          "bg-surface-2 text-ink-primary border border-line-subtle " +
          "hover:bg-surface-3 hover:border-line-strong",
        primary:
          "bg-[#f7f4ed] text-[#111217] font-bold shadow-sm " +
          "hover:bg-[#e3dfd6]",
        run:
          "bg-run-gradient text-white shadow-[0_4px_14px_rgba(124,92,255,0.45)] " +
          "hover:bg-run-gradient-hover hover:shadow-[0_6px_20px_rgba(124,92,255,0.6)] " +
          "active:shadow-[0_2px_8px_rgba(124,92,255,0.4)]",
        ghost: "text-ink-muted hover:text-ink-primary hover:bg-surface-2",
        outline:
          "border border-line-subtle text-ink-primary " +
          "hover:bg-surface-2 hover:border-line-strong",
        destructive:
          "bg-red-500/10 text-red-300 border border-red-500/30 " +
          "hover:bg-red-500/20 hover:border-red-500/50",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 px-2 text-xs rounded",
        sm: "h-7 px-2.5 text-xs",
        default: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-sm",
        xl: "h-10 px-5 text-sm",
        icon: "h-8 w-8",
        "icon-sm": "h-6 w-6",
        "icon-lg": "h-10 w-10",
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
