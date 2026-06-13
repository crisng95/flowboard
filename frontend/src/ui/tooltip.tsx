/**
 * Tooltip — dark-themed tooltip using @radix-ui/react-tooltip.
 * Includes a subtle scaleIn animation via Tailwind's animate-in utilities.
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { forwardRef, type ElementRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      // Surface
      "z-50 rounded-md bg-[#2a2a2a] border border-white/[0.08] px-2.5 py-1.5",
      // Typography
      "text-xs text-white/90 font-medium shadow-xl",
      // Animations
      "animate-in fade-in-0 zoom-in-95",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
      "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1",
      "data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
