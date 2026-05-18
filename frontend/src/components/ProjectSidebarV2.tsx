/**
 * ProjectSidebarV2 — dark compact sidebar matching Magnific tone.
 *
 * Keeps the text-list pattern (functional for multi-project workflow)
 * but restyled:
 *   - Darker surface (same as canvas, not a separate panel tone)
 *   - Thinner border (rgba white 4%)
 *   - Compact items (28px height, 11px font)
 *   - Active item: accent dot + subtle bg tint
 *   - Hover: soft white/5% bg
 *   - "New project" button: accent gradient pill
 *   - Collapse to 44px icon rail (same as V1 but styled)
 *   - Account panel stays at bottom
 *
 * Logic is identical to V1 ProjectSidebar — only presentation changes.
 * Modals (new/delete) reuse the existing CSS classes (project-modal-*)
 * since they're already dark-themed and functional.
 */
import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { AccountPanel } from "./AccountPanel";
import { cn } from "../lib/utils";

export function ProjectSidebarV2() {
  const boards = useBoardStore((s) => s.boards);
  const activeId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const renameBoard = useBoardStore((s) => s.renameBoard);

  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newDialogName, setNewDialogName] = useState("");
  const [newDialogBusy, setNewDialogBusy] = useState(false);
  const newDialogInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (renamingId !== null) setTimeout(() => renameInputRef.current?.select(), 30);
  }, [renamingId]);

  useEffect(() => {
    if (openMenuId === null) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest("[data-sidebar-menu]") && !t.closest("[data-sidebar-kebab]")) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenuId]);

  function handleNew() {
    setNewDialogName("Untitled");
    setNewDialogOpen(true);
    setTimeout(() => newDialogInputRef.current?.select(), 30);
  }
  function closeNewDialog() { if (!newDialogBusy) { setNewDialogOpen(false); setNewDialogName(""); } }
  async function commitNewDialog() {
    if (newDialogBusy) return;
    setNewDialogBusy(true);
    try { await createNewBoard(newDialogName.trim() || "Untitled"); }
    finally { setNewDialogBusy(false); setNewDialogOpen(false); setNewDialogName(""); }
  }
  useEffect(() => {
    if (!newDialogOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeNewDialog(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newDialogOpen, newDialogBusy]); // eslint-disable-line

  function startRename(id: number, name: string) { setRenamingId(id); setRenameDraft(name); setOpenMenuId(null); }
  async function commitRename() {
    if (renamingId === null) return;
    const name = renameDraft.trim();
    if (!name) { setRenamingId(null); return; }
    if (renamingId !== activeId) await switchBoard(renamingId);
    await renameBoard(name);
    setRenamingId(null);
  }
  function openDeleteConfirm(id: number, name: string) { setOpenMenuId(null); setDeleteTarget({ id, name }); }
  async function commitDelete() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try { await deleteBoardById(deleteTarget.id); }
    finally { setDeleteBusy(false); setDeleteTarget(null); }
  }
  function cancelDelete() { if (!deleteBusy) setDeleteTarget(null); }
  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelDelete(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [deleteTarget, deleteBusy]); // eslint-disable-line

  return (
    <aside
      className={cn(
        "flex flex-col shrink-0 transition-[width] duration-150 overflow-hidden",
        collapsed ? "w-11" : "w-52",
      )}
      style={{
        backgroundColor: "#0c0d12",
        borderRight: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        {!collapsed && (
          <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">
            Projects
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="size-6 inline-flex items-center justify-center rounded-md text-ink-muted hover:bg-white/[0.06] hover:text-ink-primary transition-colors text-xs"
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* New project button */}
          <button
            type="button"
            onClick={handleNew}
            className="mx-2.5 mb-2 h-7 rounded-full text-2xs font-medium inline-flex items-center justify-center gap-1.5 transition-all duration-150 hover:scale-[1.02]"
            style={{
              background: "linear-gradient(135deg, #9d80ff 0%, #7c5cff 100%)",
              color: "#fff",
              boxShadow: "0 2px 8px rgba(124,92,255,0.3)",
            }}
          >
            <span>+</span> New project
          </button>

          {/* Board list */}
          <ul className="flex-1 overflow-y-auto px-1.5 pb-2 flex flex-col gap-px scrollbar-none">
            {boards.map((b) => {
              const isActive = b.id === activeId;
              const isRenaming = b.id === renamingId;
              return (
                <li key={b.id} className="relative group">
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="w-full h-7 px-2 text-2xs rounded-md bg-surface-2 border border-accent/50 text-ink-primary outline-none"
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex items-center h-7 rounded-md px-2 cursor-pointer transition-colors",
                        isActive
                          ? "bg-accent/10"
                          : "hover:bg-white/[0.04]",
                      )}
                      onClick={() => switchBoard(b.id)}
                    >
                      {/* Active dot */}
                      <span
                        className={cn(
                          "size-1.5 rounded-full shrink-0 mr-2 transition-colors",
                          isActive ? "bg-accent" : "bg-transparent",
                        )}
                      />
                      <span
                        className={cn(
                          "flex-1 text-2xs truncate",
                          isActive ? "text-white font-medium" : "text-ink-muted",
                        )}
                        title={b.name}
                      >
                        {b.name || "Untitled"}
                      </span>
                      {/* Kebab */}
                      <button
                        type="button"
                        data-sidebar-kebab
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId((cur) => (cur === b.id ? null : b.id));
                        }}
                        className="size-5 shrink-0 inline-flex items-center justify-center rounded text-ink-muted opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] transition-opacity text-xs"
                        aria-label="Project actions"
                      >
                        ⋯
                      </button>
                      {/* Menu */}
                      {openMenuId === b.id && (
                        <div
                          data-sidebar-menu
                          className="absolute right-1 top-full z-50 mt-0.5 min-w-[100px] rounded-lg overflow-hidden animate-scale-in"
                          style={{
                            backgroundColor: "#1a1d25",
                            border: "1px solid rgba(255,255,255,0.08)",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => startRename(b.id, b.name)}
                            className="w-full text-left px-3 py-1.5 text-2xs text-ink-primary hover:bg-white/[0.05] transition-colors"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => openDeleteConfirm(b.id, b.name)}
                            className="w-full text-left px-3 py-1.5 text-2xs text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {boards.length === 0 && (
              <li className="px-2 py-3 text-2xs text-ink-placeholder italic">
                No projects yet
              </li>
            )}
          </ul>
        </>
      )}

      {/* Account panel — pinned bottom */}
      <AccountPanel collapsed={collapsed} />

      {/* Modals — reuse existing V1 CSS classes (already dark-themed) */}
      {deleteTarget && (
        <div className="project-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}>
          <div className="project-modal" role="dialog" aria-modal="true">
            <h2 className="project-modal__title">Delete project?</h2>
            <p className="project-modal__hint">
              <strong>"{deleteTarget.name}"</strong> sẽ bị xoá vĩnh viễn cùng với tất cả nodes, edges, generations, và assets bên trong.
            </p>
            <div className="project-modal__actions">
              <button type="button" className="project-modal__btn" onClick={cancelDelete} disabled={deleteBusy}>Cancel</button>
              <button type="button" className="project-modal__btn project-modal__btn--danger" onClick={commitDelete} disabled={deleteBusy} autoFocus>
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {newDialogOpen && (
        <div className="project-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) closeNewDialog(); }}>
          <div className="project-modal" role="dialog" aria-modal="true">
            <h2 className="project-modal__title">New project</h2>
            <p className="project-modal__hint">Tên project hiển thị trong sidebar.</p>
            <input
              ref={newDialogInputRef}
              className="project-modal__input"
              type="text"
              maxLength={80}
              value={newDialogName}
              onChange={(e) => setNewDialogName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitNewDialog(); if (e.key === "Escape") closeNewDialog(); }}
              placeholder="Untitled"
              disabled={newDialogBusy}
              autoFocus
            />
            <div className="project-modal__actions">
              <button type="button" className="project-modal__btn" onClick={closeNewDialog} disabled={newDialogBusy}>Cancel</button>
              <button type="button" className="project-modal__btn project-modal__btn--primary" onClick={commitNewDialog} disabled={newDialogBusy}>
                {newDialogBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
