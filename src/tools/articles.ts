import type { D1Database } from '@cloudflare/workers-types';

interface ArticleSummary {
  id: number;
  title: string;
  html_url: string | null;
  vote_sum: number;
  position: number;
}

interface ArticleFull {
  id: number;
  title: string;
  body_text: string | null;
  html_url: string | null;
  section_name: string;
  category_name: string;
  vote_sum: number;
  vote_count: number;
  label_names: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function listArticles(
  db: D1Database,
  sectionId: number,
): Promise<ArticleSummary[]> {
  const results = await db
    .prepare(
      `SELECT id, title, html_url, vote_sum, position
       FROM articles
       WHERE section_id = ?
       ORDER BY position`,
    )
    .bind(sectionId)
    .all<ArticleSummary>();

  return results.results;
}

export async function getArticle(
  db: D1Database,
  articleId: number,
): Promise<ArticleFull | null> {
  const result = await db
    .prepare(
      `SELECT
        a.id, a.title, a.body_text, a.html_url,
        a.vote_sum, a.vote_count, a.label_names,
        a.created_at, a.updated_at,
        s.name as section_name,
        c.name as category_name
      FROM articles a
      JOIN sections s ON s.id = a.section_id
      JOIN categories c ON c.id = s.category_id
      WHERE a.id = ?`,
    )
    .bind(articleId)
    .first<ArticleFull>();

  return result;
}

export async function getArticleByUrl(
  db: D1Database,
  url: string,
): Promise<ArticleFull | null> {
  // Normalize URL: strip trailing slash, query params, fragments
  const normalized = url.split('?')[0].split('#')[0].replace(/\/$/, '');

  const result = await db
    .prepare(
      `SELECT
        a.id, a.title, a.body_text, a.html_url,
        a.vote_sum, a.vote_count, a.label_names,
        a.created_at, a.updated_at,
        s.name as section_name,
        c.name as category_name
      FROM articles a
      JOIN sections s ON s.id = a.section_id
      JOIN categories c ON c.id = s.category_id
      WHERE a.html_url LIKE ?`,
    )
    .bind(`%${normalized}%`)
    .first<ArticleFull>();

  return result;
}
