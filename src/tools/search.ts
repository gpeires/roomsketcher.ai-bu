import type { D1Database } from '@cloudflare/workers-types';

interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  html_url: string;
  section_name: string;
  category_name: string;
  vote_sum: number;
  rank: number;
}

export async function searchArticles(
  db: D1Database,
  query: string,
  limit: number = 10,
): Promise<SearchResult[]> {
  // Sanitize the query for FTS5: remove special characters that could break the query
  const sanitized = query
    .replace(/["\*\(\)\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return [];
  }

  // Add wildcard suffix for partial matching
  const ftsQuery = sanitized
    .split(' ')
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' ');

  const results = await db
    .prepare(
      `SELECT
        a.id,
        a.title,
        snippet(articles_fts, 1, '**', '**', '...', 40) as snippet,
        a.html_url,
        a.vote_sum,
        s.name as section_name,
        c.name as category_name,
        bm25(articles_fts, 5.0, 1.0) as rank
      FROM articles_fts
      JOIN articles a ON a.id = articles_fts.rowid
      JOIN sections s ON s.id = a.section_id
      JOIN categories c ON c.id = s.category_id
      WHERE articles_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    )
    .bind(ftsQuery, limit)
    .all<SearchResult>();

  return results.results;
}
