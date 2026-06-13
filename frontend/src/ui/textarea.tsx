/**
 * Textarea — dark-themed multiline input with accent focus ring.
 */
import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          // Layout
          "flex w-full min-h-[80px] rounded-lg px-3 py-2.5 text-sm",
          // Surface
          "bg-surface-2 border border-line-subtle text-ink-primary",
          // Placeholder
          "placeholder:text-ink-placeholder",
          // Resize
          "resize-none",
          // Focus
          "transition-colors duration-150",
          "focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40",
          // Disabled
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Scrollbar
          "scrollbar-none",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
