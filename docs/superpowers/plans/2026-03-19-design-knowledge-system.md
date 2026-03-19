# Design Knowledge Extraction & Agent Insights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-layer knowledge system — automated article chunking with tagging during Zendesk sync, plus an agent-contributed insights table — so AI agents can find design guidance without reading full articles.

**Architecture:** New D1 tables (`design_knowledge` + FTS5, `agent_insights` + FTS5) populated during the existing sync pipeline. Two new MCP tools (`search_design_knowledge`, `log_insight`) registered in `src/index.ts`. Chunking and tagging are pure functions in separate modules, tested independently.

**Tech Stack:** Cloudflare Workers, D1 (SQLite + FTS5), Vitest, Zod, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-19-design-knowledge-system-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/schema.sql` | Modify | Add `design_knowledge`, `design_knowledge_fts`, `agent_insights`, `agent_insights_fts` tables + triggers + index |
| `src/sync/chunker.ts` | Create | `chunkArticle()` — split HTML by H2/H3 headers; `chunkId()` — deterministic hash |
| `src/sync/chunker.test.ts` | Create | Tests for chunking logic, ID generation, merge-short-chunks, duplicate-heading dedup |
| `src/sync/tagger.ts` | Create | `tagChunk()` — keyword-based room type + design aspect tagging |
| `src/sync/tagger.test.ts` | Create | Tests for tagging: single tags, multi-tags, co-occurrence rules, no-match |
| `src/sync/ingest.ts` | Modify | Add design_knowledge delete + chunk + tag + batch-insert + stale-flagging to sync pipeline |
| `src/tools/knowledge.ts` | Create | `searchDesignKnowledge()` — FTS5 search with filters; `logInsight()` — insert with validation |
| `src/tools/knowledge.test.ts` | Create | Tests for FTS query sanitization, filter building, insight validation |
| `src/index.ts` | Modify | Register `search_design_knowledge` and `log_insight` MCP tools |

---

## Task 1: D1 Schema — Add design_knowledge and agent_insights tables

**Files:**
- Modify: `src/db/schema.sql` (append after line 76)

- [ ] **Step 1: Add design_knowledge table + FTS + triggers + index**

Append to `src/db/schema.sql`:

```sql
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
```

- [ ] **Step 2: Add agent_insights table + FTS + triggers**

Continue appending to `src/db/schema.sql`:

```sql
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
```

- [ ] **Step 3: Run migration locally**

Run: `npm run db:migrate`
Expected: Tables created successfully (no errors)

- [ ] **Step 4: Run migration on remote D1**

Run: `npm run db:migrate:remote`
Expected: Tables created on remote D1 instance

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat: add design_knowledge and agent_insights D1 tables with FTS5"
```

---

## Task 2: Chunker Module — Split articles by H2/H3 headers

**Files:**
- Create: `src/sync/chunker.ts`
- Create: `src/sync/chunker.test.ts`

- [ ] **Step 1: Write failing tests for `chunkId()`**

