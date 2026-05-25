import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow, useViewport } from "@xyflow/react";
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  CircleHelp,
  FolderOpen,
  Globe,
  Grid2x2,
  Heart,
  Home,
  Layers3,
  LayoutGrid,
  List,
  Map,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Share2,
  Sparkles,
  UserCircle2,
  Video,
} from "lucide-react";

import { mediaUrl } from "./api/client";
import { Board } from "./canvas/Board";
import { AddNodePalette } from "./canvas/AddNodePalette";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewerV2 } from "./components/ResultViewerV2";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { useBoardStore, type FlowNode, type FlowboardEdgeData } from "./store/board";
import { useReferencesStore } from "./store/references";
import type { Edge } from "@xyflow/react";

type SpacesTab = "my" | "shared" | "templates";

const SPACE_PRESETS = [
  "radial-gradient(circle at 18% 22%, rgba(255,214,176,0.95) 0%, rgba(198,144,255,0.32) 28%, rgba(20,21,28,0) 56%), linear-gradient(135deg, #2d211e 0%, #101116 100%)",
  "radial-gradient(circle at 50% 35%, rgba(114,158,255,0.85) 0%, rgba(70,110,255,0.18) 40%, rgba(17,18,24,0) 68%), linear-gradient(135deg, #111521 0%, #1b2335 45%, #0c0d12 100%)",
  "linear-gradient(135deg, rgba(102,17,37,0.95) 0%, rgba(41,6,15,0.88) 38%, rgba(15,15,19,0.98) 100%)",
  "radial-gradient(circle at 70% 30%, rgba(93,140,255,0.42) 0%, rgba(18,27,49,0) 35%), linear-gradient(135deg, #17213a 0%, #090a0e 100%)",
  "linear-gradient(135deg, rgba(183,151,105,0.3) 0%, rgba(103,70,42,0.18) 28%, rgba(19,19,24,0.95) 100%)",
  "linear-gradient(135deg, rgba(44,44,44,0.95) 0%, rgba(19,19,24,0.95) 100%)",
];

const SPACE_ICONS = [
  Sparkles,
  Home,
  Search,
  Grid2x2,
  Globe,
  FolderOpen,
  Layers3,
  Video,
  Settings,
  Bell,
  CircleHelp,
];

const SPACE_THUMBNAILS_KEY = "flowboard.spaceThumbnails.v1";

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

function SpacesPage({ thumbnails }: { thumbnails: Record<number, string> }) {
  const boards = useBoardStore((s) => s.boards);
  const loading = useBoardStore((s) => s.loading);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const setView = useBoardStore((s) => s.setView);
  const selectProject = useBoardStore((s) => s.selectProject);
  const [tab, setTab] = useState<SpacesTab>("my");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");

  const visibleBoards = useMemo(() => {
    if (tab === "templates") return boards.slice(0, Math.max(boards.length, 6));
    return boards;
  }, [boards, tab]);

  async function handleNewSpace() {
    const id = await createNewBoard("Untitled space");
    if (id !== null) setView("canvas");
  }

  return (
    <div className="magnific-shell magnific-spaces">
      <aside className="magnific-rail">
        <div className="magnific-rail__top">
          <div className="magnific-logo">M</div>
          <button type="button" className="magnific-rail__cta" onClick={handleNewSpace} aria-label="New space">
            <Plus size={18} />
          </button>
          {SPACE_ICONS.map((Icon, index) => (
            <button key={index} type="button" className="magnific-rail__icon" aria-label={`Rail action ${index + 1}`}>
              <Icon size={16} />
            </button>
          ))}
        </div>
        <div className="magnific-rail__bottom">
          <button type="button" className="magnific-rail__icon" aria-label="Notifications">
            <Bell size={16} />
          </button>
          <button type="button" className="magnific-rail__icon" aria-label="More">
            <MoreHorizontal size={16} />
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
            <button type="button" className={tab === "shared" ? "is-active" : ""} onClick={() => setTab("shared")}>Shared</button>
            <button type="button" className={tab === "templates" ? "is-active" : ""} onClick={() => setTab("templates")}>Templates</button>
          </div>
          <div className="magnific-spaces__actions">
            <button type="button" className="magnific-primary-button" onClick={handleNewSpace}>
              <Plus size={16} />
              New space
            </button>
            <button type="button" className="magnific-icon-button" aria-label="Favorites">
              <Heart size={16} />
            </button>
            <button
              type="button"
              className="magnific-icon-button"
              aria-label="Grid view"
              onClick={() => setLayoutMode((m) => (m === "grid" ? "list" : "grid"))}
            >
              {layoutMode === "grid" ? <List size={16} /> : <LayoutGrid size={16} />}
            </button>
            <label className="magnific-search">
              <Search size={15} />
              <input type="text" placeholder="Search spaces" />
            </label>
          </div>
        </div>

        {loading && boards.length === 0 ? (
          <div className="magnific-empty-state">Loading spaces...</div>
        ) : (
          <div className={layoutMode === "grid" ? "magnific-space-grid" : "magnific-space-list"}>
            {visibleBoards.map((board, index) => (
              <button
                key={board.id}
                type="button"
                className="magnific-space-card"
                onClick={() => void selectProject(board.id)}
              >
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
              </button>
            ))}
          </div>
        )}
      </main>
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
          <Map size={15} />
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

function CanvasPage() {
  const boardName = useBoardStore((s) => s.boardName);
  const setView = useBoardStore((s) => s.setView);

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
  const ran = useRef(false);
  const [spaceThumbnails, setSpaceThumbnails] = useState<Record<number, string>>(() => {
    try {
      const raw = localStorage.getItem(SPACE_THUMBNAILS_KEY);
      return raw ? (JSON.parse(raw) as Record<number, string>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void loadInitialBoard();
    void loadReferences();
  }, [loadInitialBoard, loadReferences]);

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
      setSpaceThumbnails((prev) => {
        const next = { ...prev, [boardId]: thumbnail };
        try {
          localStorage.setItem(SPACE_THUMBNAILS_KEY, JSON.stringify(next));
        } catch {
          // Ignore quota failures and keep in-memory state only.
        }
        return next;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [currentView, boardId, nodes, edges]);

  return (
    <>
      {currentView === "spaces" ? <SpacesPage thumbnails={spaceThumbnails} /> : <CanvasPage />}
      <Toaster />
      <GenerationDialog />
      <ResultViewerV2 />
      <ForcedSetupGate />
    </>
  );
}
