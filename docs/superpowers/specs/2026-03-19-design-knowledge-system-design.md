# Design Knowledge Extraction & Agent Insights System

**Date:** 2026-03-19
**Status:** Draft

## Problem

The RoomSketcher help MCP serves Zendesk articles via full-text search, but design knowledge (bathroom fixture rules, kitchen layouts, room proportions, clearance standards) is buried in long articles. AI agents using the MCP tools must read multiple full articles and extract patterns themselves every time they need design guidance. This is slow, token-expensive, and inconsistent.

## Solution

A two-layer knowledge system:

1. **Automated extraction** — during Zendesk sync, split articles into focused chunks tagged by room type and design aspect. Served via FTS.
2. **Agent insights** — a shared knowledge base where agents (with user consent) log discoveries, connections, and refined rules. Accumulates over time, creating institutional memory.

## Consumers

AI agents calling MCP tools. Agents synthesize the structured knowledge for whoever is asking — end users, designers, other tools.

## New D1 Tables

### `design_knowledge`

Chunks extracted from articles during sync. Refreshed every sync cycle (cleared before articles, then re-extracted).

Uses a **deterministic ID** — hex hash of `article_id:heading` — so that the same chunk gets the same ID across sync cycles. This keeps `agent_insights.source_chunk_ids` stable.

```sql
CREATE TABLE IF NOT EXISTS design_knowledge (
  id TEXT PRIMARY KEY,                -- deterministic hash of article_id:heading
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_updated_at TEXT NOT NULL,
  article_title TEXT,                 -- denormalized for query convenience
  article_url TEXT,                   -- denormalized for query convenience
  heading TEXT,
  content TEXT NOT NULL,
  room_types TEXT DEFAULT '[]',       -- JSON array: ["bathroom", "kitchen"]
  design_aspects TEXT DEFAULT '[]',   -- JSON array: ["fixture-placement", "clearance"]
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_design_knowledge_article ON design_knowledge(article_id);

CREATE VIRTUAL TABLE IF NOT EXISTS design_knowledge_fts USING fts5(
  heading,
  content,
  content='design_knowledge',
  content_rowid='rowid'
);

-- Auto-sync triggers (same pattern as articles_fts)
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
```

### `agent_insights`

Discoveries logged by agents. Never cleared during sync — accumulates indefinitely. Staleness flagged when source articles change.

```sql
CREATE TABLE IF NOT EXISTS agent_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  context TEXT,                            -- Sanitized design context (no personal data)
  source_chunk_ids TEXT DEFAULT '[]',      -- JSON array of design_knowledge IDs (deterministic hashes)
  confidence REAL DEFAULT 0.5,             -- Agent self-rated 0.0-1.0
  stale INTEGER DEFAULT 0,                -- 1 if source article changed since insight logged
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_insights_fts USING fts5(
  content,
  context,
  content='agent_insights',
  content_rowid='id'
);

-- Auto-sync triggers
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
```

## Sync Pipeline Changes

### Current Flow
```
Zendesk API → fetch categories/sections/articles → htmlToText() → D1 insert → FTS triggers
```

### New Flow
```
Zendesk API → fetch categories/sections/articles → htmlToText()
  → DELETE design_knowledge (before articles, FK cascade safety)
  → DELETE articles/sections/categories → re-insert all
  → chunkArticles() → tagChunks() → batch insert design_knowledge (groups of 100)
  → flagStaleInsights()
```

### Delete Order

To avoid FK cascade issues, the sync must delete in this order:
1. `DELETE FROM design_knowledge` (references articles)
2. `DELETE FROM articles` (existing step)
3. `DELETE FROM sections` (existing step)
4. `DELETE FROM categories` (existing step)

Then re-insert in reverse order (categories → sections → articles → design_knowledge).

### Batch Size

D1's `batch()` API has a limit of ~100 statements per batch. Since N articles x M chunks can easily exceed this, chunk inserts must be batched in groups of 100.

### Chunking (`chunkArticles`)

Split each article's `body_html` into sections by H2/H3 headers:

