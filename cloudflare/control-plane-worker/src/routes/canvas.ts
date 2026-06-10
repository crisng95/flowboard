import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { bucketName, storageKeyFromSignedUrl, userStorageKey } from '../lib/assetReferences';
import { ApiError } from '../lib/errors';
import { presignGet } from '../lib/r2Presign';
import { assertTaskType } from '../lib/requestGuards';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings } from '../types';

export const canvasRoutes = new Hono<AppBindings>();

function shortId(): string {
  return `n${Math.random().toString(36).slice(2, 6)}`;
}

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

// Pure read-back transform for a completed request's output_result. Merges the
// stored output_result with asset-derived media fields. Critically, the spread
// of `output` preserves any non-media fields the completion stored (e.g. a
// text_gen row's `output_result.text`), and when there are no assets
// `media_urls`/`asset_ids` resolve to empty arrays (Req 5.4).
export function buildCompletedOutputResult(
  output: Record<string, unknown> | null | undefined,
  signedUrls: string[],
  assetIds: string[],
): Record<string, unknown> {
  const base = output ?? {};
  const fallbackMediaUrls = Array.isArray((base as Record<string, unknown>).media_urls)
    ? ((base as Record<string, unknown>).media_urls as unknown[]).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : [];
  const resolvedMediaUrls = signedUrls.length > 0 ? signedUrls : fallbackMediaUrls;
  return {
    ...base,
    media_ids: Array.isArray((base as Record<string, unknown>).media_ids)
      ? (base as Record<string, unknown>).media_ids
      : resolvedMediaUrls,
    media_urls: resolvedMediaUrls,
    asset_ids: assetIds,
  };
}

function stableRequestKey(userId: string, body: Record<string, unknown>): string {
  if (typeof body.idempotency_key === 'string' && body.idempotency_key.trim()) {
    return body.idempotency_key.trim().slice(0, 160);
  }
  const boardId = typeof body.board_id === 'string' ? body.board_id : 'board';
  const nodeId = typeof body.node_id === 'string' ? body.node_id : 'node';
  const requestId = crypto.randomUUID();
  return `canvas-${userId}-${boardId}-${nodeId}-${requestId}`.slice(0, 160);
}

// Helpers to check board ownership
async function ensureBoardOwner(db: SupabaseRest, userId: string, boardId: string): Promise<void> {
  const boards = await db.get<Array<{ id: string }>>('/rest/v1/boards', {
    id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
    select: 'id',
    limit: 1,
  });
  if (!boards.length) {
    throw new ApiError(403, 'ACCESS_DENIED', 'Board access denied or board does not exist');
  }
}

async function ensureNodeOwner(db: SupabaseRest, userId: string, nodeId: string): Promise<string> {
  const nodes = await db.get<Array<{ id: string; board_id: string }>>('/rest/v1/nodes', {
    id: `eq.${nodeId}`,
    select: 'id,board_id',
    limit: 1,
  });
  const node = nodes[0];
  if (!node) {
    throw new ApiError(404, 'NODE_NOT_FOUND', 'Node not found');
  }
  await ensureBoardOwner(db, userId, node.board_id);
  return node.board_id;
}

async function ensureEdgeOwner(db: SupabaseRest, userId: string, edgeId: string): Promise<string> {
  const edges = await db.get<Array<{ id: string; board_id: string }>>('/rest/v1/edges', {
    id: `eq.${edgeId}`,
    select: 'id,board_id',
    limit: 1,
  });
  const edge = edges[0];
  if (!edge) {
    throw new ApiError(404, 'EDGE_NOT_FOUND', 'Edge not found');
  }
  await ensureBoardOwner(db, userId, edge.board_id);
  return edge.board_id;
}

