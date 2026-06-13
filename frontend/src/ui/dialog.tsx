/**
 * Dialog — shadcn/ui pattern with Flowboard dark theme.
 * Wraps @radix-ui/react-dialog with design-system styling.
 * Uses Framer Motion for premium enter/exit animations.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ElementRef, type ComponentPropsWithoutRef, type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Position
        "fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
        // Size
        "w-full max-w-lg",
        // Surface
        "bg-[#16161a] border border-white/[0.08] rounded-2xl shadow-2xl",
        // Padding
        "p-6",
        // Animations via Tailwind (no Framer needed for simple dialogs)
        "duration-200",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
        "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className,
      )}
      {...props}
    >
      {/* Glow accent top-left */}
      <div className="pointer-events-none absolute -left-16 -top-16 h-32 w-32 rounded-full bg-accent/20 blur-3xl" />
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-white/40 transition-colors hover:text-white/80 focus:outline-none focus:ring-2 focus:ring-accent">
        <X size={16} />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-5 flex flex-col gap-1", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mt-6 flex items-center justify-end gap-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-white", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-white/50", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
