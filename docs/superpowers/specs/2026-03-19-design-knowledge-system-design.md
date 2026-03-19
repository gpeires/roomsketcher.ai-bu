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

Chunks extracted from articles during sync. Refreshed every sync cycle (cleared and re-extracted).

```sql
CREATE TABLE IF NOT EXISTS design_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  article_updated_at TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  room_types TEXT DEFAULT '[]',       -- JSON array: ["bathroom", "kitchen"]
  design_aspects TEXT DEFAULT '[]',   -- JSON array: ["fixture-placement", "clearance"]
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS design_knowledge_fts USING fts5(
  heading,
  content,
  content='design_knowledge',
  content_rowid='id'
);

-- Auto-sync triggers (same pattern as articles_fts)
CREATE TRIGGER IF NOT EXISTS design_knowledge_ai AFTER INSERT ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(rowid, heading, content)
  VALUES (new.id, new.heading, new.content);
END;

CREATE TRIGGER IF NOT EXISTS design_knowledge_ad AFTER DELETE ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(design_knowledge_fts, rowid, heading, content)
  VALUES ('delete', old.id, old.heading, old.content);
END;

CREATE TRIGGER IF NOT EXISTS design_knowledge_au AFTER UPDATE ON design_knowledge BEGIN
  INSERT INTO design_knowledge_fts(design_knowledge_fts, rowid, heading, content)
  VALUES ('delete', old.id, old.heading, old.content);
  INSERT INTO design_knowledge_fts(rowid, heading, content)
  VALUES (new.id, new.heading, new.content);
END;
```

### `agent_insights`

Discoveries logged by agents. Never cleared during sync — accumulates indefinitely. Staleness flagged when source articles change.

```sql
CREATE TABLE IF NOT EXISTS agent_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  context TEXT,                        -- Sanitized design context (no personal data)
  source_chunk_ids TEXT DEFAULT '[]',  -- JSON array of design_knowledge IDs
  confidence REAL DEFAULT 0.5,         -- Agent self-rated 0.0-1.0
  stale INTEGER DEFAULT 0,            -- 1 if source article changed since insight logged
  created_at TEXT DEFAULT (datetime('now'))
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
Zendesk API → fetch categories/sections/articles → htmlToText() → D1 insert → FTS triggers
                                                                → chunkArticles() → tagChunks() → D1 insert design_knowledge → FTS triggers
                                                                → flagStaleInsights()
```

### Chunking (`chunkArticles`)

Split each article's `body_html` into sections by H2/H3 headers:

- Each H2/H3 becomes a chunk boundary
- Chunk includes the heading text + all content until the next H2/H3 or end of article
- Content is converted to plain text (reuses existing `htmlToText()`)
- Chunks shorter than 50 characters are merged with the previous chunk
- If an article has no H2/H3 headers, the entire article becomes one chunk with heading = article title

### Tagging (`tagChunks`)

Keyword-based, no LLM. Each chunk is scanned against two dictionaries:

**Room types:**

| Keywords | Tag |
|----------|-----|
| toilet, sink (in bathroom context), shower, bathtub, vanity, towel | `bathroom` |
| stove, fridge, refrigerator, oven, counter, cabinet, dishwasher, microwave, kitchen | `kitchen` |
| bed, nightstand, wardrobe, closet, mattress, bedroom | `bedroom` |
| sofa, couch, tv, coffee table, armchair, living room, lounge | `living` |
| dining table, dining room, chairs (in dining context) | `dining` |
| hallway, corridor, foyer, entry, entryway, vestibule | `hallway` |
| office, desk, study, workspace | `office` |
| balcony, terrace, patio, deck, outdoor | `outdoor` |

**Design aspects:**

| Keywords | Tag |
|----------|-----|
| clearance, minimum distance, spacing, gap, at least...cm | `clearance` |
| place, position, arrange, layout, locate, orient | `placement` |
| triangle, workflow, flow, circulation, path, walking | `workflow` |
| dimension, width, depth, height, size, area, square | `dimensions` |
| door, window, swing, opening, sill, arc | `openings` |
| fixture, appliance, furniture, fitting, install | `fixtures` |
| material, floor, wall finish, tile, wood, laminate | `materials` |
| color, colour, paint, tone, shade, palette | `color` |

A chunk can have multiple tags of each type. Tags stored as JSON arrays.

### Staleness Flagging (`flagStaleInsights`)

After articles are synced:

1. For each `agent_insights` row, check if any `source_chunk_ids` reference chunks whose `article_id` has a newer `article_updated_at` than when the insight was created
2. If so, set `stale = 1`
3. Stale insights are still served but flagged — the querying agent decides relevance

## New MCP Tools

### `search_design_knowledge`

Primary tool for agents seeking design guidance.

**Input:**
- `query` (string, required) — natural language search query
- `room_type` (string, optional) — filter by room type tag
- `design_aspect` (string, optional) — filter by design aspect tag
- `include_insights` (boolean, default true) — include agent insights in results
- `limit` (number, default 10) — max results

**Behavior:**
1. Search `design_knowledge_fts` using BM25 ranking (same approach as `articles_fts`)
2. If `include_insights`, also search `agent_insights_fts`
3. Apply room_type/design_aspect filters on the JSON tag arrays
4. Return combined results sorted by relevance, with type indicator (`chunk` vs `insight`)
5. Insights include confidence score and stale flag

**Output:**
```json
{
  "results": [
    {
      "type": "chunk",
      "heading": "Bathroom Fixture Placement",
      "content": "...",
      "room_types": ["bathroom"],
      "design_aspects": ["placement", "fixtures"],
      "source_article_id": 123,
      "source_article_url": "https://help.roomsketcher.com/..."
    },
    {
      "type": "insight",
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
- `source_chunk_ids` (array of integers, optional) — which chunks informed this
- `confidence` (number, 0.0–1.0, default 0.5) — agent self-rating

**Behavior:**
1. Agent MUST ask user permission before calling this tool
2. Agent MUST sanitize any personal details from context before calling
3. Insert into `agent_insights` table
4. FTS triggers auto-update index
5. Return confirmation + new insight ID

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
| `src/sync/chunker.ts` | `chunkArticle()` — split article HTML by H2/H3 headers |
| `src/sync/tagger.ts` | `tagChunk()` — keyword-based room type and design aspect tagging |
| `src/tools/knowledge.ts` | `searchDesignKnowledge()` and `logInsight()` MCP tool handlers |

## Key Decisions

1. **Chunks refreshed on every sync** — simpler than diffing, ensures knowledge stays current with articles
2. **Insights never cleared** — they're agent-contributed and persist indefinitely; only staleness is flagged
3. **Keyword tagging, no LLM** — fast, deterministic, runs on every sync without external API calls
4. **User consent required for insights** — agents must ask before logging; no silent data collection
5. **Sanitized context, no raw prompts** — only design-relevant framing stored, never user-specific details
6. **Combined search results** — `search_design_knowledge` queries both tables, letting agents benefit from both sources in one call