async function findBoundFlowProjectId(db: SupabaseRest, userId: string, boardId: string): Promise<string | null> {
  const rows = await db.get<Array<{ output_result?: Record<string, unknown> }>>('/rest/v1/requests', {
    board_id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
    select: 'output_result',
    order: 'created_at.desc',
    limit: 50,
  });
  return rows
    .map((row) => row.output_result?.project_id)
    .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function shouldHydrateProjectId(inputData: Record<string, unknown>): boolean {
  const value = inputData.project_id;
  return typeof value !== 'string' || !value.trim() || value === 'cloud-worker';
}

export const __test__storageKeyFromSignedUrl = storageKeyFromSignedUrl;

async function hydrateNodeMediaUrls(env: AppBindings['Bindings'], baseUrl: string, userId: string, nodes: any[]): Promise<any[]> {
  const bucket = bucketName(env);
  return Promise.all(nodes.map(async (node) => {
    const data = objectData(node.data);
    const sign = async (value: unknown): Promise<unknown> => {
      const key = userStorageKey(value, userId, bucket);
      return key ? presignGet(env, baseUrl, key, 3600) : value;
    };

    if (typeof data.mediaId === 'string') {
      data.storageKey = data.storageKey || userStorageKey(data.mediaId, userId, bucket) || undefined;
      data.mediaId = await sign(data.storageKey || data.mediaId);
    }
    if (Array.isArray(data.mediaIds)) {
      const storageKeys = Array.isArray(data.storageKeys) ? data.storageKeys : [];
      const nextStorageKeys = data.mediaIds.map((value, index) => {
        if (typeof storageKeys[index] === 'string') return storageKeys[index];
        return userStorageKey(value, userId, bucket);
      });
      data.storageKeys = nextStorageKeys;
      data.mediaIds = await Promise.all(data.mediaIds.map((value, index) => sign(nextStorageKeys[index] || value)));
    }

    if (Array.isArray(data.listItems)) {
      data.listItems = await Promise.all(data.listItems.map(async (rawItem) => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return rawItem;
        const item = { ...(rawItem as Record<string, unknown>) };
        const itemStorageKey = userStorageKey(item.storageKey, userId, bucket)
          || userStorageKey(item.mediaId, userId, bucket)
          || userStorageKey(item.mediaUrl, userId, bucket)
          || userStorageKey(item.imageUrl, userId, bucket)
          || undefined;
        if (itemStorageKey) {
          item.storageKey = itemStorageKey;
          const signedValue = await sign(itemStorageKey);
          if (typeof item.mediaId === 'string') item.mediaId = signedValue;
          if (typeof item.mediaUrl === 'string') item.mediaUrl = signedValue;
          if (typeof item.imageUrl === 'string') item.imageUrl = signedValue;
          if (typeof item.flowMediaId === 'string' && userStorageKey(item.flowMediaId, userId, bucket)) {
            item.flowMediaId = signedValue;
          }
        }
        return item;
      }));
    }

    return { ...node, data };
  }));
}

async function hydrateNodeMediaUrl(env: AppBindings['Bindings'], userId: string, node: any): Promise<any> {
  const nodes = await hydrateNodeMediaUrls(env, 'https://api.flowboard.bond', userId, node ? [node] : []);
  return nodes[0] || null;
}

// --- Boards ---

canvasRoutes.get('/references', async (c) => {
  await requireUser(c.env, c.req.header('authorization'));
  return c.json([]);
});

canvasRoutes.post('/references', async (c) => {
  await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    id: Date.now(),
    media_id: typeof body.media_id === 'string' ? body.media_id : '',
    url: typeof body.url === 'string' ? body.url : null,
    label: typeof body.label === 'string' ? body.label : 'Untitled',
    kind: typeof body.kind === 'string' ? body.kind : 'add_reference',
    ai_brief: typeof body.ai_brief === 'string' ? body.ai_brief : null,
    aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    pinned: false,
    position: 0,
    source_board_id: null,
    source_node_short_id: typeof body.source_node_short_id === 'string' ? body.source_node_short_id : null,
    created_at: new Date().toISOString(),
  });
});

