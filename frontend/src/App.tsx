import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow, useViewport } from "@xyflow/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleHelp,
  Heart,
  Home,
  LayoutGrid,
  List,
  Map as MapIcon,
  MoreHorizontal,
  Plus,
  Pencil,
  Search,
  Settings,
  Share2,
  Sparkles,
  Trash2,
  UserCircle2,
  Upload,
  X,
  Loader2,
} from "lucide-react";

import { getAuthMe, mediaUrl, type AuthMe, createBoard, createNode, createEdge, patchNode } from "./api/client";
import * as localDb from "./api/localStorageDb";
import { Board } from "./canvas/Board";
import { AddNodePalette } from "./canvas/AddNodePalette";
import { AppLogo } from "./components/AppLogo";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewerV2 } from "./components/ResultViewerV2";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { AuthGateModal } from "./components/AuthGateModal";
import { ExtensionGateModal } from "./components/ExtensionGateModal";
import { supabase } from "./cloud/supabase";
import { SPACE_TEMPLATES, type SpaceTemplate } from "./constants/spaceTemplates";
import { useGenerationStore } from "./store/generation";
import { useBoardStore, type FlowNode, type FlowboardEdgeData } from "./store/board";
import { useReferencesStore } from "./store/references";
import type { Edge } from "@xyflow/react";

type SpacesTab = "my" | "templates";

const SPACE_PRESETS = [
  "radial-gradient(circle at 18% 22%, rgba(255,214,176,0.95) 0%, rgba(198,144,255,0.32) 28%, rgba(20,21,28,0) 56%), linear-gradient(135deg, #2d211e 0%, #101116 100%)",
  "radial-gradient(circle at 50% 35%, rgba(114,158,255,0.85) 0%, rgba(70,110,255,0.18) 40%, rgba(17,18,24,0) 68%), linear-gradient(135deg, #111521 0%, #1b2335 45%, #0c0d12 100%)",
  "linear-gradient(135deg, rgba(102,17,37,0.95) 0%, rgba(41,6,15,0.88) 38%, rgba(15,15,19,0.98) 100%)",
  "radial-gradient(circle at 70% 30%, rgba(93,140,255,0.42) 0%, rgba(18,27,49,0) 35%), linear-gradient(135deg, #17213a 0%, #090a0e 100%)",
  "linear-gradient(135deg, rgba(183,151,105,0.3) 0%, rgba(103,70,42,0.18) 28%, rgba(19,19,24,0.95) 100%)",
  "linear-gradient(135deg, rgba(44,44,44,0.95) 0%, rgba(19,19,24,0.95) 100%)",
];

const SPACE_SNAPSHOTS_KEY = "flowboard.spaceSnapshots.v1";
const SPACE_COVERS_KEY = "flowboard.spaceCoverOverrides.v1";

function resolveAuthTier(profile: AuthMe | null): "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null {
  if (profile?.paygate_tier) return profile.paygate_tier;
  const sku = profile?.sku?.trim().toUpperCase() ?? "";
  if (sku.includes("ULTRA") || sku.includes("TIER_TWO")) return "PAYGATE_TIER_TWO";
  if (sku.includes("PRO") || sku.includes("TIER_ONE")) return "PAYGATE_TIER_ONE";
  return null;
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "Recently";
  const diffMs = Date.now() - ts;
  const day = Math.max(1, Math.floor(diffMs / 86_400_000));
  if (day === 1) return "1 day ago";
  if (day < 30) return `${day} days ago`;
  const month = Math.floor(day / 30);
  if (month === 1) return "1 month ago";
  return `${month} months ago`;
}

