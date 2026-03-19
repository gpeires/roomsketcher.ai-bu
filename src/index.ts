import { McpAgent } from 'agents/mcp';
import { Agent } from 'agents';
import type { Connection, WSMessage } from 'partyserver';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchArticles } from './tools/search';
import { listCategories, listSections } from './tools/browse';
import { listArticles, getArticle, getArticleByUrl } from './tools/articles';
import { searchDesignKnowledge, logInsight } from './tools/knowledge';
import { syncFromZendesk } from './sync/ingest';
import type { Env, SketchSession, SessionCTAState } from './types';
import { FloorPlanSchema, FloorPlanInputSchema, ChangeSchema } from './sketch/types';
import type { ClientMessage, Change } from './sketch/types';
import { handleGenerateFloorPlan, handleGetSketch, handleOpenSketcher, handleUpdateSketch, handleSuggestImprovements, handleExportSketch, handlePreviewSketch } from './sketch/tools';
import type { ToolContext } from './sketch/tools';
import { cleanupExpiredSketches, loadSketch, saveSketch } from './sketch/persistence';
import { applyChanges } from './sketch/changes';
import { floorPlanToSvg } from './sketch/svg';
import { sketcherHtml } from './sketcher/html';
import { setupHtml } from './setup/html';
import { homeHtml } from './setup/home';
import studioTpl from './sketch/templates/studio.json';
import onebrTpl from './sketch/templates/1br-apartment.json';
import twobrTpl from './sketch/templates/2br-apartment.json';
import threebrTpl from './sketch/templates/3br-house.json';
import loftTpl from './sketch/templates/open-plan-loft.json';
import lshapedTpl from './sketch/templates/l-shaped-home.json';

export class RoomSketcherHelpMCP extends McpAgent<Env, SketchSession, {}> {
  private _workerOrigin: string | null = null;

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

  private getCtaState(): SessionCTAState {
    const cta = (this.state ?? {}).cta ?? { ctasShown: 0, lastCtaAt: 0, toolCallCount: 0 };
    cta.toolCallCount++;
    return cta;
  }

  private buildCtx(overrides?: { broadcast?: (msg: string) => void | Promise<void> }): ToolContext {
    const ctaState = this.getCtaState();
    return {
      db: this.env.DB,
      state: this.state ?? {},
      setState: (s) => { this.setState({ ...s, cta: ctaState }); },
      workerUrl: this.getWorkerUrl(),
      ctaVariant: this.env.CTA_VARIANT ?? 'default',
      ctaState,
      updateCta: (cta) => { this.setState({ ...(this.state ?? {}), cta }); },
      ...overrides,
    };
  }

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

    // ─── Design Knowledge tools ─────────────────────────────────────────