canvasRoutes.patch('/references/:id', async (c) => {
  await requireUser(c.env, c.req.header('authorization'));
  const id = Number(c.req.param('id')) || Date.now();
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    id,
    media_id: '',
    url: null,
    label: typeof body.label === 'string' ? body.label : 'Untitled',
    kind: 'add_reference',
    ai_brief: null,
    aspect_ratio: null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    pinned: Boolean(body.pinned),
    position: typeof body.position === 'number' ? body.position : 0,
    source_board_id: null,
    source_node_short_id: null,
    created_at: new Date().toISOString(),
  });
});

canvasRoutes.delete('/references/:id', async (c) => {
  await requireUser(c.env, c.req.header('authorization'));
  return c.body(null, 204);
});

canvasRoutes.get('/boards', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const db = new SupabaseRest(c.env);
  const boards = await db.get<any[]>('/rest/v1/boards', {
    user_id: `eq.${userId}`,
    select: 'id,name,created_at',
    order: 'created_at.desc',
  });
  return c.json(boards);
});

canvasRoutes.post('/boards', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : 'Untitled space';
  const db = new SupabaseRest(c.env);
  
  const boards = await db.post<any[]>('/rest/v1/boards', {
    user_id: userId,
    name,
  });
  
  return c.json(boards[0] || null);
});

canvasRoutes.get('/boards/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const boardId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  // Verify ownership
  const boards = await db.get<any[]>('/rest/v1/boards', {
    id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
    select: 'id,name,created_at',
    limit: 1,
  });
  const board = boards[0];
  if (!board) throw new ApiError(404, 'BOARD_NOT_FOUND', 'Board not found or access denied');
  
  // Fetch nodes
  const nodes = await db.get<any[]>('/rest/v1/nodes', {
    board_id: `eq.${boardId}`,
    select: '*',
  });
  
  // Fetch edges
  const edges = await db.get<any[]>('/rest/v1/edges', {
    board_id: `eq.${boardId}`,
    select: '*',
  });
  
  const hydratedNodes = await hydrateNodeMediaUrls(c.env, c.req.url, userId, nodes);

  return c.json({
    board,
    nodes: hydratedNodes,
    edges,
  });
});

canvasRoutes.get('/boards/:id/project', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const boardId = c.req.param('id');
  const db = new SupabaseRest(c.env);

  await ensureBoardOwner(db, userId, boardId);
  const projectId = await findBoundFlowProjectId(db, userId, boardId);

  if (!projectId) throw new ApiError(404, 'BOARD_PROJECT_NOT_FOUND', 'No Flow project bound to this board yet');
  return c.json({ flow_project_id: projectId, created: false });
});

canvasRoutes.post('/boards/:id/project', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const boardId = c.req.param('id');
  const db = new SupabaseRest(c.env);

  await ensureBoardOwner(db, userId, boardId);
  const projectId = await findBoundFlowProjectId(db, userId, boardId);

  return c.json({ flow_project_id: projectId ?? 'cloud-worker', created: !projectId });
});

canvasRoutes.patch('/boards/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const boardId = c.req.param('id');
  const body = await c.req.json();
  const name = typeof body.name === 'string' ? body.name.trim() : 'Untitled space';
  const db = new SupabaseRest(c.env);
  
  await ensureBoardOwner(db, userId, boardId);
  
  const boards = await db.patch<any[]>('/rest/v1/boards', { name }, {
    id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
  });
  
  return c.json(boards[0] || null);
});

canvasRoutes.delete('/boards/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const boardId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  await ensureBoardOwner(db, userId, boardId);

  await db.request('/rest/v1/request_events', { method: 'DELETE' }, {
    board_id: `eq.${boardId}`,
  }).catch(() => null);

  await db.patch('/rest/v1/assets', {
    retention_state: 'orphaned',
    orphaned_at: new Date().toISOString(),
  }, {
    board_id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
    retention_state: 'neq.pinned',
  }).catch(() => null);

  await db.request('/rest/v1/requests', { method: 'DELETE' }, {
    board_id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
  });

  await db.request('/rest/v1/edges', { method: 'DELETE' }, {
    board_id: `eq.${boardId}`,
  });

  await db.request('/rest/v1/nodes', { method: 'DELETE' }, {
    board_id: `eq.${boardId}`,
  });
  
  await db.request('/rest/v1/boards', {
    method: 'DELETE',
  }, {
    id: `eq.${boardId}`,
    user_id: `eq.${userId}`,
  });
  
  return c.json({ deleted: boardId });
});

