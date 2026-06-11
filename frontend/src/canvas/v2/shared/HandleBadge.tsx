import type { LucideIcon } from "lucide-react";

import { cn } from "../../../lib/utils";

export function HandleBadge({
  icon: Icon,
  active,
  label,
  side,
}: {
  icon: LucideIcon;
  active: boolean;
  label?: string;
  side: "left" | "right" | "bottom";
}) {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150"
        style={{
          backgroundColor: "#2b2b2b",
          borderColor: active ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
          color: "rgba(255,255,255,0.7)",
        }}
      >
        <Icon size={11} strokeWidth={2} />
      </div>
      {label && (
        <div
          className={cn(
            "pointer-events-none absolute z-50 rounded-xl border border-white/[0.08] bg-[#1f1f1f] px-3 py-2 text-xs font-medium text-white shadow-xl",
            "whitespace-nowrap opacity-0 scale-95 transition-all duration-200 ease-out group-hover/handle:opacity-100 group-hover/handle:scale-100",
            side === "left"
              ? "top-1/2 right-full mr-3 -translate-y-1/2 translate-x-1 group-hover/handle:translate-x-0"
              : side === "right"
                ? "top-1/2 left-full ml-3 -translate-y-1/2 -translate-x-1 group-hover/handle:translate-x-0"
                : "bottom-full left-1/2 mb-3 -translate-x-1/2 translate-y-1 group-hover/handle:translate-y-0",
          )}
        >
          {label}
        </div>
      )}
    </>
  );
}
