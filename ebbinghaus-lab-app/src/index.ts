import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

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
  is_completed: number;
  last_reviewed_at: string | null;
  next_review_due: string | null;
  created_at: string;
};

type User = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
};

const app = new Hono<{ Bindings: Bindings, Variables: { userId: string } }>();

// Global Error Handler to guarantee JSON error response
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

// Helper: Format Date to YYYY-MM-DD
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(baseDateStr: string, days: number): string {
  const d = new Date(baseDateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function calculateDynamicInterval(lastReviewedAt: string | null, createdAt: string, currentInterval: number, todayStr: string): number {
  const baseDateStr = lastReviewedAt || createdAt.split(' ')[0]; // Handle datetime string
  const baseDate = new Date(baseDateStr);
  const today = new Date(todayStr);
  
  const elapsedMs = today.getTime() - baseDate.getTime();
  const elapsedDays = Math.max(0, Math.floor(elapsedMs / (1000 * 60 * 60 * 24)));

  const ef = 2.0; // Ease Factor
  // Base interval for calculation is the actual elapsed days, but at least the current expected interval
  const baseInterval = Math.max(currentInterval, elapsedDays, 1);
  
  let nextInterval = Math.round(baseInterval * ef);
  
  // Cap at 1 year max, 1 day min
  if (nextInterval > 365) nextInterval = 365;
  if (nextInterval < 1) nextInterval = 1;

  return nextInterval;
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
  const today = formatDate(new Date());
  const userId = c.get('userId');

  try {
    let query = 'SELECT * FROM items WHERE user_id = ? ORDER BY is_completed ASC, next_review_due ASC, created_at DESC';
    let params: any[] = [userId];

    if (dueOnly) {
      query = 'SELECT * FROM items WHERE user_id = ? AND is_completed = 0 AND (next_review_due IS NULL OR next_review_due <= ?) ORDER BY next_review_due ASC';
      params = [userId, today];
    }

    const { results } = await c.env.DB.prepare(query).bind(...params).all<Item>();
    return c.json({ items: results || [], today });
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
    const today = formatDate(new Date());
    const initialMemoryStrength = 0.2;
    const initialInterval = 1;
    const nextReviewDue = today;
    const targetMastery = 1.0; // Force 100%

    await c.env.DB.prepare(
      `INSERT INTO items (id, user_id, topic, memo, target_mastery, memory_strength, interval_days, is_completed, last_reviewed_at, next_review_due)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      id, userId, topicTrimmed, body.memo ? body.memo.trim() : null,
      targetMastery, initialMemoryStrength, initialInterval, null, nextReviewDue
    ).run();

    const newItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<Item>();
    return c.json({ item: newItem }, 201);
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

    const today = formatDate(new Date());
    let newMemoryStrength = Math.min(1.0, Math.round((item.memory_strength + 0.20) * 100) / 100);
    let newInterval = calculateDynamicInterval(item.last_reviewed_at, item.created_at, item.interval_days, today);
    let isCompleted = newMemoryStrength >= item.target_mastery ? 1 : 0;
    const nextReviewDue = isCompleted ? null : addDays(today, newInterval);

    await c.env.DB.prepare(
      `UPDATE items SET memory_strength = ?, interval_days = ?, is_completed = ?, last_reviewed_at = ?, next_review_due = ? WHERE id = ?`
    ).bind(newMemoryStrength, newInterval, isCompleted, today, nextReviewDue, id).run();

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
    const keys_p256dh = subscription.keys?.p256dh || null;
    const keys_auth = subscription.keys?.auth || null;
    
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET keys_p256dh = excluded.keys_p256dh, keys_auth = excluded.keys_auth`
    ).bind(userId, endpoint, keys_p256dh, keys_auth).run();
    
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
function b64url(buf: ArrayBuffer): string {
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
  const today = formatDate(new Date());
  const { results: dueItems } = await env.DB.prepare(
    'SELECT DISTINCT user_id FROM items WHERE is_completed = 0 AND next_review_due <= ?'
  ).bind(today).all();
  
  if (!dueItems || dueItems.length === 0) return;
  
  const dueUserIds = dueItems.map(item => (item as any).user_id);
  const placeholders = dueUserIds.map(() => '?').join(',');
  const { results: subscriptions } = await env.DB.prepare(
    `SELECT * FROM subscriptions WHERE user_id IN (${placeholders})`
  ).bind(...dueUserIds).all();
  
  if (!subscriptions) return;
  
  for (const sub of subscriptions) {
    await sendWebPush(sub, env);
  }
}

app.get('/api/cron/trigger', async (c) => {
  await triggerCron(c.env);
  return c.json({ success: true, message: 'Cron logic triggered manually for testing.' });
});

export default {
  fetch: app.fetch,
  scheduled: async (event: any, env: Bindings, ctx: any) => {
    ctx.waitUntil(triggerCron(env));
  }
};
