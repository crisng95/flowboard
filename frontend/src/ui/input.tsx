/**
 * Input — dark-themed text input with accent focus ring.
 */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          // Layout
          "flex h-9 w-full rounded-lg px-3 py-1 text-sm",
          // Surface
          "bg-surface-2 border border-line-subtle text-ink-primary",
          // Placeholder
          "placeholder:text-ink-placeholder",
          // Focus
          "transition-colors duration-150",
          "focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40",
          // File input
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          // Disabled
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
