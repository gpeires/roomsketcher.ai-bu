import type { D1Database } from '@cloudflare/workers-types';
import { sanitizeFtsQuery } from './fts';

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
  const chunkQuery = db.prepare(`
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

  // Run both FTS queries in parallel
  const insightQuery = options.includeInsights !== false
    ? db.prepare(`
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
      `).bind(ftsQuery, limit).all<AgentInsightRow>()
    : null;

  const [chunkResults, insightResults] = await Promise.all([
    chunkQuery,
    insightQuery,
  ]);

  return {
    chunks: chunkResults.results,
    insights: insightResults?.results ?? [],
  };
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
    return { id: result.meta?.last_row_id, message: 'Insight logged successfully.' };
  } catch (err) {
    console.error('Failed to log insight:', err);
    return { error: 'Failed to save insight' };
  }
}