// --- Nodes ---

canvasRoutes.post('/nodes', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);
  
  await ensureBoardOwner(db, userId, body.board_id);

  const data = objectData(body.data);
  data.shortId = typeof data.shortId === 'string' ? data.shortId : shortId();
  data.status = body.status ?? data.status ?? 'idle';
  if (body.w !== undefined) data.w = body.w;
  if (body.h !== undefined) data.h = body.h;
  if (body.parent_id !== undefined) data.parent_id = body.parent_id;
  
  const payload = {
    id: crypto.randomUUID(),
    user_id: userId,
    board_id: body.board_id,
    type: body.type,
    position_x: body.position_x ?? body.x ?? 0,
    position_y: body.position_y ?? body.y ?? 0,
    data,
  };
  
  const nodes = await db.post<any[]>('/rest/v1/nodes', payload);
  const hydrated = await hydrateNodeMediaUrl(c.env, userId, nodes[0]);
  return c.json(hydrated);
});

canvasRoutes.patch('/nodes/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const nodeId = c.req.param('id');
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);
  
  await ensureNodeOwner(db, userId, nodeId);
  const existingRows = await db.get<Array<{ data?: Record<string, unknown> }>>('/rest/v1/nodes', {
    id: `eq.${nodeId}`,
    select: 'data',
    limit: 1,
  });
  const data = objectData(existingRows[0]?.data);
  
  const payload: any = {};
  if (body.position_x !== undefined) payload.position_x = body.position_x;
  if (body.position_y !== undefined) payload.position_y = body.position_y;
  if (body.w !== undefined) data.w = body.w;
  if (body.h !== undefined) data.h = body.h;
  if (body.status !== undefined) data.status = body.status;
  if (body.parent_id !== undefined) data.parent_id = body.parent_id;
  if (body.data !== undefined) Object.assign(data, objectData(body.data));
  payload.data = data;
  
  const nodes = await db.patch<any[]>('/rest/v1/nodes', payload, {
    id: `eq.${nodeId}`,
  });
  const hydrated = await hydrateNodeMediaUrl(c.env, userId, nodes[0]);
  return c.json(hydrated);
});

canvasRoutes.delete('/nodes/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const nodeId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  const boardId = await ensureNodeOwner(db, userId, nodeId);
  
  // Find all edges that touch this node
  const edges = await db.get<any[]>('/rest/v1/edges', {
    board_id: `eq.${boardId}`,
    or: `(source_node_id.eq.${nodeId},target_node_id.eq.${nodeId})`,
  });
  const deletedEdgeIds = edges.map(e => e.id);
  
  // Cloud schema stores group membership in data.parent_id rather than a column.
  // Detach is best-effort here; deleting the node itself is the critical path.
  
  // Delete touching edges
  if (deletedEdgeIds.length > 0) {
    await db.request('/rest/v1/edges', {
      method: 'DELETE',
    }, {
      board_id: `eq.${boardId}`,
      id: `in.(${deletedEdgeIds.join(',')})`,
    });
  }
  
  // Delete the node
  await db.request('/rest/v1/nodes', {
    method: 'DELETE',
  }, {
    id: `eq.${nodeId}`,
  });
  
  return c.json({ ok: true, deleted_edges: deletedEdgeIds, deleted_child_ids: [] });
});