    this.server.registerTool(
      'search_design_knowledge',
      {
        description:
          'Search extracted design knowledge from RoomSketcher help articles. Returns focused chunks about room layouts, fixture placement, clearance rules, and design patterns — tagged by room type and design aspect. Also returns agent-contributed insights. Use this instead of search_articles when you need specific design guidance. Best used: before generating a floor plan (for room-specific standards) and when suggest_improvements reveals issues (for targeted solutions).',
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
            `   ${c.content.slice(0, 600)}${c.content.length > 600 ? '...' : ''}`,
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
          content: [{ type: 'text' as const, text: `Insight logged (ID: ${result.id}). ${result.message}` }],
        };
      },
    );

    // ─── Sketch tools ─────────────────────────────────────────────────────

    this.server.registerTool(
      'generate_floor_plan',
      {
        description: `Generate a complete floor plan from a description. Returns a furnished plan with SVG preview.

IMPORTANT: If a sketch already exists in this conversation (the user already has a sketch_id), do NOT call this tool. Use update_sketch instead to modify the existing plan. Only use generate_floor_plan when creating a brand-new floor plan from scratch.

WORKFLOW: Always start from a template. Call list_templates to find the closest match, then adapt dimensions, rooms, openings, and furniture. Never generate coordinates from a blank canvas. For best results, call search_design_knowledge with relevant room types first to apply professional clearance rules and layout patterns.

STANDARD DIMENSIONS (cm):
- Exterior walls: 20 thick. Interior: 10. Divider: 5.
- Ceiling height: 250
- Min room sizes: bedroom 9sqm, bathroom 4sqm, kitchen 6sqm, living 15sqm
- Hallway min width: 100
- Doors: standard 80, bathroom 70, front 90
- Windows: standard 120, kitchen 100, bathroom 60

COLOR PALETTE (hex by room type):
living: #E8F5E9  bedroom: #E3F2FD  kitchen: #FFF3E0  bathroom: #E0F7FA
hallway: #F5F5F5  office: #F3E5F5  dining: #FFF8E1  garage: #EFEBE9
closet: #ECEFF1  laundry: #E8EAF6  balcony: #F1F8E9  terrace: #F1F8E9
storage: #ECEFF1  utility: #ECEFF1  other: #FAFAFA

DOOR RULES: Every room gets a door. Front door on the longest exterior wall. Bathroom doors swing outward (left). Bedroom doors swing inward (right).

FURNITURE: Place essential furniture in every room using the furniture catalog items. Arrange along walls with 60cm walking clearance between items. Use catalog dimensions (width/depth in cm).

COORDINATE SYSTEM: Origin (0,0) top-left. X right, Y down. All values in cm. 10cm grid.

Provide a name and description. The system will fill in defaults for wall thickness, height, room colors, canvas size, and metadata if omitted.

VISUAL FEEDBACK LOOP (required):
After generating, call preview_sketch to see what you actually built. Inspect the image for overlapping walls, misplaced furniture, missing doors/windows, rooms that look wrong. If you see issues, fix them with update_sketch and preview again. Iterate until the plan looks correct — do NOT show the user a plan you haven't visually verified.

How many iterations: If the user provided a reference image or detailed measurements, 1 preview check is usually enough. If building from a vague description ("make me a 2BR apartment"), expect 1-2 rounds of fixes. Keep it under 3 iterations total — the user shouldn't wait more than ~30 seconds for the feedback loop.`,
        inputSchema: {
          plan: FloorPlanInputSchema.describe('The complete FloorPlan JSON object'),
        },
      },
      async ({ plan }) => {
        return handleGenerateFloorPlan(plan, this.buildCtx());
      },
    );

    this.server.registerTool(
      'get_sketch',
      {
        description: 'Get the current state of a sketch (floor plan JSON + SVG render). Use this after the user has edited in the browser sketcher to see their changes.',
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
        },
      },
      async ({ sketch_id }) => {
        return handleGetSketch(sketch_id, this.buildCtx());
      },
    );

    this.server.registerTool(
      'open_sketcher',
      {
        description: 'Get the URL for the browser-based sketcher to manually edit a floor plan.',
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
        },
      },
      async ({ sketch_id }) => {
        return handleOpenSketcher(sketch_id, this.getWorkerUrl());
      },
    );

    this.server.registerTool(
      'update_sketch',
      {
        description: `Push modifications to an existing sketch. PREFER THIS over generate_floor_plan when the user already has a sketch open — use get_sketch to read current state, then apply incremental changes. Supports: add/move/remove walls, add/remove openings, add/rename/remove rooms, add/move/remove furniture. Changes are applied in order and broadcast to the browser sketcher in real-time.

VISUAL FEEDBACK: After applying changes, call preview_sketch to verify the result visually. Look for regressions — moving a wall can break furniture placement or overlap with openings. If the change was cosmetic (renaming a room, adjusting a label), you can skip the preview. For structural changes (walls, openings, room boundaries), always preview. Use suggest_improvements for a deeper analysis when the user asks for feedback or when you spot issues you're unsure about.`,
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
          changes: z.array(ChangeSchema).describe('Array of changes to apply'),
        },
      },
      async ({ sketch_id, changes }) => {
        return handleUpdateSketch(sketch_id, changes, this.buildCtx({
          broadcast: async (msg) => {
            const id = this.env.SKETCH_SYNC.idFromName(sketch_id);
            const obj = this.env.SKETCH_SYNC.get(id);
            await obj.fetch(new Request('http://internal/broadcast', {
              method: 'POST',
              body: msg,
            }));
          },
        }));
      },
    );

    this.server.registerTool(
      'suggest_improvements',
      {
        description: 'Analyze the current floor plan and return structured spatial data plus room-specific design knowledge from RoomSketcher professional guidelines. Includes clearance rules, placement patterns, and workflow tips per room type. Use this after generating or modifying a plan to evaluate proportions, traffic flow, furniture fit, and overall livability.',
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
        },
      },
      async ({ sketch_id }) => {
        return handleSuggestImprovements(sketch_id, this.buildCtx());
      },
    );

    this.server.registerTool(
      'export_sketch',
      {
        description: 'Export a sketch in various formats (SVG image, PDF download link, or text summary). Includes links to upgrade to RoomSketcher for 3D and professional features.',
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
          format: z.enum(['svg', 'pdf', 'summary']).default('svg').describe('Export format'),
        },
      },
      async ({ sketch_id, format }) => {
        return handleExportSketch(sketch_id, format, this.buildCtx());
      },
    );

    this.server.registerTool(
      'preview_sketch',
      {
        description: `Get a visual PNG preview of a floor plan. Returns the rendered floor plan as a PNG image showing rooms, walls, furniture, dimensions, and labels.

PURPOSE: This is your eyes. Use it to verify what you built before presenting to the user. When reviewing the image, check for: (1) walls that overlap or leave gaps, (2) furniture placed outside rooms or overlapping each other, (3) doors/windows missing or in wrong positions, (4) rooms that are too small or oddly shaped, (5) labels that overlap or are unreadable. If you spot issues, fix them with update_sketch and preview again.`,
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
        },
      },
      async ({ sketch_id }) => {
        return handlePreviewSketch(sketch_id, this.buildCtx());
      },
    );

    // ─── Template tools ──────────────────────────────────────────────────

    this.server.registerTool(
      'list_templates',
      {
        description: 'List available floor plan templates. Use this to find a starting point before generating a floor plan. Always start from the nearest template rather than building coordinates from scratch.',
        inputSchema: {},
      },
      async () => {
        const templates = [
          { id: 'studio', description: 'Studio apartment — open plan with bathroom', rooms: '1 + bathroom', size: '35-45 sqm' },
          { id: '1br-apartment', description: '1-bedroom apartment — living, bedroom, bathroom, hallway', rooms: '3 + hallway', size: '50-65 sqm' },
          { id: '2br-apartment', description: '2-bedroom apartment — living, kitchen, 2 bedrooms, bathroom', rooms: '5 + hallway', size: '70-90 sqm' },
          { id: '3br-house', description: '3-bedroom house — living, kitchen, dining, 3 bedrooms, 2 bathrooms', rooms: '7+', size: '110-140 sqm' },
          { id: 'open-plan-loft', description: 'Open plan loft — minimal walls, large windows, zones defined by furniture', rooms: '1 + bathroom', size: '60-80 sqm' },
          { id: 'l-shaped-home', description: 'L-shaped home — two wings at 90 degrees, non-rectangular', rooms: '5+', size: '90-120 sqm' },
        ];
        const text = templates.map(t =>
          `- **${t.id}**: ${t.description} (${t.rooms}, ${t.size})`
        ).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      },
    );

    this.server.registerTool(
      'get_template',
      {
        description: 'Get a floor plan template by ID. Returns complete FloorPlan JSON you can adapt and pass to generate_floor_plan. Modify dimensions, add/remove rooms, reposition furniture to match the user\'s request.',
        inputSchema: {
          template_id: z.string().describe('Template ID from list_templates (e.g. "2br-apartment")'),
        },
      },
      async ({ template_id }) => {
        const templates: Record<string, unknown> = {
          'studio': studioTpl,
          '1br-apartment': onebrTpl,
          '2br-apartment': twobrTpl,
          '3br-house': threebrTpl,
          'open-plan-loft': loftTpl,
          'l-shaped-home': lshapedTpl,
        };
        const tpl = templates[template_id];
        if (!tpl) {
          return { content: [{ type: 'text' as const, text: `Unknown template: ${template_id}. Use list_templates to see available options.` }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(tpl, null, 2) }] };
      },
    );
  }

  async onRequest(request: Request): Promise<Response> {
    const fwdProto = request.headers.get('x-forwarded-proto') ?? 'https';
    const fwdHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (fwdHost) {
      this._workerOrigin = `${fwdProto}://${fwdHost}`;
    } else {
      this._workerOrigin = new URL(request.url).origin;
    }
    return super.onRequest(request);
  }

  private getWorkerUrl(): string {
    return this._workerOrigin ?? this.env.WORKER_URL;
  }

}

