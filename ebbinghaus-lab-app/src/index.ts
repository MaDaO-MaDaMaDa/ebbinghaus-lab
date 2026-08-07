import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  JWT_SECRET?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK: string;
};

type Item = {
  id: string;
  user_id: string;
  topic: string;
  memo: string | null;
  target_mastery: number;
  memory_strength: number;
  interval_days: number;
  review_step: number;
  is_completed: number;
  last_reviewed_at: string | null;
  next_review_due: string | null;
  last_notified_at: string | null;
  created_at: string;
};

type User = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
};

const app = new Hono<{ Bindings: Bindings, Variables: { userId: string } }>();

app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Global Error Handler to guarantee JSON error response
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

// Helper: Format Date to YYYY-MM-DD HH:MM:SS
function formatDateTime(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const mins = String(d.getUTCMinutes()).padStart(2, '0');
  const secs = String(d.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

const EBBINGHAUS_INTERVALS_HOURS = [1, 9, 24, 48, 144, 744];

function getNextReviewTimestamp(step: number): string {
  const hours = EBBINGHAUS_INTERVALS_HOURS[step] || 744;
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + hours);
  return formatDateTime(d);
}

async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getJwtSecret(c: any) {
  return c.env.JWT_SECRET || 'fallback-secret-key-for-lab';
}

function checkDbBinding(c: any) {
  if (!c.env || !c.env.DB) {
    throw new Error('Database (DB) is not bound in Cloudflare Settings. Please check D1 Database Bindings in Settings -> Functions.');
  }
}

// ================= AUTH ROUTES =================

app.post('/api/auth/register', async (c) => {
  checkDbBinding(c);
  const body = await c.req.json();
  if (!body.username || !body.password) {
    return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(body.username).first();
  if (existing) {
    return c.json({ error: 'このユーザー名は既に使用されています' }, 400);
  }

  const id = crypto.randomUUID();
  const passHash = await hashPassword(body.password);

  await c.env.DB.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .bind(id, body.username, passHash).run();

  const token = await sign({ id: id, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, getJwtSecret(c), 'HS256');
  return c.json({ token, username: body.username });
});

app.post('/api/auth/login', async (c) => {
  checkDbBinding(c);
  const body = await c.req.json();
  if (!body.username || !body.password) {
    return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400);
  }

  const passHash = await hashPassword(body.password);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?')
    .bind(body.username, passHash).first<User>();

  if (!user) {
    return c.json({ error: 'ユーザー名またはパスワードが正しくありません' }, 401);
  }

  const token = await sign({ id: user.id, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, getJwtSecret(c), 'HS256');
  return c.json({ token, username: user.username });
});

app.get('/api/auth/me', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: No token provided' }, 401);
  }
  const token = authHeader.split(' ')[1];

  let payload;
  try {
    payload = await verify(token, getJwtSecret(c), 'HS256');
  } catch (e: any) {
    return c.json({ error: 'Invalid token: ' + e.message }, 401);
  }

  try {
    const user = await c.env.DB.prepare('SELECT id, username, created_at FROM users WHERE id = ?').bind(payload.id).first();
    if (!user) return c.json({ error: 'User not found in DB' }, 404);
    return c.json({ user });
  } catch (dbErr: any) {
    return c.json({ error: 'Database Error: ' + dbErr.message }, 500);
  }
});

app.put('/api/auth/password', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: No token provided' }, 401);
  }
  const token = authHeader.split(' ')[1];

  let payload;
  try {
    payload = await verify(token, getJwtSecret(c), 'HS256');
  } catch (e: any) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  const body = await c.req.json();
  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: '現在のパスワードと新しいパスワードを入力してください' }, 400);
  }

  const currentHash = await hashPassword(body.currentPassword);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? AND password_hash = ?')
    .bind(payload.id, currentHash).first();

  if (!user) {
    return c.json({ error: '現在のパスワードが正しくありません' }, 401);
  }

  const newHash = await hashPassword(body.newPassword);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newHash, payload.id).run();

  return c.json({ success: true });
});

// ================= ITEMS ROUTES =================