- Each H2/H3 becomes a chunk boundary
- Chunk includes the heading text + all content until the next H2/H3 or end of article
- Content is converted to plain text (reuses existing `htmlToText()`)
- Chunks shorter than 150 characters are merged with the next chunk (or previous if last)
- If an article has no H2/H3 headers, the entire article becomes one chunk with heading = article title

### Chunk ID Generation

Deterministic hash of `${article_id}:${heading_or_title}`:
```ts
function chunkId(articleId: number, heading: string): string {
  // Simple hex hash — stable across syncs for the same article+heading
  const input = `${articleId}:${heading}`;
  const hash = Array.from(new TextEncoder().encode(input))
    .reduce((h, b) => ((h << 5) - h + b) | 0, 0);
  return Math.abs(hash).toString(16).padStart(8, '0');
}
```

If an article has multiple H2s with the same text, append an index: `${article_id}:${heading}:${index}`.

### Tagging (`tagChunks`)

Keyword-based, no LLM. Each chunk is scanned against two dictionaries.

**Room types:**

| Keywords | Tag | Notes |
|----------|-----|-------|
| toilet, shower, bathtub, vanity, towel | `bathroom` | Always tagged |
| sink | `bathroom` | Only if chunk also contains another bathroom keyword |
| stove, fridge, refrigerator, oven, counter, cabinet, dishwasher, microwave, kitchen | `kitchen` | |
| bed, nightstand, wardrobe, mattress, bedroom | `bedroom` | |
| sofa, couch, tv, coffee table, armchair, living room, lounge | `living` | |
| dining table, dining room | `dining` | |
| chairs | `dining` | Only if chunk also contains another dining keyword |
| hallway, corridor, foyer, entry, entryway, vestibule | `hallway` | |
| office, desk, study, workspace | `office` | |
| closet | `bedroom` | Only if chunk also contains another bedroom keyword |
| balcony, terrace, patio, deck, outdoor | `outdoor` | |

**Design aspects:**

| Keywords | Tag |
|----------|-----|
| clearance, minimum distance, spacing, gap | `clearance` |
| place, position, arrange, layout, locate, orient | `placement` |
| triangle, workflow, flow, circulation, path, walking | `workflow` |
| dimension, width, depth, height, size, area, square | `dimensions` |
| door, window, swing, opening, sill, arc | `openings` |
| fixture, appliance, furniture, fitting, install | `fixtures` |
| material, floor, wall finish, tile, wood, laminate | `materials` |
| color, colour, paint, tone, shade, palette | `color` |

A chunk can have multiple tags of each type. Tags stored as JSON arrays.

### Staleness Flagging (`flagStaleInsights`)

After articles and chunks are synced, flag insights whose source chunks came from articles that changed:

```sql
UPDATE agent_insights SET stale = 1, updated_at = datetime('now')
WHERE stale = 0
  AND id IN (
    SELECT DISTINCT ai.id
    FROM agent_insights ai, json_each(ai.source_chunk_ids) je
    JOIN design_knowledge dk ON dk.id = je.value
    WHERE dk.article_updated_at > ai.created_at
  );
```

Notes:
- `json_each()` unpacks the JSON array so each referenced chunk ID can be joined
- Only flags previously-unflagged insights (`stale = 0`) for efficiency
- Insights with empty `source_chunk_ids` (`'[]'`) are never flagged — `json_each` on an empty array produces no rows

## New MCP Tools

### `search_design_knowledge`

Primary tool for agents seeking design guidance.

**Input:**
- `query` (string, required) — natural language search query
- `room_type` (string, optional) — filter by room type tag
- `design_aspect` (string, optional) — filter by design aspect tag
- `include_insights` (boolean, default true) — include agent insights in results
- `limit` (number, default 10) — max results per section

