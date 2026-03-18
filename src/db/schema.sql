CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  html_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  html_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  title TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  html_url TEXT,
  position INTEGER DEFAULT 0,
  vote_sum INTEGER DEFAULT 0,
  vote_count INTEGER DEFAULT 0,
  promoted INTEGER DEFAULT 0,
  draft INTEGER DEFAULT 0,
  label_names TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  body_text,
  content='articles',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, body_text)
  VALUES (new.id, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body_text)
  VALUES ('delete', old.id, old.title, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body_text)
  VALUES ('delete', old.id, old.title, old.body_text);
  INSERT INTO articles_fts(rowid, title, body_text)
  VALUES (new.id, new.title, new.body_text);
END;

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Sketch persistence
CREATE TABLE IF NOT EXISTS sketches (
  id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  svg_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sketches_expires ON sketches(expires_at);
