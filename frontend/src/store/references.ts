import { create } from "zustand";
import {
  createReference,
  deleteReference,
  listReferences,
  patchReference,
  type ReferenceCreateInput,
  type ReferenceItem,
} from "../api/client";

/**
 * User-curated cross-board reference library.
 *
 * State here mirrors the /api/references backend (rows are server-side
 * SQLModel `Reference` records). The store keeps a flat in-memory array
 * sorted (pinned DESC, position ASC, createdAt DESC) — same order the
 * backend's GET endpoint returns. Local mutations re-sort with the same
 * comparator so the UI stays consistent without an extra round-trip.
 *
 * `panelOpen` is the only piece of UI state persisted to localStorage
 * (single versioned key, fail-soft on parse errors). The references
 * themselves live server-side; loss-of-state on page reload is a
 * non-issue because `load()` re-hydrates them on app mount.
 */
export interface ReferencesState {
  items: ReferenceItem[];
  loading: boolean;
  error: string | null;
  panelOpen: boolean;
  query: string;

  load(): Promise<void>;
  save(input: ReferenceCreateInput): Promise<ReferenceItem>;
  remove(id: number): Promise<void>;
  rename(id: number, label: string): Promise<void>;
  togglePin(id: number): Promise<void>;
  setQuery(q: string): void;
  togglePanel(): void;
  setPanelOpen(open: boolean): void;
}

const PANEL_STORAGE_KEY = "flowboard.references.panel.v1";

function loadPersistedPanelOpen(): boolean {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : false;
  } catch {
    return false;
  }
}

function persistPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(open));
  } catch {
    // Quota / disabled storage — non-fatal, just lose persistence.
  }
}

/**
 * Sort references the same way the backend GET endpoint orders them:
 *   pinned DESC, position ASC, createdAt DESC.
 * Used after any local mutation that might shift order (pin toggle,
 * rename doesn't reorder, save prepends but pinning may overrule).
 */
function sortReferences(items: ReferenceItem[]): ReferenceItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.position !== b.position) return a.position - b.position;
    // createdAt is ISO-8601; lexicographic descending matches the
    // backend's `created_at.desc()` for these timestamps.
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export const useReferencesStore = create<ReferencesState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  panelOpen: loadPersistedPanelOpen(),
  query: "",

  async load() {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const items = await listReferences({ limit: 200 });
      set({ items, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async save(input) {
    // POST is idempotent on media_id server-side: if the user re-saves
    // the same variant, the backend returns the existing row. We then
    // upsert into local state — replace if present, prepend otherwise.
    const row = await createReference(input);
    const existing = get().items.find((r) => r.id === row.id);
    const next = existing
      ? get().items.map((r) => (r.id === row.id ? row : r))
      : [row, ...get().items];
    set({ items: sortReferences(next) });
    return row;
  },

  async remove(id) {
    await deleteReference(id);
    set({ items: get().items.filter((r) => r.id !== id) });
  },

  async rename(id, label) {
    const row = await patchReference(id, { label });
    set({
      items: get().items.map((r) => (r.id === row.id ? row : r)),
    });
  },

  async togglePin(id) {
    const current = get().items.find((r) => r.id === id);
    if (!current) return;
    const row = await patchReference(id, { pinned: !current.pinned });
    const next = get().items.map((r) => (r.id === row.id ? row : r));
    set({ items: sortReferences(next) });
  },

  setQuery(q) {
    set({ query: q });
  },

  togglePanel() {
    const open = !get().panelOpen;
    set({ panelOpen: open });
    persistPanelOpen(open);
  },

  setPanelOpen(open) {
    if (get().panelOpen === open) return;
    set({ panelOpen: open });
    persistPanelOpen(open);
  },
}));

/**
 * Client-side filter on the in-memory items array. Substring match on
 * label OR aiBrief, case-insensitive. Empty query returns the full
 * sorted list unchanged. Caller is responsible for memoising — this
 * helper does no caching.
 */
export function filterReferences(
  items: ReferenceItem[],
  query: string,
): ReferenceItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((r) => {
    if (r.label.toLowerCase().includes(needle)) return true;
    if (r.aiBrief && r.aiBrief.toLowerCase().includes(needle)) return true;
    return false;
  });
}