app.use('/api/items/*', async (c, next) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = await verify(token, getJwtSecret(c), 'HS256');
    c.set('userId', payload.id as string);
    await next();
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

app.get('/api/items', async (c) => {
  const dueOnly = c.req.query('due') === 'true';
  const now = formatDateTime(new Date());
  const userId = c.get('userId');

  try {
    let query = 'SELECT * FROM items WHERE user_id = ? ORDER BY is_completed ASC, next_review_due ASC, created_at DESC';
    let params: any[] = [userId];

    if (dueOnly) {
      query = 'SELECT * FROM items WHERE user_id = ? AND is_completed = 0 AND (next_review_due IS NULL OR next_review_due <= ?) ORDER BY next_review_due ASC';
      params = [userId, now];
    }

    const { results } = await c.env.DB.prepare(query).bind(...params).all<Item>();
    return c.json({ items: results || [], today: now });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/items', async (c) => {
  const userId = c.get('userId');
  try {
    const body = await c.req.json<{ topic?: string; memo?: string }>();
    if (!body.topic) return c.json({ error: 'topic is required' }, 400);

    const topicTrimmed = body.topic.trim();

    // Check for duplicates
    const existing = await c.env.DB.prepare('SELECT id FROM items WHERE user_id = ? AND topic = ?').bind(userId, topicTrimmed).first();
    if (existing) {
      return c.json({ error: 'その学習内容は既に登録されています' }, 409);
    }

    const id = crypto.randomUUID();
    const initialMemoryStrength = 0.2;
    const initialInterval = 1;
    const reviewStep = 0;
    const nextReviewDue = getNextReviewTimestamp(reviewStep);
    const targetMastery = 1.0; // Force 100%

    await c.env.DB.prepare(
      `INSERT INTO items (id, user_id, topic, memo, target_mastery, memory_strength, interval_days, review_step, is_completed, last_reviewed_at, next_review_due, last_notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
    ).bind(
      id, userId, topicTrimmed, body.memo ? body.memo.trim() : null,
      targetMastery, initialMemoryStrength, initialInterval, reviewStep, null, nextReviewDue
    ).run();

    const newItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<Item>();
    return c.json({ item: newItem }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.put('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const body = await c.req.json();
    const topic = body.topic?.trim();
    const memo = body.memo ? body.memo.trim() : null;

    if (!topic) {
      return c.json({ error: 'Topic is required' }, 400);
    }

    const item = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').bind(id, userId).first<Item>();
    if (!item) return c.json({ error: 'Item not found' }, 404);

    await c.env.DB.prepare(
      `UPDATE items SET topic = ?, memo = ? WHERE id = ? AND user_id = ?`
    ).bind(topic, memo, id, userId).run();

    const updatedItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<Item>();
    return c.json({ item: updatedItem });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
app.put('/api/items/:id/review', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const item = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').bind(id, userId).first<Item>();
    if (!item) return c.json({ error: 'Item not found' }, 404);

    const now = formatDateTime(new Date());
    let newMemoryStrength = Math.min(1.0, Math.round((item.memory_strength + 0.20) * 100) / 100);
    let nextStep = (item.review_step ?? 0) + 1;
    let isCompleted = newMemoryStrength >= item.target_mastery ? 1 : 0;
    const nextReviewDue = isCompleted ? null : getNextReviewTimestamp(nextStep);

    await c.env.DB.prepare(
      `UPDATE items SET memory_strength = ?, interval_days = ?, review_step = ?, is_completed = ?, last_reviewed_at = ?, next_review_due = ? WHERE id = ?`
    ).bind(newMemoryStrength, EBBINGHAUS_INTERVALS_HOURS[nextStep] || 744, nextStep, isCompleted, now, nextReviewDue, id).run();

    const updatedItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<Item>();
    return c.json({ item: updatedItem });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const res = await c.env.DB.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').bind(id, userId).run();
    return c.json({ success: true, id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/notifications/vapid-key', async (c) => {
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

app.get('/api/notifications/status', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const payload = await verify(token, getJwtSecret(c), 'HS256');
    userId = payload.id as string;
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  const countObj = await c.env.DB.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE user_id = ?').bind(userId).first<{ count: number }>();
  return c.json({ subscribed: countObj && countObj.count > 0 });
});

app.post('/api/notifications/subscribe', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const payload = await verify(token, getJwtSecret(c), 'HS256');
    userId = payload.id as string;
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  try {
    const subscription = await c.req.json();
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys ? subscription.keys.p256dh : null;
    const auth = subscription.keys ? subscription.keys.auth : null;

    // Remove any older subscriptions for this user to prevent DB capacity growth 
    // from repeated subscribe/unsubscribe actions generating new endpoints.
    await c.env.DB.prepare(
      `DELETE FROM subscriptions WHERE user_id = ? AND endpoint != ?`
    ).bind(userId, endpoint).run();

    await c.env.DB.prepare(
      `INSERT INTO subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
       keys_p256dh=excluded.keys_p256dh,
       keys_auth=excluded.keys_auth`
    ).bind(userId, endpoint, p256dh, auth).run();

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/notifications/unsubscribe', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const payload = await verify(token, getJwtSecret(c), 'HS256');
    userId = payload.id as string;
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  try {
    const subscription = await c.req.json();
    const endpoint = subscription.endpoint;

    await c.env.DB.prepare(
      `DELETE FROM subscriptions WHERE user_id = ? AND endpoint = ?`
    ).bind(userId, endpoint).run();

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/notifications/pending', async (c) => {
  // This endpoint is called by the Service Worker during a 'push' event.
  // We can just return the generic message.
  return c.json({
    title: '復習の時間です！',
    body: 'エビングハウス・ラボで本日の学習ログを復習しましょう。'
  });
});

// Helper for JWT encoding
function b64url(buf: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function sendWebPush(subscription: any, env: Bindings) {
  const endpoint = new URL(subscription.endpoint);

  const header = { typ: 'JWT', alg: 'ES256' };
  const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));

  const jwtPayload = {
    aud: `${endpoint.protocol}//${endpoint.host}`,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: 'mailto:admin@ebbinghaus.lab'
  };
  const encodedPayload = b64url(new TextEncoder().encode(JSON.stringify(jwtPayload)));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  try {
    const privateKeyJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    const key = await crypto.subtle.importKey(
      'jwk',
      privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(unsignedToken)
    );

    const encodedSignature = b64url(signature);
    const jwt = `${unsignedToken}.${encodedSignature}`;

    const headers = {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'TTL': '60'
    };

    const res = await fetch(subscription.endpoint, { method: 'POST', headers });
    if (!res.ok) {
      if (res.status === 410 || res.status === 404) {
        // Subscription expired or invalid, delete it
        await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(subscription.endpoint).run();
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error('Push error:', err);
    return false;
  }
}

async function triggerCron(env: Bindings) {
  const now = formatDateTime(new Date());
  console.log(`[CRON START] Executed at ${now}`);

  try {
    const { results: dueItems } = await env.DB.prepare(
      `SELECT DISTINCT user_id FROM items 
       WHERE is_completed = 0 
       AND next_review_due <= ? 
       AND (last_notified_at IS NULL 
            OR last_notified_at < next_review_due 
            OR datetime(last_notified_at, '+20 minutes') <= ?)`
    ).bind(now, now).all();

    console.log(`[CRON QUERY] dueItems found: ${dueItems ? dueItems.length : 0}`);

    if (!dueItems || dueItems.length === 0) {
      console.log(`[CRON END] No due items. Exiting.`);
      return;
    }

    const dueUserIds = dueItems.map(item => (item as any).user_id);
    const placeholders = dueUserIds.map(() => '?').join(',');
    
    console.log(`[CRON] dueUserIds: ${JSON.stringify(dueUserIds)}`);

    const { results: subscriptions } = await env.DB.prepare(
      `SELECT * FROM subscriptions WHERE user_id IN (${placeholders})`
    ).bind(...dueUserIds).all();

    console.log(`[CRON] subscriptions found: ${subscriptions ? subscriptions.length : 0}`);

    if (!subscriptions || subscriptions.length === 0) {
      console.log(`[CRON END] Users have due items but no push subscriptions.`);
      return;
    }

    let successCount = 0;
    for (const sub of subscriptions) {
      try {
        const success = await sendWebPush(sub, env);
        if (success) successCount++;
        // Use any cast since sub is from DB
        console.log(`[CRON PUSH] Sent to endpoint ${(sub as any).endpoint?.substring(0, 30)}... Success: ${success}`);
      } catch (pushErr) {
        console.error(`[CRON PUSH ERROR] Failed to send push:`, pushErr);
      }
    }

    console.log(`[CRON] Total push sent successfully: ${successCount} / ${subscriptions.length}`);

    // Update last_notified_at for the due items so we don't notify again until their next review or 20 minutes passes
    const updateRes = await env.DB.prepare(
      `UPDATE items SET last_notified_at = ? 
       WHERE is_completed = 0 
       AND next_review_due <= ? 
       AND (last_notified_at IS NULL 
            OR last_notified_at < next_review_due 
            OR datetime(last_notified_at, '+20 minutes') <= ?)`
    ).bind(now, now, now).run();

    console.log(`[CRON END] Items updated. Success: ${updateRes.success}`);

  } catch (err) {
    console.error(`[CRON ERROR] Fatal error in triggerCron:`, err);
  }
}

app.get('/api/cron/trigger', async (c) => {
  await triggerCron(c.env);
  return c.json({ success: true, message: 'Cron logic triggered manually for testing.' });
});

app.post('/api/debug/push-test', async (c) => {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const payload = await verify(token, getJwtSecret(c), 'HS256');
    userId = payload.id as string;
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  const { results: subscriptions } = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ?'
  ).bind(userId).all();

  if (!subscriptions || subscriptions.length === 0) {
    return c.json({ error: 'No push subscriptions found for this user.' }, 404);
  }

  let successCount = 0;
  for (const sub of subscriptions) {
    // we use a modified payload or the same sendWebPush. 
    // sendWebPush doesn't take a custom payload, but that's fine, the SW will fetch /api/notifications/pending
    const success = await sendWebPush(sub, c.env);
    if (success) successCount++;
  }

  return c.json({ success: true, sent: successCount, total: subscriptions.length });
});

export const honoApp = app;

export default {
  fetch: app.fetch,
  scheduled: async (event: any, env: Bindings, ctx: any) => {
    console.log(`[CRON TRIGGERED BY CLOUDFLARE] cron type: ${event?.cron}, scheduledTime: ${event?.scheduledTime}`);
    ctx.waitUntil(triggerCron(env));
  }
};
