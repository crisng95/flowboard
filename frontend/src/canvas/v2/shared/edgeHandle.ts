import { cn } from "../../../lib/utils";

export const EDGE_HANDLE_TOP_OFFSET = 48;
export const EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET = 72;

export function edgeHandleClass({
  side,
  visible,
}: {
  side: "left" | "right";
  visible: boolean;
}) {
  return cn(
    "!absolute !h-7 !w-7 !border-0 !bg-transparent group/handle",
    side === "right" ? "!-right-0" : "!-left-0",
    "transition-opacity duration-300 ease-out",
    visible ? "!opacity-100" : "!opacity-0 !pointer-events-none",
  );
}
