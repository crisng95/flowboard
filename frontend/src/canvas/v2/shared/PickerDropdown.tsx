import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import { cn } from "../../../lib/utils";
import { useFloatingDropdownPosition } from "./useFloatingDropdownPosition";

export interface PickerItem {
  key: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  badge?: string;
}

export interface PickerDropdownProps {
  anchorRef: React.RefObject<HTMLElement>;
  isOpen: boolean;
  onClose: () => void;
  items: PickerItem[];
  activeKey?: string;
  activeKeys?: string[];
  onPick: (key: string) => void;
  className?: string;
  minWidth?: number;
  estimatedHeight?: number;
  matchAnchorWidth?: boolean;
  multiSelect?: boolean;
  renderItem?: (item: PickerItem, state: { active: boolean; disabled: boolean }) => React.ReactNode;
}

export function PickerDropdown({
  anchorRef,
  isOpen,
  onClose,
  items,
  activeKey,
  activeKeys,
  onPick,
  className,
  minWidth = 136,
  estimatedHeight = 212,
  matchAnchorWidth = true,
  multiSelect = false,
  renderItem,
}: PickerDropdownProps) {
  const portalRef = useRef<HTMLDivElement>(null);
  const position = useFloatingDropdownPosition(anchorRef, isOpen, {
    preferredPlacement: "bottom",
    minWidth,
    estimatedHeight,
    matchAnchorWidth,
  });

  useEffect(() => {
    if (!isOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (portalRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, isOpen, onClose]);

  if (!isOpen || !position) return null;

  return createPortal(
    <div
      ref={portalRef}
      className={cn(
        "fixed rounded-xl border shadow-2xl z-[9999] nowheel overflow-hidden",
        "bg-[#16161a] border-white/[0.08]",
        className,
      )}
      style={{
        left: position.left,
        top: position.top,
        minWidth: position.minWidth,
        maxHeight: position.maxHeight,
        transform: position.placement === "top" ? "translateY(calc(-100% - 2px))" : undefined,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className="overflow-y-auto magnific-dropdown-scroll p-1.5"
        style={{ maxHeight: position.maxHeight }}
      >
        {items.map((item) => {
          const active = multiSelect
             ? (activeKeys ?? []).includes(item.key)
             : item.key === activeKey;
          const disabled = !!item.disabled;

          return renderItem ? (
            <div key={item.key}>{renderItem(item, { active, disabled })}</div>
          ) : (
            <button
              key={item.key}
              type="button"
              disabled={disabled}
              onClick={() => onPick(item.key)}
              className={cn(
                "w-full rounded-lg px-2.5 py-2 text-left transition-colors flex items-center gap-2.5 text-xs font-semibold outline-none",
                disabled
                  ? "cursor-not-allowed opacity-50 text-white/40"
                  : active
                  ? "bg-white/[0.08] text-white"
                  : "text-white/80 hover:bg-white/[0.08] hover:text-white",
              )}
            >
              {multiSelect && (
                <div
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-md border transition-colors",
                    active ? "border-accent/80 bg-accent/15 text-accent" : "border-white/24 bg-transparent",
                  )}
                >
                  {active && <Check size={10} strokeWidth={3} />}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold leading-4">{item.label}</div>
                {item.hint && (
                  <div className="mt-0.5 text-[10px] leading-3 text-white/40">{item.hint}</div>
                )}
              </div>
              {!multiSelect && active && <Check size={14} strokeWidth={2.5} className="shrink-0 text-accent" />}
              {item.badge && (
                <span className="shrink-0 rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-white/52">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