// ─── Sketch Sync Durable Object ──────────────────────────────────────────────
// Separate DO for sketch WebSocket sync — McpAgent requires transport-prefixed
// names (sse:xxx, streamable-http:xxx) so sketch connections can't share it.

export class SketchSync extends Agent<Env, SketchSession> {
  private dirty = false;

  // Use our own WebSocket protocol, not the Agent framework's state sync
  shouldSendProtocolMessages() { return false; }

  // Internal endpoint for MCP DO to trigger broadcasts
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const msg = await request.text();
      // Also update our local state from the broadcast payload
      try {
        const data = JSON.parse(msg);
        if (data.type === 'state_update' && data.plan) {
          const sketchId = this.state?.sketchId;
          if (sketchId) this.setState({ sketchId, plan: data.plan });
        }
      } catch { /* ignore */ }
      // Broadcast to ALL connected WebSocket clients via the Agent framework
      for (const conn of this.getConnections()) {
        try { conn.send(msg); } catch { /* ignore dead connections */ }
      }
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== 'string') return;
    try {
      const data = JSON.parse(message);
      if (data.type) {
        await this.handleSketchMessage(connection, data as ClientMessage);
      }
    } catch {
      // ignore non-JSON
    }
  }

  async onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean) {
    // If last client disconnected and changes were made, flush to D1
    const connections = [...this.getConnections()];
    if (connections.length === 0 && this.dirty && this.state?.plan && this.state?.sketchId) {
      const svg = floorPlanToSvg(this.state.plan);
      await saveSketch(this.env.DB, this.state.sketchId, this.state.plan, svg);
      this.dirty = false;
    }
  }

  private async handleSketchMessage(sender: Connection, msg: ClientMessage) {
    if (msg.type === 'load') {
      let plan = this.state?.plan;
      if (!plan && msg.sketch_id) {
        const loaded = await loadSketch(this.env.DB, msg.sketch_id);
        if (loaded) {
          plan = loaded.plan;
          this.setState({ sketchId: msg.sketch_id, plan });
        }
      }
      if (plan) {
        sender.send(JSON.stringify({ type: 'state_update', plan }));
      }
      return;
    }

    if (msg.type === 'save') {
      if (this.state?.plan && this.state?.sketchId) {
        const svg = floorPlanToSvg(this.state.plan);
        await saveSketch(this.env.DB, this.state.sketchId, this.state.plan, svg);
        this.dirty = false;
        this.broadcastToClients(JSON.stringify({
          type: 'saved', updated_at: new Date().toISOString(),
        }));
      }
      return;
    }

    // It's a Change — apply it
    if (!this.state?.plan) {
      if (this.state?.sketchId) {
        const loaded = await loadSketch(this.env.DB, this.state.sketchId);
        if (loaded) this.setState({ sketchId: this.state.sketchId, plan: loaded.plan });
      }
    }

    if (this.state?.plan) {
      const updated = applyChanges(this.state.plan, [msg as Change]);
      this.setState({ ...this.state, plan: updated });
      this.dirty = true;
      this.broadcastToClients(JSON.stringify({ type: 'state_update', plan: updated }));
    }
  }

  private broadcastToClients(message: string) {
    for (const conn of this.getConnections()) {
      try { conn.send(message); } catch { /* ignore dead connections */ }
    }
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

    // Home page
    if (url.pathname === '/') {
      return new Response(homeHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Setup / onboarding page
    if (url.pathname === '/setup') {
      const workerUrl = env.WORKER_URL || url.origin;
      return new Response(setupHtml(`${workerUrl}/mcp`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Health check
    if (url.pathname === '/health') {
      const meta = await env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").first<{ value: string }>();
      return Response.json({
        status: 'ok',
        last_sync: meta?.value || 'never',
      });
    }

    // WebSocket upgrade for real-time sketch sync
    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const sketchId = wsMatch[1];
      const id = env.SKETCH_SYNC.idFromName(sketchId);
      const obj = env.SKETCH_SYNC.get(id);
      // PartyServer requires x-partykit-room header to identify the room
      const headers = new Headers(request.headers);
      headers.set('x-partykit-room', sketchId);
      const proxied = new Request(request.url, { method: request.method, headers, body: request.body });
      return obj.fetch(proxied);
    }

    // PNG preview
    const pngMatch = url.pathname.match(/^\/api\/sketches\/([A-Za-z0-9_-]+)\/preview\.png$/);
    if (pngMatch && request.method === 'GET') {
      const { svgToPng } = await import('./sketch/rasterize');
      const sketchId = pngMatch[1];
      const loaded = await loadSketch(env.DB, sketchId);
      if (!loaded) return Response.json({ error: 'Not found' }, { status: 404 });

      const svg = loaded.svg ?? floorPlanToSvg(loaded.plan);
      const png = await svgToPng(svg, 1200);
      return new Response(png, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    // PDF/SVG export
    const pdfMatch = url.pathname.match(/^\/api\/sketches\/([A-Za-z0-9_-]+)\/export\.pdf$/);
    if (pdfMatch && request.method === 'GET') {
      const sketchId = pdfMatch[1];
      const loaded = await loadSketch(env.DB, sketchId);
      if (!loaded) return Response.json({ error: 'Not found' }, { status: 404 });

      const svg = loaded.svg ?? floorPlanToSvg(loaded.plan);
      return new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Disposition': `attachment; filename="${loaded.plan.name || 'floor-plan'}.svg"`,
        },
      });
    }

    // Sketcher SPA
    const sketcherMatch = url.pathname.match(/^\/sketcher\/([A-Za-z0-9_-]+)$/);
    if (sketcherMatch) {
      return new Response(
        sketcherHtml(sketcherMatch[1]),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }

    // Sketch REST API
    const sketchMatch = url.pathname.match(/^\/api\/sketches\/([A-Za-z0-9_-]+)$/);
    if (sketchMatch) {
      const sketchId = sketchMatch[1];

      if (request.method === 'GET') {
        const loaded = await loadSketch(env.DB, sketchId);
        if (!loaded) {
          return Response.json({ error: 'Not found' }, { status: 404 });
        }
        return Response.json({ plan: loaded.plan, svg: loaded.svg });
      }

      if (request.method === 'PUT') {
        let body: { plan: unknown };
        try { body = await request.json() as { plan: unknown }; }
        catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
        const parsed = FloorPlanSchema.safeParse(body.plan);
        if (!parsed.success) {
          return Response.json({ error: 'Invalid plan', issues: parsed.error.issues }, { status: 400 });
        }
        const svg = floorPlanToSvg(parsed.data);
        await saveSketch(env.DB, sketchId, parsed.data, svg);
        return Response.json({ ok: true, updated_at: new Date().toISOString() });
      }
    }

    return new Response('RoomSketcher Help MCP Server. Connect via /mcp', { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncFromZendesk(env.DB));
    ctx.waitUntil(cleanupExpiredSketches(env.DB));
  },
};
