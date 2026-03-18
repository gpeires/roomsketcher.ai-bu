import type { D1Database } from '@cloudflare/workers-types';

interface CategoryWithCount {
  id: number;
  name: string;
  description: string | null;
  position: number;
  html_url: string | null;
  article_count: number;
}

interface SectionWithCount {
  id: number;
  name: string;
  description: string | null;
  position: number;
  html_url: string | null;
  category_name: string;
  article_count: number;
}

export async function listCategories(db: D1Database): Promise<CategoryWithCount[]> {
  const results = await db
    .prepare(
      `SELECT
        c.id, c.name, c.description, c.position, c.html_url,
        COUNT(a.id) as article_count
      FROM categories c
      LEFT JOIN sections s ON s.category_id = c.id
      LEFT JOIN articles a ON a.section_id = s.id
      GROUP BY c.id
      ORDER BY c.position`,
    )
    .all<CategoryWithCount>();

  return results.results;
}

export async function listSections(
  db: D1Database,
  categoryId: number,
): Promise<SectionWithCount[]> {
  const results = await db
    .prepare(
      `SELECT
        s.id, s.name, s.description, s.position, s.html_url,
        c.name as category_name,
        COUNT(a.id) as article_count
      FROM sections s
      JOIN categories c ON c.id = s.category_id
      LEFT JOIN articles a ON a.section_id = s.id
      WHERE s.category_id = ?
      GROUP BY s.id
      ORDER BY s.position`,
    )
    .bind(categoryId)
    .all<SectionWithCount>();

  return results.results;
}
