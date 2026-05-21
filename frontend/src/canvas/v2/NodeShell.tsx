/**
 * NodeShell â€” V2 base wrapper, rebuilt to match Magnific Spaces.
 *
 * Reference: Magnific "Assistant" + "Creation" node screenshots.
 *
 * Key structural choices:
 *   1. Title sits OUTSIDE the card (top-left subtle label) â€” NOT inside
 *      the card as a header bar. This is the single most important
 *      Magnific cue â€” the card body becomes pure content, not chrome.
 *   2. Card body is a big rounded surface (~22px) with generous padding
 *      (24px) and a barely-there border. The shadow does the heavy
 *      lifting for "lifted" depth.
 *   3. Handles render as labeled pills floating OUTSIDE the card edge,
 *      not flush with it. Icon inside the pill (T for text, â–£ for
 *      image, â–¶ for video) tells the user what flows through that
 *      port.
 *   4. Optional inner toolbar row at the top of the card body â€” two
 *      groups: a left group of "type/mode" pills, a right group of
 *      action icons (copy, expand). Components decide what to put in
 *      each slot.
 *
 * Per-node cards (VisualAsset, Image, Video, Character) compose this
 * with their own body slot. They control:
 *   - inner toolbar contents (or omit)
 *   - body padding (full-bleed for image cards, padded for prompt cards)
 *   - card width
 */
import { Handle, Position } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

interface HandleSpec {
  id: string;
  /** Icon rendered inside the pill â€” communicates what data type flows
   *  through this port. Magnific labels every port; we follow suit. */
  icon: LucideIcon;
  label?: string;
}

export interface NodeShellProps {
  /** Tiny icon next to the external title label. */
  Icon: LucideIcon;
  title: string;
  shortId?: string;
  /** Body content. Per-node components own padding here. The shell
   *  doesn't add padding by default so an Image card can render the
   *  image full-bleed inside the rounded card while a Prompt card
   *  pads its text. Set `padded` to opt into the default 20px. */
  children: ReactNode;
  /** Apply default 20px padding to the card body. Pass false for
   *  full-bleed media cards. */
  padded?: boolean;
  /** Optional toolbar row rendered at the top of the card body â€”
   *  before children. Two slots (left + right) match Magnific. */
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  selected?: boolean;
  className?: string;
  /** Magnific Assistant ~480, Creation ~240, Generator ~320. We pick
   *  per node in the consumer. */
  width?: number;
  targetHandle?: HandleSpec;
  sourceHandle?: HandleSpec;
  status?: "idle" | "queued" | "running" | "done" | "error";
}

const STATUS_DOT_CLASS: Record<NonNullable<NodeShellProps["status"]>, string> = {
  idle: "bg-transparent",
  queued: "bg-status-queued",
  running: "bg-status-running animate-pulse-soft",
  done: "bg-status-done",
  error: "bg-status-error",
};

export function NodeShell({
  Icon,
  title,
  shortId,
  children,
  padded = true,
  toolbarLeft,
  toolbarRight,
  selected = false,
  className,
  width = 320,
  targetHandle,
  sourceHandle,
  status = "idle",
}: NodeShellProps) {
  return (
    // Wrapper holds external title + card. Title is absolute-positioned
    // above so it doesn't push the card down, keeping the React Flow
    // node bounds aligned with the card itself (handles + edges
    // attach correctly).
    <div className="relative font-sans" style={{ width }}>
      {/* External title â€” Magnific puts it OUTSIDE the card so the
          card body is pure content. Sits above the card with a small
          inline icon. Magnific keeps the title light/subtle (not
          bold), the shortId monospace + dimmer than the title. */}
      <div className="absolute -top-6 left-1 flex items-center gap-1.5">
        <Icon size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs font-normal text-ink-primary leading-none">
          {title}
        </span>
        {status !== "idle" && (
          <span
            className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[status])}
            aria-label={`Status: ${status}`}
          />
        )}
        {shortId && (
          <span className="font-mono text-2xs text-ink-placeholder leading-none">
            #{shortId}
          </span>
        )}
      </div>

      {/* Card body. NOT overflow:hidden â€” that would clip the
          NodeResizeControl handle (rendered as a sibling below by
          consumers) and any other portaled affordance pinned outside
          the card edge. Inner content that needs clipping (the top
          tint overlay, image slots) is responsible for its own
          overflow. */}
      <div
        data-selected={selected || undefined}
        data-status={status !== "idle" ? status : undefined}
        className={cn("node-surface relative", className)}
      >
        {(toolbarLeft || toolbarRight) && (
          <div
            // Inner toolbar â€” Magnific puts ~28px icon pills here.
            // Left group = mode/type toggles, right group = action
            // icons. Tight padding keeps the toolbar visually a
            // floating row, not a separate header zone.
            className={cn(
              "flex items-center justify-between",
              padded ? "px-3 pt-3" : "px-3 pt-2.5 absolute inset-x-0 top-0 z-10",
            )}
          >
            <div className="flex items-center gap-0.5">{toolbarLeft}</div>
            <div className="flex items-center gap-0.5">{toolbarRight}</div>
          </div>
        )}

        <div
          className={cn(
            // Tight 12px (p-3) around the body so the media slot
            // dominates â€” Magnific's cards never have generous body
            // padding; the *card* itself provides the breathing room.
            padded ? "p-3" : "",
            (toolbarLeft || toolbarRight) && padded ? "pt-2" : "",
          )}
        >
          {children}
        </div>
      </div>

      {targetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          id={targetHandle.id}
          // The Handle host element IS the hit-area. Make it large
          // (28x28) and transparent â€” visible pill is rendered as a
          // child div positioned inside.
          className="!h-8 !w-8 !border-0 !bg-transparent !-translate-x-1/2"
          style={{ top: "50%" }}
        >
          <HandlePill icon={targetHandle.icon} label={targetHandle.label} />
        </Handle>
      )}
      {sourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          id={sourceHandle.id}
          className="!h-8 !w-8 !border-0 !bg-transparent !translate-x-1/2"
          style={{ top: "50%" }}
        >
          <HandlePill icon={sourceHandle.icon} label={sourceHandle.label} />
        </Handle>
      )}
    </div>
  );
}

/**
 * The labeled pill inside a Handle. Magnific uses a circular dark
 * pill (~28px) with a single icon â€” no fill, just a soft border and
 * an icon. Hover scales + lights up the border so the user knows
 * it's grabbable.
 */
function HandlePill({ icon: Icon, label }: { icon: LucideIcon; label?: string }) {
  return (
    <div
      title={label}
      aria-label={label}
      // pointer-events-none on the visual so the parent <Handle> stays
      // the entire hit target. Otherwise React Flow's drag handler
      // races with our wrapper hover.
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center",
        "rounded-full border transition-all duration-150",
      )}
      style={{
        // Inline so the dark pill is guaranteed opaque even when
        // Tailwind tree-shakes utilities; the colour matches the
        // canvas tone so the pill reads as "floating off the card".
        backgroundColor: "#2b2b2b",
        borderColor: "rgba(255,255,255,0.10)",
        color: "rgba(255,255,255,0.60)",
      }}
    >
      <Icon size={12} strokeWidth={2} />
    </div>
  );
}