canvasRoutes.post('/nodes/group', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);
  
  await ensureBoardOwner(db, userId, body.board_id);
  
  // 1. Create group node
  const groupPayload = {
    id: crypto.randomUUID(),
    user_id: userId,
    board_id: body.board_id,
    type: 'group',
    position_x: body.x ?? 0,
    position_y: body.y ?? 0,
    data: {
      title: body.title ?? 'Group',
      groupColor: body.color ?? 'rgba(82,60,128,0.28)',
      locked: body.locked ?? false,
      shortId: shortId(),
      status: 'idle',
      w: body.w ?? 320,
      h: body.h ?? 240,
    },
  };
  const groups = await db.post<any[]>('/rest/v1/nodes', groupPayload);
  const group = groups[0];
  if (!group) throw new ApiError(500, 'GROUP_CREATE_FAILED', 'Failed to create group node');
  
  // 2. Reparent child nodes
  const childIds = Array.isArray(body.child_ids) ? body.child_ids : [];
  const livePositions = new Map<string, { x: number; y: number }>();
  if (Array.isArray(body.child_positions)) {
    for (const item of body.child_positions) {
      if (!item || typeof item.id !== 'string') continue;
      const x = Number(item.x);
      const y = Number(item.y);
      if (Number.isFinite(x) && Number.isFinite(y)) livePositions.set(item.id, { x, y });
    }
  }
  let updatedChildren: any[] = [];
  if (childIds.length > 0) {
    const childRows = await db.get<any[]>('/rest/v1/nodes', {
      board_id: `eq.${body.board_id}`,
      id: `in.(${childIds.join(',')})`,
    });
    updatedChildren = [];
    for (const child of childRows) {
      const childData = objectData(child.data);
      childData.parent_id = group.id;
      const live = livePositions.get(child.id);
      const persistedX = Number(child.position_x);
      const persistedY = Number(child.position_y);
      const absoluteX = live?.x ?? (Number.isFinite(persistedX) ? persistedX : 0);
      const absoluteY = live?.y ?? (Number.isFinite(persistedY) ? persistedY : 0);
      const rows = await db.patch<any[]>('/rest/v1/nodes', {
        position_x: Math.round(absoluteX - group.position_x),
        position_y: Math.round(absoluteY - group.position_y),
        data: childData,
      }, { id: `eq.${child.id}` });
      if (rows[0]) updatedChildren.push(rows[0]);
    }
  }
  
  const hydratedChildren = await hydrateNodeMediaUrls(c.env, c.req.url, userId, updatedChildren);
  return c.json({ group, children: hydratedChildren });
});

canvasRoutes.post('/nodes/:id/ungroup', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const groupId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  const boardId = await ensureNodeOwner(db, userId, groupId);
  const groupRows = await db.get<any[]>('/rest/v1/nodes', {
    id: `eq.${groupId}`,
    board_id: `eq.${boardId}`,
    select: 'id,position_x,position_y',
    limit: 1,
  });
  const group = groupRows[0];
  if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found or access denied');
  
  // Get children
  const children = await db.get<any[]>('/rest/v1/nodes', {
    board_id: `eq.${boardId}`,
    select: '*',
  });
  const groupChildren = children.filter((child) => objectData(child.data).parent_id === groupId);
  const childIds = groupChildren.map(c => c.id);
  
  // Detach children
  let updatedChildren: any[] = [];
  if (childIds.length > 0) {
    for (const child of groupChildren) {
      const childData = objectData(child.data);
      childData.parent_id = null;
      const rows = await db.patch<any[]>('/rest/v1/nodes', {
        position_x: Math.round((Number(group.position_x) || 0) + (Number(child.position_x) || 0)),
        position_y: Math.round((Number(group.position_y) || 0) + (Number(child.position_y) || 0)),
        data: childData,
      }, { id: `eq.${child.id}` });
      if (rows[0]) updatedChildren.push(rows[0]);
    }
  }
  
  // Delete group node
  await db.request('/rest/v1/nodes', {
    method: 'DELETE',
  }, {
    id: `eq.${groupId}`,
  });
  
  const hydratedChildren = await hydrateNodeMediaUrls(c.env, c.req.url, userId, updatedChildren);
  return c.json({ deleted_group_id: groupId, children: hydratedChildren });
});

// --- Edges ---

