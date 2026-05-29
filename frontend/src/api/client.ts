import { invoke } from "@tauri-apps/api/core";
import { supabase, cloudApiBaseUrl } from "../cloud/supabase";
import * as localDb from "./localStorageDb";

// --- stateless/deterministic 48-bit UUID-to-Numeric ID Mapping Adapter ---
const numericToUuidMap = new Map<number, string>();
const ID_MAP_KEY = "flowboard.cloud.idMap.v1";

function loadPersistedIdMap(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(ID_MAP_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function persistIdMapping(num: number, uuid: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const current = loadPersistedIdMap();
    current[String(num)] = uuid;
    localStorage.setItem(ID_MAP_KEY, JSON.stringify(current));
  } catch {
    // Non-fatal: in-memory mapping still works for the current session.
  }
}

export function registerIdMapping(num: number, uuid: string): void {
  numericToUuidMap.set(num, uuid);
  persistIdMapping(num, uuid);
}

export function getUuidFromNumericId(num: number): string | undefined {
  return numericToUuidMap.get(num) ?? loadPersistedIdMap()[String(num)];
}

export function uuidToNumericId(uuid: string): number {
  if (!uuid) return 0;
  // Deterministic 48-bit hash of UUID that fits inside Number.MAX_SAFE_INTEGER
  const clean = uuid.replace(/-/g, "");
  return parseInt(clean.slice(0, 12), 16);
}

export function resolveToUuid(id: string | number): string {
  if (typeof id === "string") {
    if (id.includes("-")) return id;
    const num = parseInt(id, 10);
    if (!isNaN(num)) {
      return getUuidFromNumericId(num) ?? id;
    }
    return id;
  }
  return getUuidFromNumericId(id) ?? String(id);
}

function mapBoardId(uuid: string): number {
  const num = uuidToNumericId(uuid);
  registerIdMapping(num, uuid);
  return num;
}

function mapBoardFromServer(b: any): Board {
  return {
    id: mapBoardId(b.id),
    name: b.name,
    created_at: b.created_at,
  };
}

function mapNodeFromServer(n: any): NodeDTO {
  const mappedId = uuidToNumericId(n.id);
  registerIdMapping(mappedId, n.id);
  const data = n.data && typeof n.data === "object" ? n.data : {};
  return {
    id: mappedId,
    board_id: uuidToNumericId(n.board_id),
    short_id: n.short_id ?? data.shortId ?? `n${String(mappedId).slice(-4)}`,
    type: n.type,
    x: n.position_x ?? n.x ?? 0,
    y: n.position_y ?? n.y ?? 0,
    w: n.w ?? data.w ?? 240,
    h: n.h ?? data.h ?? 160,
    data,
    status: n.status ?? data.status ?? "idle",
    created_at: n.created_at,
    parent_id: n.parent_id ? uuidToNumericId(n.parent_id) : (data.parent_id ? uuidToNumericId(data.parent_id) : null),
  };
}

function mapEdgeFromServer(e: any): EdgeDTO {
  const mappedId = uuidToNumericId(e.id);
  registerIdMapping(mappedId, e.id);
  return {
    id: mappedId,
    board_id: uuidToNumericId(e.board_id),
    source_id: uuidToNumericId(e.source_node_id ?? e.source_id),
    target_id: uuidToNumericId(e.target_node_id ?? e.target_id),
    kind: e.kind ?? "default",
    source_handle: e.source_handle ?? null,
    target_handle: e.target_handle ?? null,
    source_variant_idx: e.source_variant_idx ?? e.data?.source_variant_idx ?? null,
  };
}

function mapRequestFromServer(r: any): RequestDTO {
  const mappedId = uuidToNumericId(r.id);
  registerIdMapping(mappedId, r.id);
  const rawStatus = r.status;
  const status = rawStatus === "completed" ? "done" : rawStatus;
  const result = r.result ?? r.output_result ?? {};
  return {
    id: mappedId,
    node_id: r.node_id ? uuidToNumericId(r.node_id) : null,
    type: r.type ?? r.task_type ?? "gen_image",
    params: r.params ?? r.input_data ?? {},
    status,
    result,
    error: r.error ?? r.error_message ?? null,
    created_at: r.created_at,
    finished_at: r.finished_at ?? r.completed_at ?? null,
  };
}

export function getBaseUrl(): string {
  const isTauri = typeof window !== "undefined" && 
    (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);
  return isTauri ? "http://127.0.0.1:8101" : "";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isTauri = typeof window !== "undefined" && 
    (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);

  if (isTauri) {
    if (
      path.startsWith("/api/upload") ||
      path.startsWith("/api/upload-url") ||
      path.startsWith("/api/media/") ||
      path.startsWith("/media/")
    ) {
      const url = `${getBaseUrl()}${path}`;
      const res = await fetch(url, init);
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      return res.json() as Promise<T>;
    }

    const method = init?.method || "GET";
    let body: any = {};
    if (init?.body) {
      try {
        if (typeof init.body === "string") {
          body = JSON.parse(init.body);
        }
      } catch (e) {}
    }

    if (path === "/api/boards") {
      if (method === "GET") {
        return invoke<T>("list_boards");
      } else if (method === "POST") {
        return invoke<T>("create_board", { name: body.name });
      }
    }

    if (path.startsWith("/api/boards/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);

      if (parts[4] === "project") {
        if (method === "GET") {
          return invoke<T>("get_board_project", { boardId: id });
        } else if (method === "POST") {
          return invoke<T>("ensure_board_project", { boardId: id });
        }
      } else if (parts.length === 4) {
        if (method === "GET") {
          return invoke<T>("get_board", { id });
        } else if (method === "PATCH") {
          return invoke<T>("patch_board", { id, name: body.name });
        } else if (method === "DELETE") {
          return invoke<T>("delete_board", { id });
        }
      }
    }

    if (path === "/api/nodes") {
      if (method === "POST") {
        return invoke<T>("create_node", { input: body });
      }
    }

    if (path === "/api/nodes/group") {
      if (method === "POST") {
        return invoke<T>("group_nodes", { input: body });
      }
    }

    if (path.startsWith("/api/nodes/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      if (parts[4] === "ungroup") {
        return invoke<T>("ungroup_nodes", { groupId: id });
      } else if (parts.length === 4) {
        if (method === "PATCH") {
          return invoke<T>("patch_node", { id, patch: body });
        } else if (method === "DELETE") {
          return invoke<T>("delete_node", { id });
        }
      }
    }

    if (path === "/api/edges") {
      if (method === "POST") {
        return invoke<T>("create_edge", { input: body });
      }
    }

    if (path.startsWith("/api/edges/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      if (method === "PATCH") {
        return invoke<T>("patch_edge", { id, sourceVariantIdx: body.source_variant_idx });
      } else if (method === "DELETE") {
        return invoke<T>("delete_edge", { id });
      }
    }

    if (path === "/api/auth/me") {
      return invoke<T>("get_auth_me");
    }
    if (path === "/api/auth/logout") {
      return invoke<T>("logout_extension");
    }
    if (path === "/api/auth/scan") {
      return invoke<T>("scan_extension");
    }

    if (path === "/api/requests") {
      if (method === "POST") {
        return invoke<T>("create_request", { input: body });
      }
    }
    if (path.startsWith("/api/requests/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      if (method === "GET") {
        return invoke<T>("get_request", { id });
      }
    }

    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    return res.json() as Promise<T>;

  } else {
    const session = supabase ? (await supabase.auth.getSession()).data.session : null;
    const isLoggedIn = !!session;

    const method = init?.method || "GET";
    let body: any = {};
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {}
    }

    if (!isLoggedIn) {
      if (path === "/api/boards") {
        if (method === "GET") {
          return localDb.mockListBoards() as unknown as T;
        } else if (method === "POST") {
          return localDb.mockCreateBoard(body.name) as unknown as T;
        }
      }
      if (path.startsWith("/api/boards/")) {
        const parts = path.split("/");
        const id = parseInt(parts[3], 10);
        if (parts.length === 4) {
          if (method === "GET") {
            return localDb.mockGetBoard(id) as unknown as T;
          } else if (method === "PATCH") {
            return localDb.mockPatchBoard(id, body.name) as unknown as T;
          } else if (method === "DELETE") {
            return localDb.mockDeleteBoard(id) as unknown as T;
          }
        }
      }

      if (path === "/api/nodes") {
        if (method === "POST") {
          return localDb.mockCreateNode(body) as unknown as T;
        }
      }
      if (path === "/api/nodes/group") {
        if (method === "POST") {
          return localDb.mockGroupNodes(body) as unknown as T;
        }
      }
      if (path.startsWith("/api/nodes/")) {
        const parts = path.split("/");
        const id = parseInt(parts[3], 10);
        if (parts[4] === "ungroup") {
          return localDb.mockUngroupNodes(id) as unknown as T;
        } else if (parts.length === 4) {
          if (method === "PATCH") {
            return localDb.mockPatchNode(id, body) as unknown as T;
          } else if (method === "DELETE") {
            return localDb.mockDeleteNode(id) as unknown as T;
          }
        }
      }

      if (path === "/api/edges") {
        if (method === "POST") {
          return localDb.mockCreateEdge(body) as unknown as T;
        }
      }
      if (path.startsWith("/api/edges/")) {
        const parts = path.split("/");
        const id = parseInt(parts[3], 10);
        if (parts.length === 4) {
          if (method === "DELETE") {
            return localDb.mockDeleteEdge(id) as unknown as T;
          }
        }
      }

      if (path === "/api/auth/me") {
        return { email: null, name: null, picture: null, verified_email: null, paygate_tier: null, sku: null, credits: null } as unknown as T;
      }
      if (path === "/api/auth/scan") {
        return { extension_connected: false, has_user_info: false, has_paygate_tier: false, userinfo_nudged: false, tier_fetched: false } as unknown as T;
      }

      throw new Error(`Endpoint ${path} not supported in Guest Mode`);
    }

    const token = session.access_token;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(init?.headers as Record<string, string> ?? {}),
    };

    if (path === "/api/auth/me") {
      const user = session.user;
      return {
        email: user.email ?? null,
        name: (user.user_metadata?.name as string | undefined) ?? null,
        picture: (user.user_metadata?.avatar_url as string | undefined) ?? null,
        verified_email: user.email_confirmed_at ? true : null,
        paygate_tier: null,
        sku: null,
        credits: null,
      } as unknown as T;
    }

    if (path === "/api/auth/scan") {
      return {
        extension_connected: false,
        has_user_info: Boolean(session.user.email),
        has_paygate_tier: false,
        userinfo_nudged: false,
        tier_fetched: false,
      } as unknown as T;
    }

    let mappedPath = path;
    let mappedInit: RequestInit = { ...init, headers };

    if (path === "/api/boards") {
    } else if (path.startsWith("/api/boards/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      const uuid = resolveToUuid(id);
      if (parts[4] === "project") {
        mappedPath = `/api/boards/${uuid}/project`;
      }
      if (parts.length === 4) {
        mappedPath = `/api/boards/${uuid}`;
      }
    }

    if (path === "/api/nodes") {
      if (method === "POST") {
        const payload = {
          board_id: resolveToUuid(body.board_id),
          type: body.type,
          position_x: body.x,
          position_y: body.y,
          w: body.w,
          h: body.h,
          data: body.data,
          parent_id: body.parent_id ? resolveToUuid(body.parent_id) : null,
        };
        mappedInit = { ...mappedInit, body: JSON.stringify(payload) };
      }
    } else if (path === "/api/nodes/group") {
      if (method === "POST") {
        const payload = {
          board_id: resolveToUuid(body.board_id),
          child_ids: body.child_ids.map(resolveToUuid),
          child_positions: Array.isArray(body.child_positions)
            ? body.child_positions.map((p: { id: number; x: number; y: number }) => ({
                id: resolveToUuid(p.id),
                x: p.x,
                y: p.y,
              }))
            : undefined,
          title: body.title,
          color: body.color,
          locked: body.locked,
          x: body.x,
          y: body.y,
          w: body.w,
          h: body.h,
        };
        mappedInit = { ...mappedInit, body: JSON.stringify(payload) };
      }
    } else if (path.startsWith("/api/nodes/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      const uuid = resolveToUuid(id);
      if (parts[4] === "ungroup") {
        mappedPath = `/api/nodes/${uuid}/ungroup`;
      } else if (parts.length === 4) {
        mappedPath = `/api/nodes/${uuid}`;
        if (method === "PATCH") {
          const payload: any = {};
          if (body.x !== undefined) payload.position_x = body.x;
          if (body.y !== undefined) payload.position_y = body.y;
          if (body.w !== undefined) payload.w = body.w;
          if (body.h !== undefined) payload.h = body.h;
          if (body.status !== undefined) payload.status = body.status;
          if (body.parent_id !== undefined) payload.parent_id = body.parent_id ? resolveToUuid(body.parent_id) : null;
          if (body.data !== undefined) payload.data = body.data;
          mappedInit = { ...mappedInit, body: JSON.stringify(payload) };
        }
      }
    }

    if (path === "/api/edges") {
      if (method === "POST") {
        const payload = {
          board_id: resolveToUuid(body.board_id),
          source_node_id: resolveToUuid(body.source_id),
          target_node_id: resolveToUuid(body.target_id),
          source_handle: body.source_handle ?? "source",
          target_handle: body.target_handle ?? null,
          source_variant_idx: body.source_variant_idx ?? null,
        };
        mappedInit = { ...mappedInit, body: JSON.stringify(payload) };
      }
    } else if (path.startsWith("/api/edges/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      const uuid = resolveToUuid(id);
      if (parts.length === 4) {
        mappedPath = `/api/edges/${uuid}`;
        if (method === "PATCH") {
          mappedInit = { ...mappedInit, body: JSON.stringify({ source_variant_idx: body.source_variant_idx ?? null }) };
        }
      }
    }

    if (path === "/api/requests") {
      if (method === "POST") {
        let boardUuid = "";
        let boardName = "";
        try {
          const boardState = (await import("../store/board")).useBoardStore.getState();
          if (boardState.boardId) boardUuid = resolveToUuid(boardState.boardId);
          boardName = boardState.boardName || "";
        } catch {}
        const nodeId = body.node_id ? resolveToUuid(body.node_id) : null;
        const expectedOutput = body.type.includes("video") ? "video" : "image";
        const taskType = body.type === "gen_video_omni"
          ? "txt2vid_omni"
          : body.type === "gen_video"
            ? "img2vid"
            : body.type === "edit_image" || body.type === "gen_variant" || body.type === "gen_part"
              ? "edit_image"
              : "txt2img";
        const payload = {
          board_id: boardUuid,
          node_id: nodeId,
          provider: "flow",
          task_type: taskType,
          expected_output: expectedOutput,
          status: "queued",
          input_data: {
            prompt: body.params.prompt,
            project_id: body.params.project_id ?? body.params.projectId,
            aspect_ratio: body.params.aspect_ratio ?? body.params.aspectRatio,
            variant_count: body.params.variant_count ?? body.params.variantCount,
            image_model: body.params.image_model ?? body.params.imageModel,
            ref_media_ids: body.params.ref_media_ids ?? body.params.sourceMediaIds,
            source_media_ids: body.params.source_media_ids ?? body.params.sourceMediaIds,
            start_media_ids: body.params.start_media_ids ?? body.params.sourceMediaIds,
            prompts: body.params.prompts,
            start_media_id: body.params.start_media_id,
            source_media_id: body.params.source_media_id ?? body.params.sourceMediaId,
            duration_s: body.params.duration_s,
            video_quality: body.params.video_quality ?? body.params.videoQuality,
            project_title: boardName,
          },
        };
        mappedInit = { ...mappedInit, body: JSON.stringify(payload) };
      }
    } else if (path.startsWith("/api/requests/")) {
      const parts = path.split("/");
      const id = parseInt(parts[3], 10);
      const uuid = resolveToUuid(id);
      if (parts.length === 4) {
        mappedPath = `/api/requests/${uuid}`;
      }
    }

    const res = await fetch(`${cloudApiBaseUrl}${mappedPath}`, mappedInit);
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    const rawData = await res.json();

    if (path === "/api/boards") {
      if (method === "GET") {
        return (rawData as any[]).map(mapBoardFromServer) as unknown as T;
      } else if (method === "POST") {
        return mapBoardFromServer(rawData) as unknown as T;
      }
    }
    if (path.startsWith("/api/boards/")) {
      const parts = path.split("/");
      if (parts.length === 4) {
        if (method === "GET") {
          return {
            board: mapBoardFromServer(rawData.board),
            nodes: (rawData.nodes as any[]).map(mapNodeFromServer),
            edges: (rawData.edges as any[]).map(mapEdgeFromServer),
          } as unknown as T;
        } else if (method === "PATCH") {
          return mapBoardFromServer(rawData) as unknown as T;
        }
      }
    }
    if (path === "/api/nodes") {
      if (method === "POST") {
        return mapNodeFromServer(rawData) as unknown as T;
      }
    }
    if (path === "/api/nodes/group") {
      if (method === "POST") {
        return {
          group: mapNodeFromServer(rawData.group),
          children: (rawData.children as any[]).map(mapNodeFromServer),
        } as unknown as T;
      }
    }
    if (path.startsWith("/api/nodes/")) {
      const parts = path.split("/");
      if (parts[4] === "ungroup") {
        return {
          deleted_group_id: uuidToNumericId(rawData.deleted_group_id),
          children: (rawData.children as any[]).map(mapNodeFromServer),
        } as unknown as T;
      } else if (parts.length === 4) {
        if (method === "PATCH") {
          return mapNodeFromServer(rawData) as unknown as T;
        } else if (method === "DELETE") {
          return {
            ok: true,
            deleted_edges: rawData.deleted_edges ? rawData.deleted_edges.map(uuidToNumericId) : [],
            deleted_child_ids: rawData.deleted_child_ids ? rawData.deleted_child_ids.map(uuidToNumericId) : [],
          } as unknown as T;
        }
      }
    }
    if (path === "/api/edges") {
      if (method === "POST") {
        return mapEdgeFromServer(rawData) as unknown as T;
      }
    }
    if (path.startsWith("/api/edges/")) {
      const parts = path.split("/");
      if (parts.length === 4) {
        if (method === "PATCH") {
          return mapEdgeFromServer(rawData) as unknown as T;
        }
        if (method === "DELETE") {
          return { ok: true } as unknown as T;
        }
      }
    }
    if (path === "/api/requests") {
      if (method === "POST") {
        return mapRequestFromServer(rawData) as unknown as T;
      }
    }
    if (path.startsWith("/api/requests/")) {
      const parts = path.split("/");
      if (parts.length === 4) {
        if (method === "GET") {
          return mapRequestFromServer(rawData) as unknown as T;
        }
      }
    }

    return rawData as T;
  }
}

function humanizeBackendError(token: string): string | null {
  const t = token.toLowerCase();
  if (t === "paygate_tier_unknown") {
    return (
      "Flowboard doesn't know your Google Flow plan tier yet — the "
      + "extension hasn't seen a Flow request that exposes it. Open "
      + "https://labs.google/fx/tools/flow in a tab and reload it once, "
      + "then retry. Flowboard refuses to dispatch in this state to "
      + "avoid silently serving Ultra users at the Pro checkpoint."
    );
  }
  if (t === "no_media_id_in_upload_response") {
    return (
      "Google Flow accepted the upload but didn't return a media handle — "
      + "this usually means the image was silently rejected by Flow's "
      + "content filter (logos, watermarks, copyrighted brand imagery). "
      + "Try a different image or download it locally and upload as a file. "
      + "Check the agent terminal for the full Flow response."
    );
  }
  if (t.includes("captcha_failed: no current window")) {
    return (
      "Chrome has no open windows for the extension to attach a Flow tab to. "
      + "Open any Chrome window (or click the extension's '⋯ → Open Flow') "
      + "and retry — Flowboard will reuse the existing window automatically."
    );
  }
  if (t.startsWith("captcha_failed:")) {
    // CAPTCHA failures are rarely the user's fault — surface the underlying
    // reason verbatim but keep the prefix so power-users can grep for it.
    return token;
  }
  if (t.startsWith("public_error_")) {
    // Veo / Imagen content filters are returned verbatim by Flow — these
    // are already self-describing, just prettify the prefix.
    return token.replace(/^PUBLIC_ERROR_/i, "Flow rejected: ").replace(/_/g, " ");
  }
  return null;
}

async function extractErrorMessage(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    try {
      detail = await res.text();
    } catch {
      return `${res.status} ${res.statusText}`;
    }
  }
  const inner =
    typeof detail === "object" && detail !== null && "detail" in detail
      ? (detail as { detail: unknown }).detail
      : detail;
  if (typeof inner === "string" && inner) {
    return humanizeBackendError(inner) ?? inner;
  }
  if (inner && typeof inner === "object") {
    const obj = inner as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      return humanizeBackendError(obj.message) ?? obj.message;
    }
    try {
      return JSON.stringify(inner);
    } catch {
      // fall through
    }
  }
  return `${res.status} ${res.statusText}`;
}

export interface WsStats {
  connected: boolean;
  flow_key_present: boolean;
  token_age_s: number | null;
  pending: number;
  request_count: number;
  success_count: number;
  failed_count: number;
  last_error: string | null;
}

export interface HealthResponse {
  ok: boolean;
  extension_connected: boolean;
  ws_stats?: WsStats;
}

export function getHealth() {
  return api<HealthResponse>("/api/health");
}

// ── DTOs ────────────────────────────────────────────────────────────────────

export type NodeType =
  | "note"
  | "reference"
  | "variant"
  | "video"
  | "upload"
  | "text"
  | "add_reference"
  | "group"
  | "Storyboard"
  | "list";
export type NodeStatus = "idle" | "queued" | "running" | "done" | "error" | "partial";

export interface Board {
  id: number;
  name: string;
  created_at: string;
}

export interface NodeDTO {
  id: number;
  board_id: number;
  short_id: string;
  type: NodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Record<string, unknown>;
  status: NodeStatus;
  created_at: string;
  // Optional reference to a parent group node. When set, (x, y) are
  // interpreted RELATIVE to the parent's origin. null otherwise.
  parent_id: number | null;
}

export interface EdgeDTO {
  id: number;
  board_id: number;
  source_id: number;
  target_id: number;
  kind: string;
  source_handle: string | null;
  target_handle: string | null;
  // null when the upstream is single-variant (or the edge hasn't been
  // pinned yet — natural fallback to source.mediaId at dispatch time).
  // 0-based index into the source node's `data.mediaIds[]` when the
  // user has explicitly picked a variant.
  source_variant_idx: number | null;
}

export interface BoardDetail {
  board: Board;
  nodes: NodeDTO[];
  edges: EdgeDTO[];
}

// ── API methods ──────────────────────────────────────────────────────────────

export function listBoards(): Promise<Board[]> {
  return api<Board[]>("/api/boards");
}

export function createBoard(name: string): Promise<Board> {
  return api<Board>("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getBoard(id: number): Promise<BoardDetail> {
  return api<BoardDetail>(`/api/boards/${id}`);
}

export function patchBoard(id: number, name: string): Promise<Board> {
  return api<Board>(`/api/boards/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteBoard(id: number): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(`/api/boards/${id}`, { method: "DELETE" });
}

export function createNode(input: {
  board_id: number;
  type: NodeType;
  x: number;
  y: number;
  // Width / height override. Group containers persist their own
  // dimensions; regular nodes can leave these unset and the backend
  // applies its 240x160 default.
  w?: number;
  h?: number;
  data?: object;
  // Optional parent group id. Backend re-validates that the parent
  // exists and belongs to the same board.
  parent_id?: number | null;
}): Promise<NodeDTO> {
  return api<NodeDTO>("/api/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Shallow-merge patch for `node.data` — the backend (see
 * agent/flowboard/routes/nodes.py::update_node) merges this dict into
 * the existing JSON column instead of replacing it.
 *
 * Conventions:
 *   - Keys present in the patch override existing values.
 *   - Keys absent from the patch are PRESERVED (this is what the type
 *     guarantees over a wholesale replace).
 *   - A value of `null` is the explicit "delete this key" sentinel.
 *     Use it instead of `undefined` to clear fields like `aiBrief`
 *     after a regen — `undefined` gets dropped by JSON.stringify and
 *     would leave the stale value in place after the merge.
 *   - Merge depth is ONE LEVEL. Nested dict values are wholesale-
 *     replaced, not deep-merged. None of FlowboardNodeData's current
 *     fields nest, so this is a non-issue today; revisit if a future
 *     field stores objects.
 *
 * Pre-merge call sites that built the full `data` from scratch and
 * forgot a sibling field caused a real data-loss regression
 * (`aspectRatio` was wiped on every image gen by the auto-brief
 * patch). Sticking to deltas-only with this type as the contract
 * prevents that whole class of bug.
 */
export type DataPatch = Record<string, unknown>;

export function patchNode(
  id: number,
  patch: Partial<
    Pick<Omit<NodeDTO, "data">, "x" | "y" | "w" | "h" | "status" | "parent_id">
  > & { data?: DataPatch },
): Promise<NodeDTO> {
  return api<NodeDTO>(`/api/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNode(id: number): Promise<{ ok: true; deleted_edges: number[]; deleted_child_ids?: number[] }> {
  return api<{ ok: true; deleted_edges: number[]; deleted_child_ids?: number[] }>(`/api/nodes/${id}`, {
    method: "DELETE",
  });
}

// Node group helpers - shipped with the Node Group feature.
//
// `groupNodes` packages a selection of root-level nodes into a new
// frame node and returns the freshly persisted group + the rewritten
// children (their (x, y) come back relative to the group origin).
//
// `ungroupNodes` reverses the operation atomically: children are
// detached and their absolute coordinates restored before the group
// node is removed. Both operations are single round-trips so the
// canvas can never end up in a half-grouped state.

export interface GroupCreateInput {
  board_id: number;
  child_ids: number[];
  child_positions?: Array<{ id: number; x: number; y: number }>;
  title?: string;
  color?: string;
  locked?: boolean;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface GroupResponseDTO {
  group: NodeDTO;
  children: NodeDTO[];
}

export interface UngroupResponseDTO {
  deleted_group_id: number;
  children: NodeDTO[];
}

export function groupNodes(input: GroupCreateInput): Promise<GroupResponseDTO> {
  return api<GroupResponseDTO>("/api/nodes/group", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function ungroupNodes(groupId: number): Promise<UngroupResponseDTO> {
  return api<UngroupResponseDTO>(`/api/nodes/${groupId}/ungroup`, {
    method: "POST",
  });
}

export function createEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
  kind?: string;
  source_handle?: string | null;
  target_handle?: string | null;
  source_variant_idx?: number | null;
}): Promise<EdgeDTO> {
  return api<EdgeDTO>("/api/edges", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Update an edge's variant pin without recreating it. Pass
 * `source_variant_idx: null` explicitly to clear the pin (revert to
 * the source's active mediaId at dispatch time). Omit the field to
 * leave it untouched.
 */
export function patchEdge(
  id: number,
  patch: { source_variant_idx?: number | null },
): Promise<EdgeDTO> {
  return api<EdgeDTO>(`/api/edges/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteEdge(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/edges/${id}`, {
    method: "DELETE",
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessageDTO {
  id: number;
  board_id: number;
  role: ChatRole;
  content: string;
  mentions: string[];
  created_at: string;
}

export interface PlanDTO {
  id: number;
  board_id: number;
  spec: {
    nodes: Array<{ tmp_id?: string; type: string; params?: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; kind?: string }>;
    layout_hint?: string;
  };
  status: "draft" | "approved" | "running" | "done" | "failed";
  created_at: string;
}

export interface ChatSendResponse {
  user: ChatMessageDTO;
  assistant: ChatMessageDTO;
  plan?: PlanDTO;
  agentSessionId?: string;
  turnNumber?: number;
  chatProvider?: "omni";
}

export function listChatMessages(boardId: number) {
  return api<ChatMessageDTO[]>(`/api/boards/${boardId}/chat`);
}

export function sendChatMessage(
  boardId: number,
  message: string,
  mentions: string[],
  meta?: {
    agentSessionId?: string | null;
    turnNumber?: number | null;
  },
) {
  return api<ChatSendResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      board_id: boardId,
      message,
      mentions,
      agent_session_id: meta?.agentSessionId ?? null,
      turn_number: meta?.turnNumber ?? null,
    }),
  });
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface BoardProject {
  flow_project_id: string;
  created: boolean;
}

export interface RequestDTO {
  id: number;
  node_id: number | null;
  type: string;
  params: Record<string, unknown>;
  // 'canceled' = user cancelled the request from the activity bell.
  // 'timeout' = backend's 5-minute video-gen budget elapsed; the row
  // self-transitions out of running. Both are terminal states.
  status: "queued" | "running" | "done" | "failed" | "canceled" | "timeout";
  result: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function ensureBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`, { method: "POST" });
}

export function getBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`).catch(() => null);
}

// ── Auth / profile ───────────────────────────────────────────────────────

export interface AuthMe {
  // Each field is null until the extension resolves the Bearer token
  // against Google's userinfo endpoint and pushes the profile to agent.
  email: string | null;
  name: string | null;
  picture: string | null;
  verified_email: boolean | null;
  // Paygate tier — primary source is the agent's own /v1/credits fetch
  // triggered when the extension pushes a Bearer token. Falls back to
  // the legacy passive sniff (extension reading userPaygateTier out of
  // outgoing Flow request bodies) if the agent fetch fails.
  paygate_tier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  // Subscription SKU from /v1/credits — e.g. "WS_ULTRA" / "WS_PRO".
  // Available alongside paygate_tier; null until the credits fetch lands.
  sku: string | null;
  // Subscription credits remaining — bonus info from /v1/credits.
  // Frontend can display under the tier badge if desired.
  credits: number | null;
}

export function getAuthMe() {
  return api<AuthMe>("/api/auth/me").catch(() => null);
}

export interface AuthLogoutResult {
  ok: boolean;
  // Whether the agent could push a `logout` message to the extension
  // over its open WebSocket. False when no extension is connected —
  // agent-side caches were still cleared so the dashboard reflects
  // the logged-out state immediately.
  extension_notified: boolean;
}

export function logoutExtension() {
  return api<AuthLogoutResult>("/api/auth/logout", { method: "POST" });
}

export interface AuthScanResult {
  // True when the extension WebSocket is currently connected to the
  // agent. False means the user must install / enable / open Chrome.
  extension_connected: boolean;
  has_user_info: boolean;
  has_paygate_tier: boolean;
  // True when the agent had to ask the extension to re-fetch userinfo
  // (i.e. WS open but cache empty). Backend sets this only in that
  // narrow case; otherwise false.
  userinfo_nudged: boolean;
  // True when the agent successfully resolved tier from /v1/credits
  // during this scan call. False if the call failed (token expired,
  // network error, etc.) or if tier was already cached.
  tier_fetched: boolean;
}

export function scanExtension() {
  return api<AuthScanResult>("/api/auth/scan", { method: "POST" });
}

export function createRequest(body: {
  type: string;
  node_id?: number;
  params: Record<string, unknown>;
}) {
  return api<RequestDTO>("/api/requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getRequest(id: number) {
  return api<RequestDTO>(`/api/requests/${id}`);
}

// ── Plans + Pipeline runs ────────────────────────────────────────────────────

export interface PipelineRunDTO {
  id: number;
  plan_id: number;
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export function getPlan(planId: number) {
  return api<PlanDTO>(`/api/plans/${planId}`);
}

export function runPlan(planId: number) {
  return api<PipelineRunDTO>(`/api/plans/${planId}/run`, { method: "POST" });
}

export function getPipelineRun(runId: number) {
  return api<PipelineRunDTO>(`/api/pipeline-runs/${runId}`);
}

// ── Media ────────────────────────────────────────────────────────────────────

export interface MediaStatus {
  available: boolean;
  has_url: boolean;
  mime?: string;
  reason?: string;
}

export function getMediaStatus(mediaId: string): Promise<MediaStatus> {
  const clean = mediaId.replace(/^media\//, "");
  return api<MediaStatus>(`/api/media/${encodeURIComponent(clean)}/status`);
}

export function mediaUrl(mediaId: string): string {
  if (/^(https?:)?\/\//.test(mediaId) || mediaId.startsWith("data:")) return mediaId;
  const clean = mediaId.replace(/^media\//, "");
  return `${getBaseUrl()}/media/${encodeURIComponent(clean)}`;
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResponse {
  media_id: string;
  asset_id?: string;
  storage_key?: string;
  mime: string;
  size: number;
  // Detected by the agent from the image bytes; one of
  // IMAGE_ASPECT_RATIO_{SQUARE,PORTRAIT,LANDSCAPE}. Optional because legacy
  // responses (or formats we couldn't sniff) skip the field.
  aspect_ratio?: string;
  width?: number;
  height?: number;
}

export async function uploadImage(
  file: File,
  projectId: string,
  nodeId?: number,
): Promise<UploadResponse> {
  const isTauri = typeof window !== "undefined" &&
    (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);
  const form = new FormData();
  form.append("project_id", projectId);
  if (nodeId !== undefined) form.append("node_id", isTauri ? String(nodeId) : resolveToUuid(nodeId));
  form.append("file", file);

  if (!isTauri && supabase) {
    const session = (await supabase.auth.getSession()).data.session;
    if (session) {
      const res = await fetch(`${cloudApiBaseUrl}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      return res.json() as Promise<UploadResponse>;
    }
  }

  // Don't set Content-Type — the browser sets it with the correct boundary.
  const res = await fetch(`${getBaseUrl()}/api/upload`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}

export interface VisionDescribeResponse {
  media_id: string;
  description: string;
}

export interface AutoPromptResponse {
  node_id: number;
  prompt: string;
}

export interface AutoPromptBatchResponse {
  node_id: number;
  prompts: string[];
}

export async function autoPromptBatch(
  nodeId: number,
  count: number,
  opts?: { camera?: string },
): Promise<AutoPromptBatchResponse> {
  const res = await fetch("/api/prompt/auto-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, count, camera: opts?.camera }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptBatchResponse>;
}

export async function autoPrompt(
  nodeId: number,
  opts?: { camera?: string },
): Promise<AutoPromptResponse> {
  const res = await fetch("/api/prompt/auto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, camera: opts?.camera }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptResponse>;
}

// ── Variant metadata (Concepta) ───────────────────────
export interface VariantAxisDTO {
  key: string;
  label: string;
}

/** Surface the canonical Variant axis list from the backend. */
export async function getVariantAxes(): Promise<VariantAxisDTO[]> {
  const res = await fetch("/api/concepta/variant-axes");
  if (!res.ok) throw new Error(`getVariantAxes: ${res.status}`);
  return res.json() as Promise<VariantAxisDTO[]>;
}

export async function describeMedia(
  mediaId: string,
  refType?: string | null,
  forceMaterialMode?: boolean,
): Promise<VisionDescribeResponse> {
  const res = await fetch("/api/vision/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `ref_type` lets the backend pick the matching vision profile
    // (texture/material vs. lighting/mood vs. style). `force_material_mode`
    // is the hybrid demotion flag - set when this `add_reference`
    // is `photo` / `3d_render` AND its target also has a structural
    // ref upstream, so the brief must strip subject nouns just like
    // a real material ref.
    body: JSON.stringify({
      media_id: mediaId,
      ref_type: refType ?? null,
      force_material_mode: forceMaterialMode ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<VisionDescribeResponse>;
}

export async function uploadImageFromUrl(
  url: string,
  projectId: string,
  nodeId?: number,
): Promise<UploadResponse> {
  const res = await fetch(`${getBaseUrl()}/api/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId, node_id: nodeId }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}


// ── LLM provider Settings ─────────────────────────────────────────────────
// See .omc/plans/multi-llm-provider-legacy.md → UI Specification → Frontend ↔
// backend contract for the full shape.

export type LLMProviderName = "claude" | "gemini" | "openai" | "omni";
export type LLMFeature = "auto_prompt" | "vision" | "planner" | "chat";
export type LLMProviderMode = "cli" | "api" | "none";
export type LLMLastError =
  | "not_installed"
  | "not_authenticated"
  | "no_key"
  | "unreachable"
  | "unknown";

export interface LLMProviderInfo {
  name: LLMProviderName;
  supportsVision: boolean;
  available: boolean;
  configured: boolean;
  requiresKey: boolean;
  mode: LLMProviderMode;
  lastError?: LLMLastError;
  lastTest?: { ok: boolean; latencyMs?: number; error?: string };
}

export interface LLMConfig {
  // null when the user hasn't picked a provider for this feature yet.
  // Backend no longer fabricates a default; the forced-setup gate uses
  // `configured` (below) to keep the dialog open until the user chooses.
  auto_prompt: LLMProviderName | null;
  vision: LLMProviderName | null;
  planner: LLMProviderName | null;
  chat?: LLMProviderName | null;
  // True only when all 3 features are pinned at the same provider —
  // the single-provider UI invariant. Drives the forced-setup dialog.
  configured: boolean;
}

export async function getLlmProviders(): Promise<LLMProviderInfo[]> {
  // Backend returns snake-case keys mapped from Python — but the route
  // already emits camelCase for the public surface. Re-typed here so
  // the spread/destructure pattern in the UI components stays clean.
  const res = await fetch("/api/llm/providers");
  if (!res.ok) throw new Error(`getLlmProviders: ${res.status}`);
  return res.json() as Promise<LLMProviderInfo[]>;
}

export async function getLlmConfig(): Promise<LLMConfig> {
  const res = await fetch("/api/llm/config");
  if (!res.ok) throw new Error(`getLlmConfig: ${res.status}`);
  return res.json() as Promise<LLMConfig>;
}

export async function setLlmConfig(
  partial: Partial<LLMConfig>,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/llm/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export async function setLlmApiKey(
  name: LLMProviderName,
  apiKey: string | null,
): Promise<{ ok: boolean }> {
  // null clears the key. Backend chmods secrets.json to 0o600 after
  // every write; the key is never echoed back via getLlmProviders.
  const res = await fetch(`/api/llm/providers/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function testLlmProvider(
  name: LLMProviderName,
): Promise<LlmTestResult> {
  // Cost-bounded by the backend: 1-token ping, 15s deadline. Returns
  // ok:false (NOT a non-200 HTTP status) on any failure mode so the
  // UI can render the error inline without try/catch boilerplate.
  const res = await fetch(`/api/llm/providers/${name}/test`, { method: "POST" });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res.json();
}


// ── Activity feed ─────────────────────────────────────────────────────────
// Read-only surface over the Request table. Captures every backend op:
// gen_image / gen_video / edit_image (worker), auto_prompt /
// auto_prompt_batch / vision / planner (LLM layer via record_activity).

export type ActivityType =
  | "auto_prompt" | "auto_prompt_batch"
  | "vision" | "planner"
  | "gen_image" | "gen_video" | "gen_video_omni" | "edit_image"
  | "upload"
  | "text" | "upload_url";
export type ActivityStatus = "queued" | "running" | "done" | "failed";

export interface ActivityListItem {
  id: number;
  type: ActivityType | string; // string fallback for forward-compat
  status: ActivityStatus | string;
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ActivityDetail extends ActivityListItem {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
}

export async function getActivityList(opts?: {
  limit?: number;
  beforeId?: number;
  type?: string[];
}): Promise<{ items: ActivityListItem[]; next_before_id: number | null }> {
  const search = new URLSearchParams();
  if (opts?.limit) search.set("limit", String(opts.limit));
  if (opts?.beforeId) search.set("before_id", String(opts.beforeId));
  if (opts?.type && opts.type.length > 0) search.set("type", opts.type.join(","));
  const q = search.toString();
  const res = await fetch(`/api/activity${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`getActivityList: ${res.status}`);
  return res.json();
}

export async function getActivityDetail(id: number): Promise<ActivityDetail> {
  const res = await fetch(`/api/activity/${id}`);
  if (!res.ok) throw new Error(`getActivityDetail: ${res.status}`);
  return res.json();
}

// Cancel a queued or running request. The activity row id IS the
// underlying Request.id, so the same numeric handle works against
// /api/requests. Backend returns 409 when the row has already settled
// (done/failed/timeout/canceled).
export async function cancelActivity(id: number): Promise<void> {
  const res = await fetch(`/api/requests/${id}/cancel`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cancelActivity: ${res.status} ${detail}`);
  }
}


// -- References -----------------------------------------------------------
// User-curated cross-board library of saved media. Backend mirror:
// agent/flowboard/routes/references.py + db.models.Reference.
// JSON wire format is snake_case (mirrors SQLModel column names);
// camelCase is reserved for the TS surface, so each helper maps the
// rows on the way back.

export interface ReferenceItem {
  id: number;
  mediaId: string;
  // Best-effort signed CDN URL captured at save time. May expire — the
  // canonical bytes live in storage/media/{mediaId}.{ext}; this field
  // exists purely as a re-ingest hint when the file goes missing.
  url: string | null;
  label: string;
  kind: "add_reference" | "upload" | "reference" | "variant";
  // Snapshot of the source node's aiBrief at save time; lets cross-board
  // spawn skip the re-vision call entirely.
  aiBrief: string | null;
  aspectRatio: string | null;
  tags: string[];
  pinned: boolean;
  position: number;
  sourceBoardId: number | null;
  sourceNodeShortId: string | null;
  createdAt: string;
}

// Wire-shape POST body — snake_case to match the FastAPI schema 1:1.
export interface ReferenceCreateInput {
  media_id: string;
  kind: ReferenceItem["kind"];
  label?: string;
  ai_brief?: string | null;
  aspect_ratio?: string | null;
  url?: string | null;
  source_board_id?: number | null;
  source_node_short_id?: string | null;
  tags?: string[];
}

// Wire-shape PATCH body. Same snake_case convention.
export interface ReferencePatchInput {
  label?: string;
  pinned?: boolean;
  position?: number;
  tags?: string[];
}

interface ReferenceRowWire {
  id: number;
  media_id: string;
  url: string | null;
  label: string;
  kind: string;
  ai_brief: string | null;
  aspect_ratio: string | null;
  tags: string[] | null;
  pinned: boolean;
  position: number;
  source_board_id: number | null;
  source_node_short_id: string | null;
  created_at: string;
}

function mapReferenceRow(row: ReferenceRowWire): ReferenceItem {
  // Coerce the kind string into the typed union — the backend already
  // validates against _ALLOWED_KINDS so any unknown value here would
  // mean a backend bug. Fall back to "add_reference" defensively rather than
  // throwing, so a single bad row doesn't break the whole list render.
  const allowed: ReferenceItem["kind"][] = [
    "add_reference",
    "upload",
    "reference",
    "variant",
  ];
  const kind: ReferenceItem["kind"] = (allowed as string[]).includes(row.kind)
    ? (row.kind as ReferenceItem["kind"])
    : "add_reference";
  return {
    id: row.id,
    mediaId: row.media_id,
    url: row.url,
    label: row.label,
    kind,
    aiBrief: row.ai_brief,
    aspectRatio: row.aspect_ratio,
    tags: Array.isArray(row.tags) ? row.tags : [],
    pinned: row.pinned,
    position: row.position,
    sourceBoardId: row.source_board_id,
    sourceNodeShortId: row.source_node_short_id,
    createdAt: row.created_at,
  };
}

export async function listReferences(params?: {
  q?: string;
  pinned_first?: boolean;
  limit?: number;
}): Promise<ReferenceItem[]> {
  const search = new URLSearchParams();
  if (params?.q) search.set("q", params.q);
  if (params?.pinned_first !== undefined) {
    search.set("pinned_first", String(params.pinned_first));
  }
  if (params?.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  const rows = await api<ReferenceRowWire[]>(
    `/api/references${qs ? `?${qs}` : ""}`,
  );
  return rows.map(mapReferenceRow);
}

export async function createReference(
  input: ReferenceCreateInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>("/api/references", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return mapReferenceRow(row);
}

export async function patchReference(
  id: number,
  patch: ReferencePatchInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>(`/api/references/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return mapReferenceRow(row);
}

export async function deleteReference(id: number): Promise<void> {
  // Backend returns 204 No Content; api<T>() would choke on the empty
  // body, so we use fetch() directly and skip the JSON parse.
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const url = session ? `${cloudApiBaseUrl}/api/references/${id}` : `/api/references/${id}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`deleteReference: ${res.status} ${res.statusText}`);
  }
}


