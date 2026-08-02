import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

type Bindings = {
  DB: D1Database;
  JWT_SECRET?: string;
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

const LEARN_INTERVAL_STEPS = [1, 3, 7, 14, 30];
function getNextLearnInterval(current: number): number {
  const idx = LEARN_INTERVAL_STEPS.indexOf(current);
  if (idx === -1) {
    for (const step of LEARN_INTERVAL_STEPS) {
      if (step > current) return step;
    }
    return 30;
  }
  if (idx < LEARN_INTERVAL_STEPS.length - 1) return LEARN_INTERVAL_STEPS[idx + 1];
  return 30;
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
    const body = await c.req.json<{ topic?: string; memo?: string; target_mastery?: number }>();
    if (!body.topic) return c.json({ error: 'topic is required' }, 400);

    const id = crypto.randomUUID();
    const today = formatDate(new Date());
    const initialMemoryStrength = 0.2;
    const initialInterval = 1;
    const nextReviewDue = today;
    const targetMastery = body.target_mastery || 1.0;

    await c.env.DB.prepare(
      `INSERT INTO items (id, user_id, topic, memo, target_mastery, memory_strength, interval_days, is_completed, last_reviewed_at, next_review_due)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      id, userId, body.topic.trim(), body.memo ? body.memo.trim() : null,
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
    let newInterval = getNextLearnInterval(item.interval_days);
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

export default app;
