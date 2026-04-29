import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { AccountPanel } from "./AccountPanel";

/**
 * Left sidebar listing every local "project" (Board). Click an item to
 * switch the active board; the canvas re-loads its nodes/edges. Provides
 * inline create / rename / delete (with confirm) — all backed by the
 * /api/boards CRUD that already cascades to children on delete.
 */
export function ProjectSidebar() {
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
    if (renamingId !== null) {
      setTimeout(() => renameInputRef.current?.select(), 30);
    }
  }, [renamingId]);

  // Click-outside closes the kebab menu.
  useEffect(() => {
    if (openMenuId === null) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".project-sidebar__menu") && !t.closest(".project-sidebar__kebab")) {
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

  function closeNewDialog() {
    if (newDialogBusy) return;
    setNewDialogOpen(false);
    setNewDialogName("");
  }

  async function commitNewDialog() {
    if (newDialogBusy) return;
    const name = newDialogName.trim() || "Untitled";
    setNewDialogBusy(true);
    try {
      await createNewBoard(name);
    } finally {
      setNewDialogBusy(false);
      setNewDialogOpen(false);
      setNewDialogName("");
    }
  }

  // Esc closes the new-project dialog.
  useEffect(() => {
    if (!newDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNewDialog();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDialogOpen, newDialogBusy]);

  function startRename(id: number, currentName: string) {
    setRenamingId(id);
    setRenameDraft(currentName);
    setOpenMenuId(null);
  }

  async function commitRename() {
    if (renamingId === null) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    // Only the active board can be renamed via the existing renameBoard
    // action; for other boards, switch first then rename. Keeps the
    // backend round-trip simple.
    if (renamingId !== activeId) {
      await switchBoard(renamingId);
    }
    await renameBoard(name);
    setRenamingId(null);
  }

  function openDeleteConfirm(id: number, name: string) {
    setOpenMenuId(null);
    setDeleteTarget({ id, name });
  }

  async function commitDelete() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteBoardById(deleteTarget.id);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  function cancelDelete() {
    if (deleteBusy) return;
    setDeleteTarget(null);
  }

  // Esc closes the delete-confirm dialog.
  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDelete();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteTarget, deleteBusy]);

  return (
    <aside className={`project-sidebar${collapsed ? " project-sidebar--collapsed" : ""}`}>
      <div className="project-sidebar__header">
        {!collapsed && <span className="project-sidebar__title">Projects</span>}
        <button
          type="button"
          className="project-sidebar__icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      {!collapsed && (
        <>
          <button
            type="button"
            className="project-sidebar__new"
            onClick={handleNew}
          >
            <span aria-hidden="true">+</span> New project
          </button>
          <ul className="project-sidebar__list">
            {boards.map((b) => {
              const isActive = b.id === activeId;
              const isRenaming = b.id === renamingId;
              return (
                <li
                  key={b.id}
                  className={`project-sidebar__item${isActive ? " project-sidebar__item--active" : ""}`}
                >
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="project-sidebar__rename-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="project-sidebar__name"
                        onClick={() => switchBoard(b.id)}
                        title={b.name}
                      >
                        {b.name || "Untitled"}
                      </button>
                      <button
                        type="button"
                        className="project-sidebar__kebab"
                        onClick={() =>
                          setOpenMenuId((cur) => (cur === b.id ? null : b.id))
                        }
                        aria-label="Project actions"
                      >
                        ⋯
                      </button>
                      {openMenuId === b.id && (
                        <div className="project-sidebar__menu" role="menu">
                          <button
                            type="button"
                            onClick={() => startRename(b.id, b.name)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="project-sidebar__menu-danger"
                            onClick={() => openDeleteConfirm(b.id, b.name)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
            {boards.length === 0 && (
              <li className="project-sidebar__empty">No projects yet</li>
            )}
          </ul>
        </>
      )}

      {/* Pinned-bottom account chip — sits below the project list because
          the list above has flex: 1 and pushes everything that follows
          to the bottom of the column. */}
      <AccountPanel collapsed={collapsed} />

      {deleteTarget && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) cancelDelete();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <h2 id="delete-project-title" className="project-modal__title">
              Delete project?
            </h2>
            <p className="project-modal__hint">
              <strong>"{deleteTarget.name}"</strong> sẽ bị xoá vĩnh viễn cùng
              với tất cả nodes, edges, generations, và assets bên trong. Không
              thể khôi phục.
            </p>
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={cancelDelete}
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--danger"
                onClick={commitDelete}
                disabled={deleteBusy}
                autoFocus
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {newDialogOpen && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeNewDialog();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
          >
            <h2 id="new-project-title" className="project-modal__title">
              New project
            </h2>
            <p className="project-modal__hint">
              Tên project hiển thị trong sidebar. Có thể đổi sau.
            </p>
            <input
              ref={newDialogInputRef}
              className="project-modal__input"
              type="text"
              maxLength={80}
              value={newDialogName}
              onChange={(e) => setNewDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewDialog();
                if (e.key === "Escape") closeNewDialog();
              }}
              placeholder="Untitled"
              disabled={newDialogBusy}
              autoFocus
            />
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={closeNewDialog}
                disabled={newDialogBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--primary"
                onClick={commitNewDialog}
                disabled={newDialogBusy}
              >
                {newDialogBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
