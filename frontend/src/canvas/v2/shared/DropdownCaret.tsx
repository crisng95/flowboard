import { cn } from "../../../lib/utils";

export function DropdownCaret({ open = false, className }: { open?: boolean; className?: string }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-hidden="true"
      className={cn("shrink-0 transition-transform", open && "rotate-180", className)}
    >
      <path
        d="M1 2.5l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
