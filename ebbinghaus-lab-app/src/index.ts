import { Hono, Context, Next } from 'hono';
import { sign, verify } from 'hono/jwt';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  JWT_SECRET?: string;
  ALLOWED_ORIGINS?: string;
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

type AppVariables = {
  userId: string;
  userRecord: User;
};

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PBKDF2_ITERATIONS = 100_000;
const MAX_USERNAME_LEN = 50;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;
const MAX_TOPIC_LEN = 200;
const MAX_MEMO_LEN = 5000;

const NATIVE_ALLOWED_ORIGINS = new Set([
  'https://localhost',
  'capacitor://localhost',
]);

const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:5501',
  'http://127.0.0.1:5501',
]);

// ================= SECURITY HEADERS & CORS =================

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  c.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'no-store');
  }
});

app.use('/api/*', cors({
  origin: (origin, c) => {
    if (!origin) return null;
    try {
      const reqUrl = new URL(c.req.url);
      if (origin === reqUrl.origin) return origin;
      if (NATIVE_ALLOWED_ORIGINS.has(origin)) return origin;

      const isLocalHostTarget = reqUrl.hostname === 'localhost' || reqUrl.hostname === '127.0.0.1';
      if (isLocalHostTarget && LOCAL_DEV_ORIGINS.has(origin)) {
        return origin;
      }

      const extraOrigins = c.env?.ALLOWED_ORIGINS
        ? c.env.ALLOWED_ORIGINS.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      if (extraOrigins.includes(origin)) return origin;
    } catch {
      return null;
    }
    return null;
  },
  allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Global Error Handler: log details internally, never expose internal messages to clients
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'サーバー内部エラーが発生しました' }, 500);
});

// ================= RATE LIMITING (IN-ISOLATE SLIDING WINDOW) =================

type RateBucket = { count: number; resetAt: number };
const rateLimitStore = new Map<string, RateBucket>();

function checkRateLimit(c: Context, scope: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  if (rateLimitStore.size > 1000) {
    for (const [key, bucket] of rateLimitStore.entries()) {
      if (bucket.resetAt <= now) rateLimitStore.delete(key);
    }
  }

  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown-ip';
  const key = `${scope}:${clientIp}`;
  const existing = rateLimitStore.get(key);

  if (!existing || existing.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= maxRequests) {
    return false;
  }

  existing.count += 1;
  return true;
}

// ================= CRYPTO & AUTH HELPERS =================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function hashLegacySha256(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function hashPasswordPBKDF2(password: string, salt?: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: actualSalt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2$${iterations}$${bytesToHex(actualSalt)}$${bytesToHex(new Uint8Array(derivedBits))}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return { valid: false, needsRehash: false };
    const iterations = Number(parts[1]);
    const salt = hexToBytes(parts[2]);
    const expectedHex = parts[3];
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000 || !salt) {
      return { valid: false, needsRehash: false };
    }
    const computed = await hashPasswordPBKDF2(password, salt, iterations);
    const computedHex = computed.split('$')[3] || '';
    return {
      valid: timingSafeEqualStr(computedHex, expectedHex),
      needsRehash: iterations < PBKDF2_ITERATIONS,
    };
  }

  // Backward compatibility with legacy unsalted SHA-256 hashes (upgraded automatically on login)
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const legacyHex = await hashLegacySha256(password);
    return {
      valid: timingSafeEqualStr(legacyHex, storedHash.toLowerCase()),
      needsRehash: true,
    };
  }

  return { valid: false, needsRehash: false };
}

function getJwtSecret(c: { env: Bindings }): string {
  const secret = c.env?.JWT_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Server misconfiguration: JWT_SECRET must be configured with at least 32 characters.');
  }
  return secret;
}

