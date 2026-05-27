import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings } from '../types';

export const betaRoutes = new Hono<AppBindings>();

const smokeRequestSchema = z.object({
  prompt: z.string().trim().min(4).max(1000),
  provider: z.literal('flow').default('flow'),
  expected_output: z.literal('image').default('image'),
});

betaRoutes.post('/beta/smoke-request', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = smokeRequestSchema.parse(await c.req.json());
  const db = new SupabaseRest(c.env);
  const now = Date.now();

  const boardId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  await db.post('/rest/v1/boards', {
    id: boardId,
    user_id: userId,
    name: `Flowboard beta smoke ${new Date(now).toISOString()}`,
  });

  await db.post('/rest/v1/nodes', {
    id: nodeId,
    user_id: userId,
    board_id: boardId,
    type: 'variant',
    position_x: 0,
    position_y: 0,
    data: { type: 'variant', beta_smoke: true },
  });

  const requestRows = await db.post<Array<Record<string, unknown>>>('/rest/v1/requests', {
    id: requestId,
    user_id: userId,
    board_id: boardId,
    node_id: nodeId,
    provider: body.provider,
    task_type: 'txt2img',
    status: 'queued',
    input_data: { prompt: body.prompt, beta_smoke: true },
    expected_output: body.expected_output,
    idempotency_key: `beta-smoke-${userId}-${now}`,
  });

  return c.json({
    board_id: boardId,
    node_id: nodeId,
    request_id: requestId,
    request: requestRows[0] || null,
  });
});