Create `src/sync/chunker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chunkId, chunkArticle } from './chunker';

describe('chunkId', () => {
  it('returns a deterministic 8-char hex string', () => {
    const id = chunkId(123, 'Bathroom Fixtures');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(chunkId(123, 'Bathroom Fixtures')).toBe(id); // deterministic
  });

  it('returns different IDs for different inputs', () => {
    expect(chunkId(123, 'A')).not.toBe(chunkId(123, 'B'));
    expect(chunkId(1, 'A')).not.toBe(chunkId(2, 'A'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sync/chunker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write failing tests for `chunkArticle()`**

Append to `src/sync/chunker.test.ts`:

```typescript
describe('chunkArticle', () => {
  it('returns empty array for empty/null body', () => {
    expect(chunkArticle(1, 'Test', '')).toEqual([]);
    expect(chunkArticle(1, 'Test', '   ')).toEqual([]);
  });

  it('splits by H2 headers', () => {
    const html = '<h2>Section A</h2><p>Content A</p><h2>Section B</h2><p>Content B here with enough text to pass the minimum length threshold for chunking</p>';
    const chunks = chunkArticle(100, 'Test Article', html);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe('Section A');
    expect(chunks[0].content).toContain('Content A');
    expect(chunks[1].heading).toBe('Section B');
  });

  it('splits by H3 headers', () => {
    const html = '<h3>Sub A</h3><p>Content A is long enough to be a real chunk on its own</p><h3>Sub B</h3><p>Content B is also long enough to be a standalone chunk</p>';
    const chunks = chunkArticle(200, 'Test', html);
    expect(chunks).toHaveLength(2);
  });

  it('uses article title as heading when no H2/H3 exists', () => {
    const html = '<p>Just a paragraph with enough content to be meaningful and pass any minimum length checks.</p>';
    const chunks = chunkArticle(300, 'My Article', html);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('My Article');
  });

  it('merges short chunks with the next chunk', () => {
    const html = '<h2>Short</h2><p>Hi</p><h2>Long Section</h2><p>This section has plenty of content to stand on its own as a meaningful knowledge chunk.</p>';
    const chunks = chunkArticle(400, 'Test', html);
    expect(chunks).toHaveLength(1); // "Short" merged into "Long Section"
    expect(chunks[0].content).toContain('Hi');
    expect(chunks[0].content).toContain('plenty of content');
  });

  it('deduplicates same-heading by appending index', () => {
    const html = '<h2>FAQ</h2><p>First FAQ section with enough content to be a real chunk on its own in isolation.</p><h2>FAQ</h2><p>Second FAQ section also with enough content to be its own standalone chunk here.</p>';
    const chunks = chunkArticle(500, 'Test', html);
    // Both should exist with unique IDs
    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 4: Write `chunkId()` and `chunkArticle()` implementation**

Create `src/sync/chunker.ts`:

```typescript
import { htmlToText } from './html-to-text';

const MIN_CHUNK_LENGTH = 150;

export interface ArticleChunk {
  id: string;
  heading: string;
  content: string;
}

/**
 * Deterministic chunk ID — hex hash of `articleId:heading`.
 * Stable across sync cycles so agent_insights.source_chunk_ids stay valid.
 */
export function chunkId(articleId: number, heading: string, index?: number): string {
  const input = index !== undefined
    ? `${articleId}:${heading}:${index}`
    : `${articleId}:${heading}`;
  const hash = Array.from(new TextEncoder().encode(input))
    .reduce((h, b) => ((h << 5) - h + b) | 0, 0);
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Split article HTML into chunks by H2/H3 headers.
 * Returns plain-text chunks with deterministic IDs.
 */
export function chunkArticle(
  articleId: number,
  articleTitle: string,
  bodyHtml: string,
): ArticleChunk[] {
  if (!bodyHtml?.trim()) return [];

  // Split by H2/H3 boundaries
  const headerRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const sections: { heading: string; html: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let preHeaderHtml = '';

  while ((match = headerRegex.exec(bodyHtml)) !== null) {
    // Capture content before first header
    if (sections.length === 0 && match.index > 0) {
      preHeaderHtml = bodyHtml.slice(0, match.index);
    } else if (sections.length > 0) {
      sections[sections.length - 1].html = bodyHtml.slice(lastIndex, match.index);
    }
    const headingText = match[1].replace(/<[^>]+>/g, '').trim();
    sections.push({ heading: headingText, html: '' });
    lastIndex = match.index + match[0].length;
  }

  // No headers — whole article is one chunk
  if (sections.length === 0) {
    const content = htmlToText(bodyHtml);
    if (!content.trim()) return [];
    return [{
      id: chunkId(articleId, articleTitle),
      heading: articleTitle,
      content,
    }];
  }

  // Capture trailing content for last section
  if (sections.length > 0) {
    sections[sections.length - 1].html = bodyHtml.slice(lastIndex);
  }

  // Prepend pre-header content to first section
  if (preHeaderHtml.trim()) {
    sections[0].html = preHeaderHtml + sections[0].html;
  }

  // Convert HTML to text
  let chunks: { heading: string; content: string }[] = sections.map(s => ({
    heading: s.heading,
    content: htmlToText(s.html),
  }));

  // Merge short chunks with the next (or previous if last)
  const merged: { heading: string; content: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].content.length < MIN_CHUNK_LENGTH && i < chunks.length - 1) {
      // Merge into next chunk
      chunks[i + 1].content = chunks[i].content + '\n' + chunks[i + 1].content;
    } else if (chunks[i].content.length < MIN_CHUNK_LENGTH && merged.length > 0) {
      // Merge into previous chunk
      merged[merged.length - 1].content += '\n' + chunks[i].content;
    } else {
      merged.push(chunks[i]);
    }
  }

  // Assign deterministic IDs, deduplicating same-heading
  const headingCounts = new Map<string, number>();
  return merged.map(chunk => {
    const count = headingCounts.get(chunk.heading) ?? 0;
    headingCounts.set(chunk.heading, count + 1);
    const id = count === 0
      ? chunkId(articleId, chunk.heading)
      : chunkId(articleId, chunk.heading, count);
    return { id, heading: chunk.heading, content: chunk.content };
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sync/chunker.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sync/chunker.ts src/sync/chunker.test.ts
git commit -m "feat: add article chunker — split by H2/H3 headers with deterministic IDs"
```

---

## Task 3: Tagger Module — Keyword-based room type and design aspect tagging

**Files:**
- Create: `src/sync/tagger.ts`
- Create: `src/sync/tagger.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/sync/tagger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { tagChunk } from './tagger';

describe('tagChunk', () => {
  it('tags bathroom content', () => {
    const result = tagChunk('Fixture Placement', 'Place the toilet 60cm from the shower and add a vanity.');
    expect(result.roomTypes).toContain('bathroom');
  });

  it('tags kitchen content', () => {
    const result = tagChunk('Kitchen Layout', 'Position the stove, fridge, and dishwasher in a work triangle.');
    expect(result.roomTypes).toContain('kitchen');
    expect(result.designAspects).toContain('workflow');
    expect(result.designAspects).toContain('placement');
  });

  it('requires co-occurrence for "sink"', () => {
    const sinkOnly = tagChunk('Sink', 'The sink is installed under a window.');
    expect(sinkOnly.roomTypes).not.toContain('bathroom');

    const sinkWithToilet = tagChunk('Sink', 'The sink is next to the toilet.');
    expect(sinkWithToilet.roomTypes).toContain('bathroom');
  });

  it('requires co-occurrence for "chairs"', () => {
    const chairsOnly = tagChunk('Seating', 'Arrange the chairs around the room.');
    expect(chairsOnly.roomTypes).not.toContain('dining');

    const chairsWithTable = tagChunk('Dining', 'Arrange the chairs around the dining table.');
    expect(chairsWithTable.roomTypes).toContain('dining');
  });

  it('tags multiple room types', () => {
    const result = tagChunk('Open Plan', 'The sofa faces the TV and the stove is behind the counter.');
    expect(result.roomTypes).toContain('living');
    expect(result.roomTypes).toContain('kitchen');
  });

  it('tags design aspects', () => {
    const result = tagChunk('Spacing', 'Maintain 60cm clearance and minimum distance between fixtures.');
    expect(result.designAspects).toContain('clearance');
    expect(result.designAspects).toContain('fixtures');
  });

  it('returns empty arrays for untaggable content', () => {
    const result = tagChunk('Introduction', 'Welcome to RoomSketcher.');
    expect(result.roomTypes).toEqual([]);
    expect(result.designAspects).toEqual([]);
  });

  it('requires co-occurrence for "closet"', () => {
    const closetOnly = tagChunk('Storage', 'The closet is near the entrance.');
    expect(closetOnly.roomTypes).not.toContain('bedroom');

    const closetWithBed = tagChunk('Storage', 'The closet is next to the bed.');
    expect(closetWithBed.roomTypes).toContain('bedroom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sync/tagger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `tagChunk()` implementation**

Create `src/sync/tagger.ts`:

```typescript
export interface ChunkTags {
  roomTypes: string[];
  designAspects: string[];
}

// Room type keywords — entries with `requires` need a co-occurring keyword from the same group
const ROOM_RULES: { keywords: string[]; tag: string; requires?: string[] }[] = [
  { keywords: ['toilet', 'shower', 'bathtub', 'vanity', 'towel'], tag: 'bathroom' },
  { keywords: ['sink'], tag: 'bathroom', requires: ['toilet', 'shower', 'bathtub', 'vanity', 'towel'] },
  { keywords: ['stove', 'fridge', 'refrigerator', 'oven', 'counter', 'cabinet', 'dishwasher', 'microwave', 'kitchen'], tag: 'kitchen' },
  { keywords: ['bed', 'nightstand', 'wardrobe', 'mattress', 'bedroom'], tag: 'bedroom' },
  { keywords: ['closet'], tag: 'bedroom', requires: ['bed', 'nightstand', 'wardrobe', 'mattress', 'bedroom'] },
  { keywords: ['sofa', 'couch', 'tv', 'coffee table', 'armchair', 'living room', 'lounge'], tag: 'living' },
  { keywords: ['dining table', 'dining room'], tag: 'dining' },
  { keywords: ['chairs'], tag: 'dining', requires: ['dining table', 'dining room'] },
  { keywords: ['hallway', 'corridor', 'foyer', 'entry', 'entryway', 'vestibule'], tag: 'hallway' },
  { keywords: ['office', 'desk', 'study', 'workspace'], tag: 'office' },
  { keywords: ['balcony', 'terrace', 'patio', 'deck', 'outdoor'], tag: 'outdoor' },
];

const ASPECT_RULES: { keywords: string[]; tag: string }[] = [
  { keywords: ['clearance', 'minimum distance', 'spacing', 'gap'], tag: 'clearance' },
  { keywords: ['place', 'position', 'arrange', 'layout', 'locate', 'orient'], tag: 'placement' },
  { keywords: ['triangle', 'workflow', 'flow', 'circulation', 'path', 'walking'], tag: 'workflow' },
  { keywords: ['dimension', 'width', 'depth', 'height', 'size', 'area', 'square'], tag: 'dimensions' },
  { keywords: ['door', 'window', 'swing', 'opening', 'sill', 'arc'], tag: 'openings' },
  { keywords: ['fixture', 'appliance', 'furniture', 'fitting', 'install'], tag: 'fixtures' },
  { keywords: ['material', 'floor', 'wall finish', 'tile', 'wood', 'laminate'], tag: 'materials' },
  { keywords: ['color', 'colour', 'paint', 'tone', 'shade', 'palette'], tag: 'color' },
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

/**
 * Tag a chunk with room types and design aspects based on keyword matching.
 * Case-insensitive. A chunk can have multiple tags of each type.
 */
export function tagChunk(heading: string, content: string): ChunkTags {
  const text = `${heading} ${content}`.toLowerCase();

  const roomTypes = new Set<string>();
  for (const rule of ROOM_RULES) {
    if (containsAny(text, rule.keywords)) {
      if (rule.requires) {
        if (containsAny(text, rule.requires)) {
          roomTypes.add(rule.tag);
        }
      } else {
        roomTypes.add(rule.tag);
      }
    }
  }

  const designAspects = new Set<string>();
  for (const rule of ASPECT_RULES) {
    if (containsAny(text, rule.keywords)) {
      designAspects.add(rule.tag);
    }
  }

  return {
    roomTypes: [...roomTypes],
    designAspects: [...designAspects],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sync/tagger.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/tagger.ts src/sync/tagger.test.ts
git commit -m "feat: add keyword-based chunk tagger for room types and design aspects"
```

---

## Task 4: Sync Pipeline Integration — Chunk, tag, and insert during Zendesk sync

**Files:**
- Modify: `src/sync/ingest.ts`

- [ ] **Step 1: Add design_knowledge delete before articles delete**

In `src/sync/ingest.ts`, the current delete order (line 15-19) is:
```typescript
await db.prepare('DELETE FROM articles').run();
await db.prepare('DELETE FROM sections').run();
await db.prepare('DELETE FROM categories').run();
```

Change to delete `design_knowledge` first (FK safety):

```typescript
import { chunkArticle } from './chunker';
import { tagChunk } from './tagger';
```

Replace the delete block:
```typescript
// Clear existing data (order matters for FK constraints)
// design_knowledge references articles, so delete it first
await db.prepare('DELETE FROM design_knowledge').run();
await db.prepare('DELETE FROM articles').run();
await db.prepare('DELETE FROM sections').run();
await db.prepare('DELETE FROM categories').run();
```

- [ ] **Step 2: Add chunking + tagging + batch insert after article insert**

After the existing `await db.batch(articleStmts);` (line 68), add:

```typescript
// Chunk articles into design knowledge
const chunkStmts: ReturnType<D1Database['prepare']>[] = [];
for (const article of publishedArticles) {
  const chunks = chunkArticle(article.id, article.title, article.body || '');
  for (const chunk of chunks) {
    const tags = tagChunk(chunk.heading, chunk.content);
    chunkStmts.push(
      db.prepare(
        `INSERT INTO design_knowledge (id, article_id, article_updated_at, article_title, article_url, heading, content, room_types, design_aspects)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        chunk.id,
        article.id,
        article.updated_at,
        article.title,
        article.html_url,
        chunk.heading,
        chunk.content,
        JSON.stringify(tags.roomTypes),
        JSON.stringify(tags.designAspects),
      )
    );
  }
}

// D1 batch limit is ~100 statements — insert in groups
for (let i = 0; i < chunkStmts.length; i += 100) {
  await db.batch(chunkStmts.slice(i, i + 100));
}

// Flag stale agent insights (source articles changed since insight was created)
await db.prepare(`
  UPDATE agent_insights SET stale = 1, updated_at = datetime('now')
  WHERE stale = 0
    AND id IN (
      SELECT DISTINCT ai.id
      FROM agent_insights ai, json_each(ai.source_chunk_ids) je
      JOIN design_knowledge dk ON dk.id = je.value
      WHERE dk.article_updated_at > ai.created_at
    )
`).run();
```

- [ ] **Step 3: Update the return type to include chunks count**

Update the return statement:

```typescript
return {
  categories: categories.length,
  sections: sections.length,
  articles: publishedArticles.length,
  chunks: chunkStmts.length,
};
```

Update the function signature return type:

```typescript
export async function syncFromZendesk(db: D1Database): Promise<{
  categories: number; sections: number; articles: number; chunks: number;
}> {
```

- [ ] **Step 4: Run existing tests to ensure nothing breaks**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/ingest.ts
git commit -m "feat: integrate chunking + tagging into Zendesk sync pipeline"
```

---

## Task 5: Knowledge Search Tool — FTS5 search with room/aspect filters

**Files:**
- Create: `src/tools/knowledge.ts`
- Create: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Write failing tests for FTS query sanitization and `searchDesignKnowledge`**

Create `src/tools/knowledge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery, validateInsight } from './knowledge';

describe('sanitizeFtsQuery', () => {
  it('strips FTS5 special characters and wraps terms with wildcard suffix', () => {
    const result = sanitizeFtsQuery('bathroom "fixtures"');
    expect(result).toContain('"bathroom"*');
    expect(result).toContain('"fixtures"*');
    expect(result).not.toContain('""');
  });

  it('handles multi-word queries', () => {
    const result = sanitizeFtsQuery('kitchen layout');
    expect(result).toBe('"kitchen"* "layout"*');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('  ')).toBe('');
  });
});

describe('validateInsight', () => {
  it('rejects empty content', () => {
    const result = validateInsight({ content: '', confidence: 0.5 });
    expect(result.error).toBe('Insight content is required');
  });

  it('clamps confidence to 0-1 range', () => {
    const result = validateInsight({ content: 'test', confidence: 1.5 });
    expect(result.confidence).toBe(1.0);

    const low = validateInsight({ content: 'test', confidence: -0.3 });
    expect(low.confidence).toBe(0.0);
  });

  it('accepts valid input', () => {
    const result = validateInsight({ content: 'L-shaped kitchens need wide aisles', confidence: 0.8 });
    expect(result.error).toBeUndefined();
    expect(result.confidence).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/knowledge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write knowledge tool implementation**

Create `src/tools/knowledge.ts`:

```typescript
import type { D1Database } from '@cloudflare/workers-types';

// ─── Query Helpers ────────────────────────────────────────────────────────────

/**
 * Sanitize user input for FTS5 MATCH syntax.
 * Removes special chars, wraps each term in quotes with wildcard suffix.
 */
export function sanitizeFtsQuery(query: string): string {
  const sanitized = query
    .replace(/["\*\(\)\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return '';
  return sanitized
    .split(' ')
    .filter(Boolean)
    .map(term => `"${term}"*`)
    .join(' ');
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateInsight(input: {
  content: string;
  confidence?: number;
}): { error?: string; confidence: number } {
  if (!input.content?.trim()) {
    return { error: 'Insight content is required', confidence: 0 };
  }
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5));
  return { confidence };
}

// ─── Search ───────────────────────────────────────────────────────────────────

interface KnowledgeChunk {
  id: string;
  heading: string;
  content: string;
  room_types: string;
  design_aspects: string;
  source_article_id: number;
  source_article_title: string;
  source_article_url: string;
}

interface AgentInsightRow {
  id: number;
  content: string;
  context: string | null;
  confidence: number;
  stale: number;
}

export async function searchDesignKnowledge(
  db: D1Database,
  query: string,
  options: {
    roomType?: string;
    designAspect?: string;
    includeInsights?: boolean;
    limit?: number;
  } = {},
): Promise<{ chunks: KnowledgeChunk[]; insights: AgentInsightRow[] }> {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return { chunks: [], insights: [] };

  const limit = options.limit ?? 10;
  const roomType = options.roomType ?? null;
  const designAspect = options.designAspect ?? null;

  // Search design_knowledge_fts with optional filters
  const chunkResults = await db.prepare(`
    SELECT
      dk.id,
      dk.heading,
      dk.content,
      dk.room_types,
      dk.design_aspects,
      dk.article_id AS source_article_id,
      dk.article_title AS source_article_title,
      dk.article_url AS source_article_url,
      bm25(design_knowledge_fts) AS rank
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
  `).bind(ftsQuery, roomType, roomType, designAspect, designAspect, limit)
    .all<KnowledgeChunk>();

  const chunks = chunkResults.results;

  // Optionally search agent insights
  let insights: AgentInsightRow[] = [];
  if (options.includeInsights !== false) {
    const insightResults = await db.prepare(`
      SELECT
        ai.id,
        ai.content,
        ai.context,
        ai.confidence,
        ai.stale,
        bm25(agent_insights_fts) AS rank
      FROM agent_insights_fts
      JOIN agent_insights ai ON ai.id = agent_insights_fts.rowid
      WHERE agent_insights_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).bind(ftsQuery, limit)
      .all<AgentInsightRow>();
    insights = insightResults.results;
  }

  return { chunks, insights };
}

// ─── Log Insight ──────────────────────────────────────────────────────────────

export async function logInsight(
  db: D1Database,
  input: {
    content: string;
    context?: string;
    sourceChunkIds?: string[];
    confidence?: number;
  },
): Promise<{ id?: number; error?: string; message?: string }> {
  const validation = validateInsight(input);
  if (validation.error) return { error: validation.error };

  // Verify at least one source chunk exists (if provided)
  const chunkIds = input.sourceChunkIds ?? [];
  if (chunkIds.length > 0) {
    const placeholders = chunkIds.map(() => '?').join(',');
    const found = await db.prepare(
      `SELECT COUNT(*) as cnt FROM design_knowledge WHERE id IN (${placeholders})`
    ).bind(...chunkIds).first<{ cnt: number }>();
    if (!found || found.cnt === 0) {
      return { error: 'None of the referenced chunks exist' };
    }
  }

  try {
    const result = await db.prepare(`
      INSERT INTO agent_insights (content, context, source_chunk_ids, confidence)
      VALUES (?, ?, ?, ?)
    `).bind(
      input.content.trim(),
      input.context?.trim() ?? null,
      JSON.stringify(chunkIds),
      validation.confidence,
    ).run();

    // D1 returns last_row_id on meta
    const id = result.meta?.last_row_id;
    return { id: id ?? undefined, message: 'Insight logged successfully.' };
  } catch {
    return { error: 'Failed to save insight' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "feat: add searchDesignKnowledge and logInsight tool handlers"
```

---

## Task 6: Register MCP Tools — Wire up search_design_knowledge and log_insight

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import for knowledge tools**

At the top of `src/index.ts` (after line 8), add:

```typescript
import { searchDesignKnowledge, logInsight } from './tools/knowledge';
```

- [ ] **Step 2: Register `search_design_knowledge` tool**

Inside the `init()` method of `RoomSketcherHelpMCP`, after the `list_articles` tool registration (after line 234) and before the `// ─── Sketch tools` comment (line 236), add:

```typescript
    // ─── Design Knowledge tools ─────────────────────────────────────────

    this.server.registerTool(
      'search_design_knowledge',
      {
        description:
          'Search extracted design knowledge from RoomSketcher help articles. Returns focused chunks about room layouts, fixture placement, clearance rules, and design patterns — tagged by room type and design aspect. Also returns agent-contributed insights. Use this instead of search_articles when you need specific design guidance.',
        inputSchema: {
          query: z.string().describe('Natural language search query (e.g. "bathroom fixture placement", "kitchen work triangle")'),
          room_type: z.string().optional().describe('Filter by room type: bathroom, kitchen, bedroom, living, dining, hallway, office, outdoor'),
          design_aspect: z.string().optional().describe('Filter by design aspect: clearance, placement, workflow, dimensions, openings, fixtures, materials, color'),
          include_insights: z.boolean().default(true).describe('Include agent-contributed insights in results'),
          limit: z.number().min(1).max(50).default(10).describe('Max results per section'),
        },
      },
      async ({ query, room_type, design_aspect, include_insights, limit }) => {
        const results = await searchDesignKnowledge(this.env.DB, query, {
          roomType: room_type,
          designAspect: design_aspect,
          includeInsights: include_insights,
          limit,
        });

        if (results.chunks.length === 0 && results.insights.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No design knowledge found for "${query}".` }],
          };
        }

        const parts: string[] = [];

        if (results.chunks.length > 0) {
          parts.push('## Design Knowledge\n');
          parts.push(...results.chunks.map((c, i) => [
            `${i + 1}. **${c.heading}**`,
            `   Room types: ${c.room_types}`,
            `   Design aspects: ${c.design_aspects}`,
            `   ${c.content.slice(0, 300)}${c.content.length > 300 ? '...' : ''}`,
            `   Source: [${c.source_article_title}](${c.source_article_url}) (ID: ${c.id})`,
          ].join('\n')));
        }

        if (results.insights.length > 0) {
          parts.push('\n## Agent Insights\n');
          parts.push(...results.insights.map((ins, i) => [
            `${i + 1}. ${ins.content}`,
            ins.context ? `   Context: ${ins.context}` : null,
            `   Confidence: ${ins.confidence}${ins.stale ? ' ⚠️ STALE' : ''}`,
          ].filter(Boolean).join('\n')));
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        };
      },
    );

    this.server.registerTool(
      'log_insight',
      {
        description:
          'Log a design insight or discovery to the shared knowledge base. IMPORTANT: You MUST ask the user for permission before calling this tool. Only store sanitized design knowledge — never include personal details, names, or raw prompts. Insights help future agents find design patterns faster.',
        inputSchema: {
          content: z.string().describe('The insight (e.g. "L-shaped kitchens need 120cm aisle minimum for two-person workflow")'),
          context: z.string().optional().describe('Sanitized design context — what prompted this discovery (no personal data)'),
          source_chunk_ids: z.array(z.string()).optional().describe('IDs of design_knowledge chunks that informed this insight'),
          confidence: z.number().min(0).max(1).default(0.5).describe('Self-rated confidence 0.0-1.0'),
        },
      },
      async ({ content, context, source_chunk_ids, confidence }) => {
        const result = await logInsight(this.env.DB, {
          content,
          context,
          sourceChunkIds: source_chunk_ids,
          confidence,
        });

        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: `✓ Insight logged (ID: ${result.id}). ${result.message}` }],
        };
      },
    );
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register search_design_knowledge and log_insight MCP tools"
```

---

## Task 7: Deploy and Verify

**Files:** None (deployment only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Deploy via deploy script**

Run: `./deploy.sh`
Expected: Deployment succeeds

- [ ] **Step 3: Trigger a sync to populate design_knowledge**

Run: `curl -X POST https://roomsketcher.kworq.com/admin/sync`
Expected: JSON response with `chunks` count > 0

- [ ] **Step 4: Test search_design_knowledge via MCP**

Use the `search_design_knowledge` MCP tool with query "bathroom fixture placement" to verify FTS returns results.

- [ ] **Step 5: Commit any fixes**

If any issues were found during verification, commit fixes.
