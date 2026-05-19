/**
 * Node settings panel store.
 *
 * Magnific-style affordance: each node carries a small bag of "power
 * user" overrides (custom system prompt, aspect ratio override, etc.)
 * surfaced through a side drawer rather than dumped on the card. The
 * cards stay clean; the drawer is opt-in via a gear icon in the
 * reveal bar.
 *
 * Mutually exclusive: only one panel open at a time. Opening another
 * node''s panel auto-closes the previous one. Closes on explicit X
 * click, on Escape, or when the underlying node is removed from the
 * board.
 */
import { create } from "zustand";

export interface NodeSettingsState {
  /** rfId of the node whose panel is open, or null when none. */
  openFor: string | null;
  open: (rfId: string) => void;
  close: () => void;
  toggle: (rfId: string) => void;
  /** Helper for keyboard / outside-click handlers. */
  isOpen: (rfId: string) => boolean;
}

export const useNodeSettingsStore = create<NodeSettingsState>((set, get) => ({
  openFor: null,
  open: (rfId: string) => set({ openFor: rfId }),
  close: () => set({ openFor: null }),
  toggle: (rfId: string) =>
    set((state) => ({ openFor: state.openFor === rfId ? null : rfId })),
  isOpen: (rfId: string) => get().openFor === rfId,
}));