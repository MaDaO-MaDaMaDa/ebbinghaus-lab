-- Cloudflare D1 Database Schema for Ebbinghaus Memory Lab

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  memo TEXT,
  target_mastery REAL DEFAULT 1.0,
  memory_strength REAL DEFAULT 0.2,
  interval_days INTEGER DEFAULT 1,
  review_step INTEGER DEFAULT 0,
  is_completed INTEGER DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_due TEXT,
  last_notified_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_items_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT,
  keys_auth TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_sub_user_endpoint UNIQUE (user_id, endpoint),
  CONSTRAINT fk_subs_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
