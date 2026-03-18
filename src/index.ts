import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchArticles } from './tools/search';
import { listCategories, listSections } from './tools/browse';
import { listArticles, getArticle, getArticleByUrl } from './tools/articles';
import { syncFromZendesk } from './sync/ingest';
import type { Env } from './types';

export class RoomSketcherHelpMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({
    name: 'roomsketcher-help',
    version: '1.0.0',
    icons: [
      {
        src: 'https://wpmedia.roomsketcher.com/content/uploads/2024/11/20123950/cropped-Figma-Frame-1-32x32.png',
        sizes: ['32x32'],
        mimeType: 'image/png',
      },
      {
        src: 'https://wpmedia.roomsketcher.com/content/uploads/2024/11/20123950/cropped-Figma-Frame-1-192x192.png',
        sizes: ['192x192'],
        mimeType: 'image/png',
      },
    ],
  });

  async init() {
    this.server.registerTool(
      'search_articles',
      {
        description:
          'Search RoomSketcher help articles by keyword or natural language query. Returns ranked results with snippets. Use this to find help content about RoomSketcher features, how-tos, troubleshooting, etc.',
        inputSchema: {
          query: z.string().describe('Search query (e.g. "draw walls", "3D floor plan", "measurements")'),
          limit: z
            .number()
            .min(1)
            .max(50)
            .default(10)
            .describe('Maximum number of results to return'),
        },
      },
      async ({ query, limit }) => {
        const results = await searchArticles(this.env.DB, query, limit);
        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No articles found for "${query}".` }],
          };
        }
        const formatted = results.map((r, i) => [
          `${i + 1}. **${r.title}**`,
          `   Category: ${r.category_name} > ${r.section_name}`,
          `   ${r.snippet}`,
          `   URL: ${r.html_url}`,
        ].join('\n')).join('\n\n');
        return {
          content: [{ type: 'text' as const, text: formatted }],
        };
      },
    );

    this.server.registerTool(
      'get_article',
      {
        description:
          'Get the full content of a specific RoomSketcher help article by its ID. Use this after search_articles to read the complete article text.',
        inputSchema: {
          article_id: z.number().describe('The article ID (from search_articles results or list_articles)'),
        },
      },
      async ({ article_id }) => {
        const article = await getArticle(this.env.DB, article_id);
        if (!article) {
          return {
            content: [{ type: 'text' as const, text: `Article ${article_id} not found.` }],
          };
        }
        const text = [
          `# ${article.title}`,
          `Category: ${article.category_name} > ${article.section_name}`,
          `URL: ${article.html_url}`,
          `Votes: ${article.vote_sum} (${article.vote_count} votes)`,
          `Updated: ${article.updated_at}`,
          '',
          article.body_text || '(No content)',
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text }],
        };
      },
    );

    this.server.registerTool(
      'get_article_by_url',
      {
        description:
          'Look up a RoomSketcher help article by its URL. Useful when you have a link to a specific help page.',
        inputSchema: {
          url: z.string().describe('The help center URL (e.g. "https://help.roomsketcher.com/hc/en-us/articles/...")'),
        },
      },
      async ({ url }) => {
        const article = await getArticleByUrl(this.env.DB, url);
        if (!article) {
          return {
            content: [{ type: 'text' as const, text: `No article found for URL: ${url}` }],
          };
        }
        const text = [
          `# ${article.title}`,
          `Category: ${article.category_name} > ${article.section_name}`,
          `URL: ${article.html_url}`,
          '',
          article.body_text || '(No content)',
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text }],
        };
      },
    );

    this.server.registerTool(
      'list_categories',
      {
        description:
          'List all RoomSketcher help documentation categories. Use this to discover what topics are covered (e.g. "Get Started", "Drawing How Tos", "3D Visualization", etc.).',
        inputSchema: {},
      },
      async () => {
        const categories = await listCategories(this.env.DB);
        if (categories.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No categories found. The database may need to be synced.' }],
          };
        }
        const formatted = categories
          .map((c) => `- **${c.name}** (${c.article_count} articles) — ID: ${c.id}`)
          .join('\n');
        return {
          content: [{ type: 'text' as const, text: formatted }],
        };
      },
    );

    this.server.registerTool(
      'list_sections',
      {
        description:
          'List sections within a specific help category. Use after list_categories to drill into a topic area.',
        inputSchema: {
          category_id: z.number().describe('The category ID (from list_categories)'),
        },
      },
      async ({ category_id }) => {
        const sections = await listSections(this.env.DB, category_id);
        if (sections.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No sections found for category ${category_id}.` }],
          };
        }
        const formatted = sections
          .map((s) => `- **${s.name}** (${s.article_count} articles) — ID: ${s.id}`)
          .join('\n');
        return {
          content: [
            { type: 'text' as const, text: `Sections in ${sections[0].category_name}:\n\n${formatted}` },
          ],
        };
      },
    );

    this.server.registerTool(
      'list_articles',
      {
        description:
          'List articles in a specific help section. Use after list_sections to see available articles, then use get_article to read one.',
        inputSchema: {
          section_id: z.number().describe('The section ID (from list_sections)'),
        },
      },
      async ({ section_id }) => {
        const articles = await listArticles(this.env.DB, section_id);
        if (articles.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No articles found in section ${section_id}.` }],
          };
        }
        const formatted = articles
          .map((a) => `- **${a.title}** (${a.vote_sum} votes) — ID: ${a.id}\n  ${a.html_url}`)
          .join('\n');
        return {
          content: [{ type: 'text' as const, text: formatted }],
        };
      },
    );
  }
}

// Default export: MCP route + admin sync + scheduled sync
const mcpHandler = RoomSketcherHelpMCP.serve('/mcp', { binding: 'MCP_OBJECT' });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return mcpHandler.fetch(request, env, ctx);
    }

    // Manual sync trigger
    if (url.pathname === '/admin/sync' && request.method === 'POST') {
      try {
        const result = await syncFromZendesk(env.DB);
        return Response.json({ ok: true, synced: result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }

    // Health check
    if (url.pathname === '/health') {
      const meta = await env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").first<{ value: string }>();
      return Response.json({
        status: 'ok',
        last_sync: meta?.value || 'never',
      });
    }

    return new Response('RoomSketcher Help MCP Server. Connect via /mcp', { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncFromZendesk(env.DB));
  },
};
