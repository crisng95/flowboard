import { cn } from "../../../lib/utils";

export const EDGE_HANDLE_TOP_OFFSET = 48;
export const EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET = 72;

export function edgeHandleClass({
  side,
  visible,
  dragActive = false,
}: {
  side: "left" | "right";
  visible: boolean;
  dragActive?: boolean;
}) {
  const showByState = dragActive ? true : visible;

  return cn(
    "!absolute !h-7 !w-7 !border-0 !bg-transparent group/handle",
    side === "right" ? "!-right-0" : "!-left-0",
    "transition-opacity duration-300 ease-out",
    showByState ? "!opacity-100" : "!opacity-0 !pointer-events-none",
    dragActive && "!pointer-events-auto !z-50",
  );
}