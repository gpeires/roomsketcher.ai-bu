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

-- Design knowledge chunks (extracted from articles during sync)
CREATE TABLE IF NOT EXISTS design_knowledge (
  id TEXT PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_updated_at TEXT NOT NULL,
  article_title TEXT,
  article_url TEXT,
  heading TEXT,
  content TEXT NOT NULL,
  room_types TEXT DEFAULT '[]',
  design_aspects TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_design_knowledge_article ON design_knowledge(article_id);

CREATE VIRTUAL TABLE IF NOT EXISTS design_knowledge_fts USING fts5(
  heading,
  content,
  content='design_knowledge',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS design_knowledge_ai AFTER INSERT ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(rowid, heading, content)
  VALUES (new.rowid, COALESCE(new.heading, ''), new.content);
END;

CREATE TRIGGER IF NOT EXISTS design_knowledge_ad AFTER DELETE ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(design_knowledge_fts, rowid, heading, content)
  VALUES ('delete', old.rowid, COALESCE(old.heading, ''), old.content);
END;

CREATE TRIGGER IF NOT EXISTS design_knowledge_au AFTER UPDATE ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(design_knowledge_fts, rowid, heading, content)
  VALUES ('delete', old.rowid, COALESCE(old.heading, ''), old.content);
  INSERT INTO design_knowledge_fts(rowid, heading, content)
  VALUES (new.rowid, COALESCE(new.heading, ''), new.content);
END;

-- Agent insights (accumulated discoveries, never cleared during sync)
CREATE TABLE IF NOT EXISTS agent_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  context TEXT,
  source_chunk_ids TEXT DEFAULT '[]',
  confidence REAL DEFAULT 0.5,
  stale INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_insights_fts USING fts5(
  content,
  context,
  content='agent_insights',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS agent_insights_ai AFTER INSERT ON agent_insights BEGIN
  INSERT INTO agent_insights_fts(rowid, content, context)
  VALUES (new.id, new.content, COALESCE(new.context, ''));
END;

CREATE TRIGGER IF NOT EXISTS agent_insights_ad AFTER DELETE ON agent_insights BEGIN
  INSERT INTO agent_insights_fts(agent_insights_fts, rowid, content, context)
  VALUES ('delete', old.id, old.content, COALESCE(old.context, ''));
END;

CREATE TRIGGER IF NOT EXISTS agent_insights_au AFTER UPDATE ON agent_insights BEGIN
  INSERT INTO agent_insights_fts(agent_insights_fts, rowid, content, context)
  VALUES ('delete', old.id, old.content, COALESCE(old.context, ''));
  INSERT INTO agent_insights_fts(rowid, content, context)
  VALUES (new.id, new.content, COALESCE(new.context, ''));
END;

-- AI neuron usage tracking (daily budget)
CREATE TABLE IF NOT EXISTS ai_neuron_usage (
  date TEXT PRIMARY KEY,  -- YYYY-MM-DD
  neurons_used INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now'))
);

-- Temporary image uploads for CV analysis
CREATE TABLE IF NOT EXISTS uploaded_images (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  created_at TEXT DEFAULT (datetime('now'))
);