async function computePasswordFingerprint(passwordHash: string, jwtSecret: string): Promise<string> {
  const data = new TextEncoder().encode(`phf-v1:${jwtSecret}:${passwordHash}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest)).slice(0, 24);
}

async function issueAuthToken(userId: string, passwordHash: string, jwtSecret: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const phf = await computePasswordFingerprint(passwordHash, jwtSecret);
  return sign(
    { id: userId, phf, iat: nowSec, exp: nowSec + JWT_TTL_SECONDS },
    jwtSecret,
    'HS256'
  );
}

function checkDbBinding(c: { env: Bindings }) {
  if (!c.env || !c.env.DB) {
    throw new Error('Database (DB) binding is missing.');
  }
}

async function parseJsonBody<T = Record<string, unknown>>(c: Context): Promise<T | null> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function hasControlChars(str: string): boolean {
  return /[\x00-\x1f\x7f]/.test(str);
}

async function requireAuth(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, next: Next) {
  checkDbBinding(c);
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '認証が必要です' }, 401);
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ error: '認証が必要です' }, 401);
  }

  const secret = getJwtSecret(c);
  let payload: Record<string, unknown>;
  try {
    payload = await verify(token, secret, 'HS256') as Record<string, unknown>;
  } catch {
    return c.json({ error: 'セッションが無効または期限切れです' }, 401);
  }

  if (typeof payload.id !== 'string' || typeof payload.phf !== 'string') {
    return c.json({ error: 'セッションが無効です。再ログインしてください' }, 401);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, username, password_hash, created_at FROM users WHERE id = ?'
  ).bind(payload.id).first<User>();

  if (!user) {
    return c.json({ error: 'ユーザーが見つかりません' }, 401);
  }

  const expectedPhf = await computePasswordFingerprint(user.password_hash, secret);
  if (!timingSafeEqualStr(payload.phf, expectedPhf)) {
    return c.json({ error: 'パスワードが変更されたためセッションが無効になりました。再ログインしてください' }, 401);
  }

  c.set('userId', user.id);
  c.set('userRecord', user);
  await next();
}

// ================= DATE & SPACING HELPERS =================

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

// ================= AUTH ROUTES =================

app.post('/api/auth/register', async (c) => {
  checkDbBinding(c);
  if (!checkRateLimit(c, 'auth:register', 5, 60_000)) {
    return c.json({ error: '試行回数が上限を超えました。1分ほど待ってから再試行してください' }, 429);
  }

  const secret = getJwtSecret(c);
  const body = await parseJsonBody<{ username?: unknown; password?: unknown }>(c);
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400);
  }

  const username = body.username.trim();
  const password = body.password;

  if (!username || username.length > MAX_USERNAME_LEN || hasControlChars(username)) {
    return c.json({ error: `ユーザー名は1〜${MAX_USERNAME_LEN}文字の有効な文字列で入力してください` }, 400);
  }
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    return c.json({ error: `パスワードは${MIN_PASSWORD_LEN}文字以上${MAX_PASSWORD_LEN}文字以内で設定してください` }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return c.json({ error: 'このユーザー名は登録できません' }, 400);
  }

  const id = crypto.randomUUID();
  const passHash = await hashPasswordPBKDF2(password);

  await c.env.DB.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .bind(id, username, passHash).run();

  const token = await issueAuthToken(id, passHash, secret);
  return c.json({ token, username });
});

app.post('/api/auth/login', async (c) => {
  checkDbBinding(c);
  if (!checkRateLimit(c, 'auth:login', 10, 60_000)) {
    return c.json({ error: 'ログイン試行回数が上限を超えました。1分ほど待ってから再試行してください' }, 429);
  }

  const secret = getJwtSecret(c);
  const body = await parseJsonBody<{ username?: unknown; password?: unknown }>(c);
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400);
  }

  const username = body.username.trim();
  const password = body.password;

  if (!username || username.length > MAX_USERNAME_LEN || !password || password.length > MAX_PASSWORD_LEN) {
    return c.json({ error: 'ユーザー名またはパスワードが正しくありません' }, 401);
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username).first<User>();

  if (!user) {
    // Mitigate timing-based username enumeration
    await hashPasswordPBKDF2(password, new Uint8Array(16));
    return c.json({ error: 'ユーザー名またはパスワードが正しくありません' }, 401);
  }

  const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'ユーザー名またはパスワードが正しくありません' }, 401);
  }

  let activeHash = user.password_hash;
  if (needsRehash) {
    activeHash = await hashPasswordPBKDF2(password);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(activeHash, user.id).run();
  }

  const token = await issueAuthToken(user.id, activeHash, secret);
  return c.json({ token, username: user.username });
});

app.get('/api/auth/me', requireAuth, async (c) => {
  const user = c.get('userRecord');
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      created_at: user.created_at,
    },
  });
});

app.put('/api/auth/password', requireAuth, async (c) => {
  if (!checkRateLimit(c, 'auth:password', 10, 60_000)) {
    return c.json({ error: '試行回数が上限を超えました。しばらく待ってから再試行してください' }, 429);
  }

  const secret = getJwtSecret(c);
  const user = c.get('userRecord');
  const body = await parseJsonBody<{ currentPassword?: unknown; newPassword?: unknown }>(c);

  if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string' || !body.currentPassword || !body.newPassword) {
    return c.json({ error: '現在のパスワードと新しいパスワードを入力してください' }, 400);
  }

  if (body.currentPassword.length > MAX_PASSWORD_LEN) {
    return c.json({ error: '現在のパスワードが正しくありません' }, 401);
  }

  if (body.newPassword.length < MIN_PASSWORD_LEN || body.newPassword.length > MAX_PASSWORD_LEN) {
    return c.json({ error: `新しいパスワードは${MIN_PASSWORD_LEN}文字以上${MAX_PASSWORD_LEN}文字以内で設定してください` }, 400);
  }

  const { valid } = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid) {
    return c.json({ error: '現在のパスワードが正しくありません' }, 401);
  }

  const newHash = await hashPasswordPBKDF2(body.newPassword);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newHash, user.id).run();

  const token = await issueAuthToken(user.id, newHash, secret);
  return c.json({ success: true, token });
});

// ================= ITEMS ROUTES =================

app.use('/api/items/*', requireAuth);

app.get('/api/items', async (c) => {
  const dueOnly = c.req.query('due') === 'true';
  const now = formatDateTime(new Date());
  const userId = c.get('userId');

  let query = 'SELECT * FROM items WHERE user_id = ? ORDER BY is_completed ASC, next_review_due ASC, created_at DESC';
  let params: unknown[] = [userId];

  if (dueOnly) {
    query = 'SELECT * FROM items WHERE user_id = ? AND is_completed = 0 AND (next_review_due IS NULL OR next_review_due <= ?) ORDER BY next_review_due ASC';
    params = [userId, now];
  }

  const { results } = await c.env.DB.prepare(query).bind(...params).all<Item>();
  return c.json({ items: results || [], today: now });
});

app.post('/api/items', async (c) => {
  const userId = c.get('userId');
  const body = await parseJsonBody<{ topic?: unknown; memo?: unknown }>(c);
  if (!body || typeof body.topic !== 'string') {
    return c.json({ error: '学習内容（topic）を入力してください' }, 400);
  }
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== 'string') {
    return c.json({ error: 'メモの形式が不正です' }, 400);
  }

  const topicTrimmed = body.topic.trim();
  const memoTrimmed = typeof body.memo === 'string' && body.memo.trim() ? body.memo.trim() : null;

  if (!topicTrimmed || topicTrimmed.length > MAX_TOPIC_LEN) {
    return c.json({ error: `学習内容は1〜${MAX_TOPIC_LEN}文字以内で入力してください` }, 400);
  }
  if (memoTrimmed && memoTrimmed.length > MAX_MEMO_LEN) {
    return c.json({ error: `メモは${MAX_MEMO_LEN}文字以内で入力してください` }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM items WHERE user_id = ? AND topic = ?')
    .bind(userId, topicTrimmed).first();
  if (existing) {
    return c.json({ error: 'その学習内容は既に登録されています' }, 409);
  }

  const id = crypto.randomUUID();
  const initialMemoryStrength = 0.2;
  const initialInterval = 1;
  const reviewStep = 0;
  const nextReviewDue = getNextReviewTimestamp(reviewStep);
  const targetMastery = 1.0;

  await c.env.DB.prepare(
    `INSERT INTO items (id, user_id, topic, memo, target_mastery, memory_strength, interval_days, review_step, is_completed, last_reviewed_at, next_review_due, last_notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
  ).bind(
    id, userId, topicTrimmed, memoTrimmed,
    targetMastery, initialMemoryStrength, initialInterval, reviewStep, null, nextReviewDue
  ).run();

  const newItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<Item>();
  return c.json({ item: newItem }, 201);
});

