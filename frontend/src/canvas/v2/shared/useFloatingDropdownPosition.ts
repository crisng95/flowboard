import { useEffect, useState } from "react";

type Placement = "top" | "bottom";

export interface FloatingDropdownPosition {
  left: number;
  top: number;
  placement: Placement;
  minWidth: number;
  maxHeight: number;
}

const VIEWPORT_PAD = 12;
const MENU_GAP = 8;
const DEFAULT_MENU_HEIGHT = 280;

export function useFloatingDropdownPosition(
  anchorRef: React.RefObject<HTMLElement>,
  isOpen: boolean,
  opts?: {
    preferredPlacement?: Placement;
    minWidth?: number;
    estimatedHeight?: number;
    matchAnchorWidth?: boolean;
  },
) {
  const [position, setPosition] = useState<FloatingDropdownPosition | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    let raf = 0;

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const estimatedHeight = opts?.estimatedHeight ?? DEFAULT_MENU_HEIGHT;
      const preferred = opts?.preferredPlacement ?? "bottom";
      const availableBelow = viewportH - rect.bottom - VIEWPORT_PAD - MENU_GAP;
      const availableAbove = rect.top - VIEWPORT_PAD - MENU_GAP;

      let placement: Placement = preferred;
      if (preferred === "bottom" && availableBelow < Math.min(estimatedHeight, 180) && availableAbove > availableBelow) {
        placement = "top";
      } else if (preferred === "top" && availableAbove < Math.min(estimatedHeight, 180) && availableBelow > availableAbove) {
        placement = "bottom";
      }

      const minWidth = Math.max(
        opts?.minWidth ?? 176,
        opts?.matchAnchorWidth === false ? 0 : rect.width,
      );
      const unclampedLeft = rect.left;
      const maxLeft = viewportW - VIEWPORT_PAD - minWidth;
      const left = Math.max(VIEWPORT_PAD, Math.min(unclampedLeft, maxLeft));
      const top = placement === "bottom"
        ? rect.bottom + MENU_GAP
        : rect.top - MENU_GAP;
      const maxHeight = Math.max(
        120,
        placement === "bottom" ? availableBelow : availableAbove,
      );

      setPosition({
        left,
        top,
        placement,
        minWidth,
        maxHeight,
      });
    };

    const tick = () => {
      update();
      raf = window.requestAnimationFrame(tick);
    };

    update();
    raf = window.requestAnimationFrame(tick);

    const onWindowChange = () => update();
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
    };
  }, [anchorRef, isOpen, opts?.estimatedHeight, opts?.matchAnchorWidth, opts?.minWidth, opts?.preferredPlacement]);

  return position;
}
