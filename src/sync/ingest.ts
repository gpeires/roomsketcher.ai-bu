import type { Env, ZendeskArticle } from '../types';
import { fetchCategories, fetchSections, fetchArticles } from './zendesk';
import { htmlToText } from './html-to-text';

export async function syncFromZendesk(db: D1Database): Promise<{ categories: number; sections: number; articles: number }> {
  const [categories, sections, articles] = await Promise.all([
    fetchCategories(),
    fetchSections(),
    fetchArticles(),
  ]);

  // Filter out drafts
  const publishedArticles = articles.filter((a) => !a.draft);

  // Clear existing data (order matters for FK constraints)
  // FTS triggers handle cleanup automatically
  await db.prepare('DELETE FROM articles').run();
  await db.prepare('DELETE FROM sections').run();
  await db.prepare('DELETE FROM categories').run();

  // Batch insert using D1 batch API
  const categoryStmts = categories.map((cat) =>
    db
      .prepare(
        `INSERT INTO categories (id, name, description, position, html_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(cat.id, cat.name, cat.description || null, cat.position, cat.html_url, cat.updated_at),
  );

  const sectionStmts = sections.map((sec) =>
    db
      .prepare(
        `INSERT INTO sections (id, category_id, name, description, position, html_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(sec.id, sec.category_id, sec.name, sec.description || null, sec.position, sec.html_url, sec.updated_at),
  );

  const articleStmts = publishedArticles.map((article) => {
    const bodyText = htmlToText(article.body || '');
    return db
      .prepare(
        `INSERT INTO articles (id, section_id, title, body_html, body_text, html_url, position, vote_sum, vote_count, promoted, draft, label_names, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        article.id,
        article.section_id,
        article.title,
        article.body,
        bodyText,
        article.html_url,
        article.position,
        article.vote_sum,
        article.vote_count,
        article.promoted ? 1 : 0,
        article.draft ? 1 : 0,
        JSON.stringify(article.label_names),
        article.created_at,
        article.updated_at,
      );
  });

  // Execute in batches (D1 batch runs as a single transaction)
  await db.batch(categoryStmts);
  await db.batch(sectionStmts);
  await db.batch(articleStmts);

  // Update sync metadata
  await db
    .prepare(`INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync', ?)`)
    .bind(new Date().toISOString())
    .run();

  return {
    categories: categories.length,
    sections: sections.length,
    articles: publishedArticles.length,
  };
}
