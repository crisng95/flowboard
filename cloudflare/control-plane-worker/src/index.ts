import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { isAllowedOrigin, validateEnv } from './lib/env';
import { ApiError, jsonError } from './lib/errors';
import { assetRoutes } from './routes/assets';
import { betaRoutes } from './routes/beta';
import { canvasRoutes } from './routes/canvas';
import { extensionRoutes } from './routes/extension';
import { healthRoutes } from './routes/health';
import { pairingRoutes } from './routes/pairing';
import type { AppBindings } from './types';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  validateEnv(c.env);
  await next();
});

app.options('*', (c) => {
  const origin = c.req.header('origin') || '';
  const allowOrigin = isAllowedOrigin(c.env, origin) ? origin || '*' : '';
  if (allowOrigin) c.header('Access-Control-Allow-Origin', allowOrigin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'authorization,content-type,x-client-id,x-pairing-secret');
  c.header('Access-Control-Max-Age', '600');
  c.header('Vary', 'Origin, Access-Control-Request-Headers');
  return c.body(null, 204);
});

app.use('*', cors({
  origin: (origin, c) => isAllowedOrigin(c.env, origin) ? origin || '*' : '',
  allowHeaders: ['authorization', 'content-type', 'x-client-id', 'x-pairing-secret'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 600,
}));

app.onError((error, c) => {
  if (error instanceof ZodError) {
    return jsonError(c, new ApiError(400, 'INVALID_REQUEST_BODY', error.issues.map((issue) => issue.message).join('; ')));
  }
  return jsonError(c, error);
});

app.notFound((c) => c.json({ error: 'NOT_FOUND', detail: 'Route not found' }, 404));

app.route('/api', healthRoutes);
app.route('/api', assetRoutes);
app.route('/api', betaRoutes);
app.route('/api', canvasRoutes);
app.route('/api', pairingRoutes);
app.route('/api', extensionRoutes);

export default app;