canvasRoutes.post('/edges', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);
  
  await ensureBoardOwner(db, userId, body.board_id);
  
  const payload = {
    id: crypto.randomUUID(),
    user_id: userId,
    board_id: body.board_id,
    source_node_id: body.source_node_id,
    target_node_id: body.target_node_id,
    source_handle: body.source_handle ?? 'source',
    target_handle: body.target_handle ?? null,
  };
  
  const edges = await db.post<any[]>('/rest/v1/edges', payload);
  return c.json(edges[0] || null);
});

canvasRoutes.patch('/edges/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const edgeId = c.req.param('id');
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);

  await ensureEdgeOwner(db, userId, edgeId);

  const edges = await db.get<any[]>('/rest/v1/edges', {
    id: `eq.${edgeId}`,
    select: '*',
    limit: 1,
  });
  return c.json(edges[0] || null);
});

canvasRoutes.delete('/edges/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const edgeId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  await ensureEdgeOwner(db, userId, edgeId);
  
  await db.request('/rest/v1/edges', {
    method: 'DELETE',
  }, {
    id: `eq.${edgeId}`,
  });
  
  return c.json({ ok: true });
});

// --- Requests ---

canvasRoutes.post('/requests', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = await c.req.json();
  const db = new SupabaseRest(c.env);

  if (typeof body.board_id !== 'string' || !body.board_id.trim()) {
    throw new ApiError(400, 'BOARD_ID_REQUIRED', 'Request must include a board_id');
  }
  if (body.node_id !== undefined && body.node_id !== null && (typeof body.node_id !== 'string' || !body.node_id.trim())) {
    throw new ApiError(400, 'NODE_ID_INVALID', 'Request node_id must be a valid node id');
  }

  await ensureBoardOwner(db, userId, body.board_id);
  if (body.node_id) {
    await ensureNodeOwner(db, userId, body.node_id);
  }

  const inputData = objectData(body.input_data);
  if (shouldHydrateProjectId(inputData)) {
    const boundProjectId = await findBoundFlowProjectId(db, userId, body.board_id);
    if (boundProjectId) inputData.project_id = boundProjectId;
  }

  const taskType = assertTaskType(body.task_type);

  // Use the create_or_reset_request RPC (not a raw INSERT) so re-running a
  // failed/canceled node reuses its existing row — atomically reset back to
  // queued (run_count + 1) instead of piling up duplicate requests. The RPC
  // also returns a completed row as-is for idempotent replays. Reset is keyed
  // on (user_id, idempotency_key): callers that send a stable idempotency_key
  // get reset semantics; callers that omit it get a fresh row each time
  // (stableRequestKey generates a unique key in that case).
  const rows = await db.post<any[]>('/rest/v1/rpc/create_or_reset_request', {
    p_user_id: userId,
    p_board_id: body.board_id,
    p_node_id: body.node_id ?? null,
    p_provider: body.provider ?? 'flow',
    p_task_type: taskType,
    p_input_data: inputData,
    p_idempotency_key: stableRequestKey(userId, body),
    p_expected_output: body.expected_output ?? (taskType === 'text_gen' ? 'text' : 'image'),
  });
  return c.json(rows[0] || null);
});

canvasRoutes.get('/requests/:id', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const requestId = c.req.param('id');
  const db = new SupabaseRest(c.env);
  
  const requests = await db.get<any[]>('/rest/v1/requests', {
    id: `eq.${requestId}`,
    user_id: `eq.${userId}`,
    limit: 1,
  });
  const request = requests[0];
  if (!request) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Request not found or access denied');

  if (request.status === 'completed') {
    const assets = await db.get<Array<{ id: string; storage_key: string }>>('/rest/v1/assets', {
      request_id: `eq.${requestId}`,
      user_id: `eq.${userId}`,
      select: 'id,storage_key',
      order: 'created_at.asc',
    });
    const signedUrls = await Promise.all(assets.map((asset) => presignGet(c.env, c.req.url, asset.storage_key, 3600)));
    const output = request.output_result ?? {};
    request.output_result = buildCompletedOutputResult(
      output,
      signedUrls,
      assets.map((asset) => asset.id),
    );
  }
  
  return c.json(request);
});