**Behavior:**
1. Search `design_knowledge_fts` using BM25 ranking
2. Apply room_type/design_aspect filters using `json_each()`:
   ```sql
   SELECT dk.*, bm25(design_knowledge_fts) AS rank
   FROM design_knowledge_fts
   JOIN design_knowledge dk ON dk.rowid = design_knowledge_fts.rowid
   WHERE design_knowledge_fts MATCH ?
     AND (? IS NULL OR EXISTS (
       SELECT 1 FROM json_each(dk.room_types) WHERE value = ?
     ))
     AND (? IS NULL OR EXISTS (
       SELECT 1 FROM json_each(dk.design_aspects) WHERE value = ?
     ))
   ORDER BY rank
   LIMIT ?
   ```
3. If `include_insights`, search `agent_insights_fts` separately (BM25 scores are not comparable across tables)
4. Return results in two sections: `chunks` and `insights`
5. Sanitize FTS query input (escape special characters) to prevent syntax errors

**Output:**
```json
{
  "chunks": [
    {
      "id": "a1b2c3d4",
      "heading": "Bathroom Fixture Placement",
      "content": "...",
      "room_types": ["bathroom"],
      "design_aspects": ["placement", "fixtures"],
      "source_article_id": 123,
      "source_article_title": "How to Design a Bathroom",
      "source_article_url": "https://help.roomsketcher.com/..."
    }
  ],
  "insights": [
    {
      "id": 42,
      "content": "L-shaped kitchens need 120cm aisles minimum...",
      "context": "kitchen aisle width in L-shaped layouts",
      "confidence": 0.85,
      "stale": false
    }
  ]
}
```

### `log_insight`

For agents to contribute discoveries. Opt-in with user consent.

**Input:**
- `content` (string, required) — the insight
- `context` (string, optional) — sanitized design context (no personal data)
- `source_chunk_ids` (array of strings, optional) — which chunk IDs informed this
- `confidence` (number, 0.0–1.0, default 0.5) — agent self-rating

**Behavior:**
1. Agent MUST ask user permission before calling this tool
2. Agent MUST sanitize any personal details from context before calling
3. Validate: `confidence` clamped to 0.0–1.0, `content` must be non-empty
4. If `source_chunk_ids` provided, verify at least one exists in `design_knowledge`
5. Insert into `agent_insights` table
6. FTS triggers auto-update index
7. Return confirmation + new insight ID

**Error responses:**
- Empty content → `{ "error": "Insight content is required" }`
- All source chunks invalid → `{ "error": "None of the referenced chunks exist" }`
- D1 failure → `{ "error": "Failed to save insight" }`

**Output:**
```json
{
  "id": 42,
  "message": "Insight logged successfully."
}
```

## New Source Files

| File | Purpose |
|------|---------|
| `src/sync/chunker.ts` | `chunkArticle()` — split article HTML by H2/H3 headers, `chunkId()` — deterministic ID |
| `src/sync/tagger.ts` | `tagChunk()` — keyword-based room type and design aspect tagging |
| `src/tools/knowledge.ts` | `searchDesignKnowledge()` and `logInsight()` MCP tool handlers |

## Key Decisions

1. **Chunks refreshed on every sync** — simpler than diffing, ensures knowledge stays current with articles
2. **Deterministic chunk IDs** — hash of `article_id:heading` so IDs survive sync cycles, keeping `agent_insights.source_chunk_ids` stable
3. **Insights never cleared** — they're agent-contributed and persist indefinitely; only staleness is flagged
4. **Keyword tagging, no LLM** — fast, deterministic, runs on every sync without external API calls
5. **Ambiguous keywords require co-occurrence** — "sink" only tags `bathroom` if another bathroom keyword is present; same for "chairs" → `dining`
6. **User consent required for insights** — agents must ask before logging; no silent data collection
7. **Sanitized context, no raw prompts** — only design-relevant framing stored, never user-specific details
8. **Separate ranked lists** — `search_design_knowledge` returns chunks and insights as separate sections (BM25 scores from different FTS tables aren't comparable)
9. **Batch inserts in groups of 100** — D1's batch API limit
10. **Denormalized article title/URL on chunks** — avoids JOIN on queries, acceptable since chunks refresh every sync