app.put('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const body = await parseJsonBody<{ topic?: unknown; memo?: unknown }>(c);

  if (!body || typeof body.topic !== 'string') {
    return c.json({ error: '学習内容（topic）を入力してください' }, 400);
  }
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== 'string') {
    return c.json({ error: 'メモの形式が不正です' }, 400);
  }

  const topic = body.topic.trim();
  const memo = typeof body.memo === 'string' && body.memo.trim() ? body.memo.trim() : null;

  if (!topic || topic.length > MAX_TOPIC_LEN) {
    return c.json({ error: `学習内容は1〜${MAX_TOPIC_LEN}文字以内で入力してください` }, 400);
  }
  if (memo && memo.length > MAX_MEMO_LEN) {
    return c.json({ error: `メモは${MAX_MEMO_LEN}文字以内で入力してください` }, 400);
  }

  const item = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<Item>();
  if (!item) return c.json({ error: 'Item not found' }, 404);

  const duplicate = await c.env.DB.prepare('SELECT id FROM items WHERE user_id = ? AND topic = ? AND id != ?')
    .bind(userId, topic, id).first();
  if (duplicate) {
    return c.json({ error: 'その学習内容は既に登録されています' }, 409);
  }

  await c.env.DB.prepare(
    'UPDATE items SET topic = ?, memo = ? WHERE id = ? AND user_id = ?'
  ).bind(topic, memo, id, userId).run();

  const updatedItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<Item>();
  return c.json({ item: updatedItem });
});

app.put('/api/items/:id/review', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

  const item = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<Item>();
  if (!item) return c.json({ error: 'Item not found' }, 404);

  const now = formatDateTime(new Date());
  const newMemoryStrength = Math.min(1.0, Math.round((item.memory_strength + 0.20) * 100) / 100);
  const nextStep = (item.review_step ?? 0) + 1;
  const isCompleted = newMemoryStrength >= item.target_mastery ? 1 : 0;
  const nextReviewDue = isCompleted ? null : getNextReviewTimestamp(nextStep);

  await c.env.DB.prepare(
    'UPDATE items SET memory_strength = ?, interval_days = ?, review_step = ?, is_completed = ?, last_reviewed_at = ?, next_review_due = ? WHERE id = ? AND user_id = ?'
  ).bind(
    newMemoryStrength,
    EBBINGHAUS_INTERVALS_HOURS[nextStep] || 744,
    nextStep,
    isCompleted,
    now,
    nextReviewDue,
    id,
    userId
  ).run();

  const updatedItem = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<Item>();
  return c.json({ item: updatedItem });
});

app.delete('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

  await c.env.DB.prepare('DELETE FROM items WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return c.json({ success: true, id });
});

export const honoApp = app;

export default {
  fetch: app.fetch,
};
