/**
 * Utility helpers for the V2 (Tailwind) UI layer.
 *
 * `cn()` is the shadcn convention: composes class names while letting
 * later tokens override earlier ones via `tailwind-merge`. Used by every
 * Tailwind component so consumers can pass `className` overrides without
 * worrying about specificity.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Read the current UI version preference from localStorage.
 *
 * Phase 1 ships V2 components behind this flag so we can ship migrations
 * incrementally without disturbing V1. Set
 * `localStorage.flowboard_ui = "v2"` in DevTools to opt in. Defaults to
 * "v1" until V2 reaches feature parity, at which point we flip the
 * default and remove the flag.
 */
export type UiVersion = "v1" | "v2";
export function getUiVersion(): UiVersion {
  if (typeof window === "undefined") return "v2";
  const v = window.localStorage.getItem("flowboard_ui");
  return v === "v1" ? "v1" : "v2";
}