function formatBoardTitle(name: string): string {
  const raw = name.trim() || "Untitled space";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function resolveNodePreviewUrl(mediaId?: string): string | null {
  if (!mediaId) return null;
  if (/^(https?:)?\/\//.test(mediaId) || mediaId.startsWith("data:")) return mediaId;
  return mediaUrl(mediaId);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createBoardThumbnail(nodes: FlowNode[], edges: Edge<FlowboardEdgeData>[]): string | null {
  if (nodes.length === 0) return null;
  const frameNodes = nodes.map((node) => {
    const style = (node.style ?? {}) as { width?: number; height?: number };
    const width = typeof style.width === "number" ? style.width : node.data.nodeWidth ?? 280;
    const height = typeof style.height === "number" ? style.height : 190;
    return { node, width, height };
  });
  const minX = Math.min(...frameNodes.map(({ node }) => node.position.x));
  const minY = Math.min(...frameNodes.map(({ node }) => node.position.y));
  const maxX = Math.max(...frameNodes.map(({ node, width }) => node.position.x + width));
  const maxY = Math.max(...frameNodes.map(({ node, height }) => node.position.y + height));
  const padding = 32;
  const width = Math.max(360, maxX - minX + padding * 2);
  const height = Math.max(240, maxY - minY + padding * 2);

  const edgeSvg = edges
    .map((edge) => {
      const source = frameNodes.find((entry) => entry.node.id === edge.source);
      const target = frameNodes.find((entry) => entry.node.id === edge.target);
      if (!source || !target) return "";
      const x1 = source.node.position.x - minX + padding + source.width;
      const y1 = source.node.position.y - minY + padding + source.height / 2;
      const x2 = target.node.position.x - minX + padding;
      const y2 = target.node.position.y - minY + padding + target.height / 2;
      const c1 = x1 + Math.max(50, (x2 - x1) * 0.35);
      const c2 = x2 - Math.max(50, (x2 - x1) * 0.35);
      return `<path d="M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}" stroke="rgba(124,92,255,0.58)" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    })
    .join("");

  const nodeSvg = frameNodes
    .map(({ node, width: nodeWidth, height: nodeHeight }, index) => {
      const x = node.position.x - minX + padding;
      const y = node.position.y - minY + padding;
      const previewUrl = resolveNodePreviewUrl(node.data.mediaId);
      const clipId = `thumb-clip-${index}`;
      const title = escapeXml(node.data.title || "Node");
      const subtitle = escapeXml(
        node.data.type === "text" || node.data.type === "note"
          ? String(node.data.prompt ?? "")
          : String(node.data.type ?? ""),
      ).slice(0, 90);
      const fill =
        node.data.type === "group"
          ? "rgba(82,60,128,0.28)"
          : node.data.type === "note"
          ? "rgba(196,160,72,0.22)"
          : "rgba(28,29,34,0.96)";
      return `
        <defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="22" ry="22" /></clipPath></defs>
        <rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="22" ry="22" fill="${fill}" stroke="rgba(255,255,255,0.1)" />
        ${previewUrl ? `<image href="${escapeXml(previewUrl)}" x="${x + 10}" y="${y + 34}" width="${Math.max(0, nodeWidth - 20)}" height="${Math.max(0, nodeHeight - 54)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" opacity="0.92" />` : ""}
        <text x="${x + 14}" y="${y + 22}" font-size="13" font-family="Inter, Segoe UI, sans-serif" fill="rgba(255,255,255,0.92)" font-weight="600">${title}</text>
        ${subtitle ? `<text x="${x + 14}" y="${y + nodeHeight - 16}" font-size="12" font-family="Inter, Segoe UI, sans-serif" fill="rgba(255,255,255,0.46)">${subtitle}</text>` : ""}
      `;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#121217"/>
    <g opacity="0.18">
      ${Array.from({ length: Math.floor(width / 24) * Math.floor(height / 24) }, (_, i) => {
        const cols = Math.floor(width / 24);
        const cx = (i % cols) * 24 + 12;
        const cy = Math.floor(i / cols) * 24 + 12;
        return `<circle cx="${cx}" cy="${cy}" r="1.1" fill="white" />`;
      }).join("")}
    </g>
    ${edgeSvg}
    ${nodeSvg}
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function SpacesPage({
  thumbnails,
  onUploadCover,
  onUseSnapshotCover,
  onClearCustomCover,
  session,
}: {
  thumbnails: Record<number, string>;
  onUploadCover: (boardId: number, file: File) => Promise<void>;
  onUseSnapshotCover: (boardId: number, sourceBoardId?: number) => void;
  onClearCustomCover: (boardId: number) => void;
  session: any;
}) {
  const isGuest = !session;
  const setShowAuthModal = useBoardStore((s) => s.setShowAuthModal);
  const boards = useBoardStore((s) => s.boards);
  const loading = useBoardStore((s) => s.loading);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const setView = useBoardStore((s) => s.setView);
  const selectProject = useBoardStore((s) => s.selectProject);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const renameBoardById = useBoardStore((s) => s.renameBoardById);
  const duplicateBoardById = useBoardStore((s) => s.duplicateBoardById);
  const createBoardFromSnapshot = useBoardStore((s) => s.createBoardFromSnapshot);
  const [tab, setTab] = useState<SpacesTab>("my");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ id: number; name: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [coverTarget, setCoverTarget] = useState<number | null>(null);
  const [menuBoardId, setMenuBoardId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const nextUntitledName = useMemo(() => `Untitled space #${boards.length + 1}`, [boards.length]);

  const visibleBoards = useMemo(() => {
    const query = search.trim().toLowerCase();
    const source = boards;
    if (!query) return source;
    return source.filter((board) => board.name.toLowerCase().includes(query));
  }, [boards, search]);

  const visibleTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return SPACE_TEMPLATES;
    return SPACE_TEMPLATES.filter((template) => template.name.toLowerCase().includes(query));
  }, [search]);

  useEffect(() => {
    if (!newSpaceOpen) return;
    setNewSpaceName(nextUntitledName);
  }, [newSpaceOpen, nextUntitledName]);

  useEffect(() => {
    if (menuBoardId === null) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest("[data-space-menu]") && !target.closest("[data-space-menu-trigger]")) {
        setMenuBoardId(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuBoardId]);

  async function handleCreateSpace() {
    const id = await createNewBoard(newSpaceName.trim() || nextUntitledName);
    if (id !== null) {
      setNewSpaceOpen(false);
      setNewSpaceName("");
      setView("canvas");
    }
  }

  async function handleRenameBoard() {
    if (!renameTarget) return;
    await renameBoardById(renameTarget.id, renameDraft.trim() || renameTarget.name);
    setRenameTarget(null);
    setRenameDraft("");
  }

  async function handleDuplicateBoard(boardId: number, boardName: string) {
    const id = await duplicateBoardById(boardId, `${boardName} (Copy)`);
    if (id !== null && thumbnails[boardId]) {
      onUseSnapshotCover(id, boardId);
    }
  }

  async function handleCoverFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || coverTarget === null) return;
    await onUploadCover(coverTarget, file);
    setCoverTarget(null);
    event.target.value = "";
  }

  async function handleCreateFromTemplate(template: SpaceTemplate) {
    const id = await createBoardFromSnapshot(template.name, template.snapshot);
    if (id !== null) {
      setView("canvas");
    }
  }

  return (
    <div className="magnific-shell magnific-spaces">
      <aside className="magnific-rail">
        <div className="magnific-rail__top">
          <div className="magnific-logo" style={{ background: "transparent" }}>
            <AppLogo className="size-full" />
          </div>
          <button type="button" className="magnific-rail__icon magnific-rail__icon--active" aria-label="Spaces">
            <Home size={16} />
          </button>
        </div>
        <div className="magnific-rail__bottom">
          <button type="button" className="magnific-rail__icon" aria-label="Settings">
            <Settings size={16} />
          </button>
          <button type="button" className="magnific-rail__icon" aria-label="Help">
            <CircleHelp size={16} />
          </button>
        </div>
      </aside>

      <header className="magnific-spaces__header">
        <button type="button" className="magnific-filter-pill">
          <span className="magnific-filter-pill__dot" />
          Personal project
          <ChevronDown size={14} />
        </button>
        <div className="magnific-header-actions">
          <button type="button" className="magnific-pricing-link">Pricing</button>
          <button type="button" className="magnific-avatar" aria-label="Profile">
            <UserCircle2 size={19} />
          </button>
        </div>
      </header>

      <main className="magnific-spaces__content">
        <div className="magnific-spaces__hero">
          <div>
            <h1>Spaces</h1>
            <p>Build node-based generative workflows and bring your ideas to life.</p>
          </div>
        </div>

        <div className="magnific-spaces__toolbar">
          <div className="magnific-tabs">
            <button type="button" className={tab === "my" ? "is-active" : ""} onClick={() => setTab("my")}>My spaces</button>
            <button type="button" className={tab === "templates" ? "is-active" : ""} onClick={() => setTab("templates")}>Templates</button>
            <span className="magnific-coming-soon">Shared · Coming soon</span>
          </div>
          <div className="magnific-spaces__actions">
            <button type="button" className="magnific-primary-button" onClick={() => setNewSpaceOpen(true)}>
              <Plus size={16} />
              New space
            </button>
            {isGuest && (
              <button
                type="button"
                className="magnific-secondary-button border border-accent/30 text-accent hover:bg-accent/10 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
                onClick={() => setShowAuthModal(true)}
              >
                <Sparkles size={14} />
                New Cloud Space
              </button>
            )}
            <button type="button" className="magnific-icon-button" aria-label="Favorites">
              <Heart size={16} />
            </button>
            <button
              type="button"
              className="magnific-icon-button"
              aria-label="Toggle layout"
              onClick={() => setLayoutMode((m) => (m === "grid" ? "list" : "grid"))}
            >
              {layoutMode === "grid" ? <List size={16} /> : <LayoutGrid size={16} />}
            </button>
            <label className="magnific-search">
              <Search size={15} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="Search spaces" />
            </label>
          </div>
        </div>

        {loading && boards.length === 0 && tab === "my" ? (
          <div className="magnific-empty-state">Loading spaces...</div>
        ) : (
          <div className={layoutMode === "grid" ? "magnific-space-grid" : "magnific-space-list"}>
            {tab === "my"
              ? visibleBoards.map((board, index) => (
              <article
                key={board.id}
                className="magnific-space-card"
                onClick={() => void selectProject(board.id)}
              >
                <button
                  type="button"
                  className="magnific-space-card__menu-trigger"
                  data-space-menu-trigger
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuBoardId((current) => (current === board.id ? null : board.id));
                  }}
                  aria-label="Space options"
                >
                  <MoreHorizontal size={16} />
                </button>
                {menuBoardId === board.id ? (
                  <div className="magnific-space-card__menu" data-space-menu onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => {
                        setRenameTarget({ id: board.id, name: board.name });
                        setRenameDraft(board.name);
                        setMenuBoardId(null);
                      }}
                    >
                      <Pencil size={14} />
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCoverTarget(board.id);
                        setMenuBoardId(null);
                      }}
                    >
                      <Upload size={14} />
                      Change cover
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isGuest) {
                          setShowAuthModal(true);
                        } else {
                          void handleDuplicateBoard(board.id, board.name);
                        }
                        setMenuBoardId(null);
                      }}
                    >
                      <Plus size={14} />
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        onClearCustomCover(board.id);
                        void deleteBoardById(board.id);
                        setMenuBoardId(null);
                      }}
                    >
                      <Trash2 size={14} />
                      Move to trash
                    </button>
                  </div>
                ) : null}
                {thumbnails[board.id] ? (
                  <div className="magnific-space-card__thumb magnific-space-card__thumb--image">
                    <img src={thumbnails[board.id]} alt={board.name} />
                  </div>
                ) : (
                  <div
                    className="magnific-space-card__thumb"
                    style={{ background: SPACE_PRESETS[index % SPACE_PRESETS.length] }}
                  >
                    <div className="magnific-space-card__orb" />
                    <div className="magnific-space-card__wireframe" />
                  </div>
                )}
                <div className="magnific-space-card__meta">
                  <strong>{formatBoardTitle(board.name)}</strong>
                  <span>{formatRelativeTime(board.created_at)}</span>
                </div>
              </article>
                ))
              : visibleTemplates.map((template, index) => {
                const templateThumb = createBoardThumbnail(template.snapshot.nodes, template.snapshot.edges);
                return (
                  <article
                    key={template.id}
                    className="magnific-space-card"
                    onClick={() => void handleCreateFromTemplate(template)}
                  >
                    <div
                      className="magnific-space-card__cover"
                      style={{ background: SPACE_PRESETS[index % SPACE_PRESETS.length] }}
                    >
                      {templateThumb ? (
                        <img src={templateThumb} alt={template.name} />
                      ) : (
                        <div className="magnific-space-card__placeholder">
                          <Sparkles size={24} />
                          <span>Template</span>
                        </div>
                      )}
                    </div>
                    <div className="magnific-space-card__meta">
                      <strong>{template.name}</strong>
                      <span>{template.updatedLabel}</span>
                    </div>
                  </article>
                );
              })}
          </div>
        )}
      </main>

      {newSpaceOpen ? (
        <div className="magnific-modal-backdrop">
          <div className="magnific-modal-card">
            <div className="magnific-modal-card__header">
              <div>
                <h3>Create new space</h3>
                <p>Name your new project before opening the canvas.</p>
              </div>
              <button type="button" className="magnific-modal-close" onClick={() => setNewSpaceOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <label className="magnific-modal-field">
              <span>Space name</span>
              <input value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} autoFocus />
            </label>
            <div className="magnific-modal-actions">
              <button type="button" className="magnific-secondary-button" onClick={() => setNewSpaceOpen(false)}>Cancel</button>
              <button type="button" className="magnific-primary-button" onClick={() => void handleCreateSpace()}>
                <Check size={15} />
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameTarget ? (
        <div className="magnific-modal-backdrop">
          <div className="magnific-modal-card">
            <div className="magnific-modal-card__header">
              <div>
                <h3>Rename space</h3>
                <p>Update the title shown in your space grid.</p>
              </div>
              <button type="button" className="magnific-modal-close" onClick={() => setRenameTarget(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <label className="magnific-modal-field">
              <span>Space name</span>
              <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} autoFocus />
            </label>
            <div className="magnific-modal-actions">
              <button type="button" className="magnific-secondary-button" onClick={() => setRenameTarget(null)}>Cancel</button>
              <button type="button" className="magnific-primary-button" onClick={() => void handleRenameBoard()}>
                <Check size={15} />
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {coverTarget !== null ? (
        <div className="magnific-modal-backdrop">
          <div className="magnific-modal-card">
            <div className="magnific-modal-card__header">
              <div>
                <h3>Change cover</h3>
                <p>Upload a new image or reuse the latest canvas snapshot.</p>
              </div>
              <button type="button" className="magnific-modal-close" onClick={() => setCoverTarget(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="magnific-cover-actions">
              <button type="button" className="magnific-secondary-button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={15} />
                Upload image
              </button>
              <button
                type="button"
                className="magnific-secondary-button"
                onClick={() => {
                  onUseSnapshotCover(coverTarget);
                  setCoverTarget(null);
                }}
                disabled={!thumbnails[coverTarget]}
              >
                <Sparkles size={15} />
                Use canvas snapshot
              </button>
              <button
                type="button"
                className="magnific-secondary-button"
                onClick={() => {
                  onClearCustomCover(coverTarget);
                  setCoverTarget(null);
                }}
              >
                <Trash2 size={15} />
                Reset cover
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <input ref={fileInputRef} hidden type="file" accept="image/*" onChange={handleCoverFileChange} />
    </div>
  );
}

function CanvasStatusBar({
  showMiniMap,
  onToggleMiniMap,
}: {
  showMiniMap: boolean;
  onToggleMiniMap: () => void;
}) {
  const { zoom } = useViewport();
  const { zoomTo } = useReactFlow();

  return (
    <div className="magnific-canvas__status nowheel nodrag">
      <button type="button" className="magnific-page-pill">Page 1</button>
      <div className="magnific-canvas__status-actions">
        <button type="button" className="magnific-feedback-link">
          <CircleHelp size={14} />
          Give feedback
        </button>
        <button
          type="button"
          className={`magnific-icon-button ${showMiniMap ? "is-active" : ""}`}
          onClick={onToggleMiniMap}
          aria-label="Toggle navigator"
        >
          <MapIcon size={15} />
        </button>
        <label className="magnific-zoom-select">
          <select
            value={String(Math.round(zoom * 100))}
            onChange={(e) => void zoomTo(Number(e.target.value) / 100, { duration: 180 })}
          >
            {[50, 75, 100, 125, 150].map((value) => (
              <option key={value} value={value}>
                {value}%
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </label>
      </div>
    </div>
  );
}

function CanvasWorkspace() {
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const [showMiniMap, setShowMiniMap] = useState(false);

  return (
    <div className="magnific-canvas__workspace">
      {loading && boardId === null ? (
        <div className="magnific-empty-state">Loading canvas...</div>
      ) : (
        <>
          <Board showMiniMap={showMiniMap} showControls={false} />
          <AddNodePalette />
          <CanvasStatusBar
            showMiniMap={showMiniMap}
            onToggleMiniMap={() => setShowMiniMap((v) => !v)}
          />
        </>
      )}
    </div>
  );
}

function CanvasPage({ session }: { session: any }) {
  const boardName = useBoardStore((s) => s.boardName);
  const setView = useBoardStore((s) => s.setView);
  const setShowAuthModal = useBoardStore((s) => s.setShowAuthModal);
  const setGenerationState = useGenerationStore.setState;
  const isGuest = !session;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const me = await getAuthMe();
      if (!alive) return;
      const resolvedTier = resolveAuthTier(me);
      if (resolvedTier) {
        setGenerationState({ paygateTier: resolvedTier });
        return;
      }
      setGenerationState({ paygateTier: null });
      timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [setGenerationState]);

  return (
    <div className="magnific-shell magnific-canvas">
      <header className="magnific-canvas__header">
        <div className="magnific-canvas__breadcrumbs">
          <button type="button" className="magnific-back-button" onClick={() => setView("spaces")} aria-label="Back to spaces">
            <ArrowLeft size={16} />
          </button>
          <span className="magnific-breadcrumb-pill">
            <span className="magnific-filter-pill__dot" />
            Personal project
          </span>
          <span className="magnific-breadcrumb-sep">/</span>
          <strong>{boardName || "Untitled space"}</strong>
        </div>
        <div className="magnific-header-actions">
          {isGuest && (
            <button
              type="button"
              className="magnific-primary-button bg-accent hover:bg-accent/90 animate-pulse flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white shadow-lg shadow-accent/20 transition-all cursor-pointer mr-2"
              onClick={() => setShowAuthModal(true)}
            >
              <Sparkles size={14} />
              Save to Cloud
            </button>
          )}
          <button type="button" className="magnific-share-button">
            <Share2 size={15} />
            Share
          </button>
          <button type="button" className="magnific-pricing-link">Pricing</button>
          <button type="button" className="magnific-avatar" aria-label="Profile">
            <UserCircle2 size={19} />
          </button>
        </div>
      </header>

      <div className="magnific-canvas__stage">
        <ReactFlowProvider>
          <CanvasWorkspace />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loadReferences = useReferencesStore((s) => s.load);
  const currentView = useBoardStore((s) => s.currentView);
  const boardId = useBoardStore((s) => s.boardId);
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const showAuthModal = useBoardStore((s) => s.showAuthModal);
  const setShowAuthModal = useBoardStore((s) => s.setShowAuthModal);
  const showExtensionModal = useBoardStore((s) => s.showExtensionModal);
  const setShowExtensionModal = useBoardStore((s) => s.setShowExtensionModal);

  const loadedForRef = useRef<string | null>(null);
  const [session, setSession] = useState<any>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [showMigrationPrompt, setShowMigrationPrompt] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const [spaceSnapshots, setSpaceSnapshots] = useState<Record<number, string>>(() => {
    try {
      const raw = localStorage.getItem(SPACE_SNAPSHOTS_KEY);
      return raw ? (JSON.parse(raw) as Record<number, string>) : {};
    } catch {
      return {};
    }
  });
  const [spaceCoverOverrides, setSpaceCoverOverrides] = useState<Record<number, string>>(() => {
    try {
      const raw = localStorage.getItem(SPACE_COVERS_KEY);
      return raw ? (JSON.parse(raw) as Record<number, string>) : {};
    } catch {
      return {};
    }
  });

  const spaceThumbnails = useMemo(() => ({ ...spaceSnapshots, ...spaceCoverOverrides }), [spaceSnapshots, spaceCoverOverrides]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session && !localStorage.getItem("flowboard.migration_dismissed")) {
      const localBoards = localDb.getGuestBoards();
      if (localBoards.length > 0) {
        setShowMigrationPrompt(true);
      }
    } else {
      setShowMigrationPrompt(false);
    }
  }, [session]);

  useEffect(() => {
    if (!authReady) return;
    const loadKey = session?.user?.id ? `user:${session.user.id}` : "guest";
    if (loadedForRef.current === loadKey) return;
    loadedForRef.current = loadKey;
    void loadInitialBoard();
    void loadReferences();
  }, [authReady, session?.user?.id, loadInitialBoard, loadReferences]);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", handleContextMenu);

    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if ((isCtrlOrMeta && (key === "f" || key === "g")) || e.key === "F3") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const handleHistoryKeys = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (!isCtrlOrMeta) return;
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key !== "z") return;
      e.preventDefault();
      if (e.shiftKey) {
        void redo();
      } else {
        void undo();
      }
    };
    document.addEventListener("keydown", handleHistoryKeys);
    return () => document.removeEventListener("keydown", handleHistoryKeys);
  }, [undo, redo]);

  useEffect(() => {
    if (currentView !== "canvas" || boardId === null) return;
    const timer = window.setTimeout(() => {
      const thumbnail = createBoardThumbnail(nodes, edges);
      if (!thumbnail) return;
      setSpaceSnapshots((prev) => {
        const next = { ...prev, [boardId]: thumbnail };
        try {
          localStorage.setItem(SPACE_SNAPSHOTS_KEY, JSON.stringify(next));
        } catch {
          // Ignore quota failures and keep in-memory state only.
        }
        return next;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [currentView, boardId, nodes, edges]);

  async function handleUploadCover(boardIdToUpdate: number, file: File) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read cover image"));
      reader.readAsDataURL(file);
    });
    setSpaceCoverOverrides((prev) => {
      const next = { ...prev, [boardIdToUpdate]: dataUrl };
      localStorage.setItem(SPACE_COVERS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function handleUseSnapshotCover(boardIdToUpdate: number, sourceBoardId?: number) {
    const snapshot = spaceSnapshots[sourceBoardId ?? boardIdToUpdate];
    if (!snapshot) return;
    setSpaceCoverOverrides((prev) => {
      const next = { ...prev, [boardIdToUpdate]: snapshot };
      localStorage.setItem(SPACE_COVERS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function handleClearCustomCover(boardIdToUpdate: number) {
    setSpaceCoverOverrides((prev) => {
      const next = { ...prev };
      delete next[boardIdToUpdate];
      localStorage.setItem(SPACE_COVERS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function migrateGuestDraftsToCloud() {
    setIsMigrating(true);
    setMigrationError(null);
    try {
      const localBoards = localDb.getGuestBoards();
      for (const localBoard of localBoards) {
        const localDetail = localDb.mockGetBoard(localBoard.id);
        const cloudBoard = await createBoard(localBoard.name || "Migrated Draft");
        
        // Map localNodeId -> remoteNodeId (we need this to hook up parent_id and edges!)
        const nodeMap = new Map<number, number>();
        
        // Sort nodes parent first
        const localNodes = localDetail.nodes;
        const roots = localNodes.filter(n => !n.parent_id);
        const children = localNodes.filter(n => !!n.parent_id);
        const sortedNodes = [...roots, ...children];
        
        for (const n of sortedNodes) {
          const payload = {
            board_id: cloudBoard.id,
            type: n.type,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            data: n.data,
            parent_id: n.parent_id ? nodeMap.get(n.parent_id) : null
          };
          const createdNode = await createNode(payload);
          nodeMap.set(n.id, createdNode.id);
          
          if (n.status && n.status !== "idle") {
            await patchNode(createdNode.id, { status: n.status });
          }
        }
        
        // Replicate edges
        for (const e of localDetail.edges) {
          const remoteSourceId = nodeMap.get(e.source_id);
          const remoteTargetId = nodeMap.get(e.target_id);
          if (!remoteSourceId || !remoteTargetId) continue;
          
          await createEdge({
            board_id: cloudBoard.id,
            source_id: remoteSourceId,
            target_id: remoteTargetId,
            source_handle: e.source_handle,
            target_handle: e.target_handle,
            source_variant_idx: e.source_variant_idx
          });
        }
      }
      
      // Clear local storage guest drafts
      localStorage.removeItem("flowboard.guest.boards.v2");
      for (const localBoard of localBoards) {
        localStorage.removeItem(`flowboard.guest.nodes.v2.${localBoard.id}`);
        localStorage.removeItem(`flowboard.guest.edges.v2.${localBoard.id}`);
      }
      
      // Refresh board list
      await useBoardStore.getState().refreshBoardList();
      
      // Load first board or spaces
      const boards = useBoardStore.getState().boards;
      if (boards.length > 0) {
        await useBoardStore.getState().switchBoard(boards[0].id);
      } else {
        useBoardStore.getState().setView("spaces");
      }
      
      setShowMigrationPrompt(false);
    } catch (err: any) {
      setMigrationError(err?.message || "Migration failed");
    } finally {
      setIsMigrating(false);
    }
  }

  function handleKeepLocal() {
    localStorage.setItem("flowboard.migration_dismissed", "true");
    setShowMigrationPrompt(false);
  }

  return (
    <>
      {currentView === "spaces" ? (
        <SpacesPage
          thumbnails={spaceThumbnails}
          onUploadCover={handleUploadCover}
          onUseSnapshotCover={handleUseSnapshotCover}
          onClearCustomCover={handleClearCustomCover}
          session={session}
        />
      ) : (
        <CanvasPage session={session} />
      )}
      <Toaster />
      <GenerationDialog />
      <ResultViewerV2 />
      <ForcedSetupGate />
      
      <AuthGateModal 
        isOpen={showAuthModal} 
        onClose={() => setShowAuthModal(false)} 
        onSuccess={() => {
          // Reload boards on success
          useBoardStore.getState().refreshBoardList();
        }}
      />
      <ExtensionGateModal 
        isOpen={showExtensionModal} 
        onClose={() => setShowExtensionModal(false)} 
      />

      {showMigrationPrompt && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16161a] p-8 shadow-2xl transition-all duration-300">
            <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
            <div className="relative mb-6">
              <h3 className="text-lg font-bold text-white">Save Draft to Cloud?</h3>
              <p className="text-sm text-white/50 mt-2">
                We detected local board drafts on your browser. Would you like to sync them to your secure cloud workspace so you can access them from any device?
              </p>
            </div>
            
            {migrationError && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                {migrationError}
              </div>
            )}
            
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white/70 hover:text-white border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] transition-all cursor-pointer"
                onClick={handleKeepLocal}
                disabled={isMigrating}
              >
                Keep local
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-accent hover:bg-accent/90 transition-all cursor-pointer flex items-center gap-1.5 shadow-lg shadow-accent/20"
                onClick={() => void migrateGuestDraftsToCloud()}
                disabled={isMigrating}
              >
                {isMigrating ? (
                  <>
                    <Loader2 className="animate-spin" size={13} />
                    Saving...
                  </>
                ) : (
                  <>
                    <Sparkles size={13} />
                    Save draft
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
