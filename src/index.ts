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
import { FloorPlanSchema, SimpleFloorPlanInputSchema, ChangeSchema } from './sketch/types';
import type { FloorPlan } from './sketch/types';
import { totalArea } from './sketch/geometry';
import type { ClientMessage, Change } from './sketch/types';
import { handleGenerateFloorPlan, handleGetSketch, handleOpenSketcher, handleUpdateSketch, handleSuggestImprovements, handleExportSketch, handlePreviewSketch, handleAnalyzeImage } from './sketch/tools';
import type { ToolContext } from './sketch/tools';
import { cleanupExpiredSketches, loadSketch, saveSketch } from './sketch/persistence';
import { applyChanges } from './sketch/changes';
import { floorPlanToSvg } from './sketch/svg';
import { sketcherHtml } from './sketcher/html';
import { setupHtml } from './setup/html';
import { homeHtml } from './setup/home';
import { uploadHtml } from './setup/upload';
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
        description: `Generate a floor plan. Returns a plan with SVG preview.

IMPORTANT: If a sketch already exists in this conversation (the user already has a sketch_id), do NOT call this tool. Use update_sketch instead to modify the existing plan. Only use generate_floor_plan when creating a brand-new floor plan from scratch.

CHOOSE YOUR WORKFLOW — pick ONE based on what the user gave you:

═══ COPY MODE (user provided a reference floor plan image) ═══
Your job is REPLICATION. Do NOT call list_templates or search_design_knowledge. Use the ROOM-FIRST INPUT FORMAT — the system generates walls, polygons, and colors automatically.

COPY MODE REQUIRES CV ANALYSIS. No exceptions, no workarounds. The server will REJECT generate_floor_plan calls with 3+ rooms if you haven't run CV analysis first.
- User provided a URL → call analyze_floor_plan_image with it.
- User pasted/attached an image (no URL) → call upload_image to get the upload page link, send it to the user, and WAIT for them to give you the URL.
- There is ZERO reason to skip CV analysis or read dimensions by eye.

Step 1: ANALYZE — Get the image URL (ask user to upload if needed), then call analyze_floor_plan_image. Quickly note rooms, scale, outline. Do NOT write a lengthy analysis.

Step 1b (ONLY IF NEEDED): If the outline has way too many vertices for the building shape (e.g., 14 for a rectangle), re-call with higher outline_epsilon.

Step 2: BUILD ALL ROOMS — Call generate_floor_plan with ALL rooms. Start from CV rooms, add any the CV missed. Rooms only — no furniture, no openings beyond obvious ones. Be fast, not perfect.

Step 3: PREVIEW IMMEDIATELY — Call preview_sketch RIGHT AFTER generating. This is your most valuable tool — it shows your sketch next to the source image. You are BLIND until you preview. Do NOT write a lengthy plan or analysis before previewing. Get visual feedback ASAP.

Step 4: FIX VISUALLY — Look at the side-by-side preview. Fix the single biggest discrepancy using update_sketch with high_level_changes. Preview again. Repeat until the layout matches.
  "Kitchen is 30cm too narrow" → {type: "resize_room", room: "Kitchen", side: "east", delta_cm: 30}
  "Missing a closet" → {type: "add_room", label: "Closet", room_type: "closet", rect: {...}}
  Do NOT regenerate the entire layout to fix one room. Do NOT batch multiple fixes without previewing between them.

Step 5: ADD OPENINGS — Doors and windows via high_level_changes. Preview to verify.

Step 6: ADD FURNITURE — Place furniture visible in the reference. Preview to verify.

PRESERVE ARCHITECTURAL DETAILS: Real apartments have walls that jut out, structural setbacks, non-rectangular foyers. A slightly irregular polygon that matches the source is BETTER than a clean rectangle that doesn't. Use polygon input when rooms aren't rectangular.

WORKED EXAMPLE — 2 rooms side by side:
Input: {name: "Test", rooms: [{label: "Kitchen", x: 0, y: 0, width: 300, depth: 250}, {label: "Living", x: 300, y: 0, width: 400, depth: 300}], openings: [{type: "door", between: ["Kitchen", "Living"]}, {type: "window", room: "Kitchen", wall: "north"}]}
Result: Interior wall at x=300 between the rooms, exterior walls around the perimeter, door centered on shared wall, window centered on Kitchen's north wall.

═══ DESIGN MODE (user described a floor plan in words) ═══

PHASE 1 — GET THE LAYOUT VISIBLE FAST:

Step 1: Find a starting point. Call list_templates, pick the closest match, and adapt room sizes to the user's description. For best results, call search_design_knowledge first.

Step 2: GENERATE ROOMS ONLY — Call generate_floor_plan with rooms and basic openings. Do NOT add furniture yet. Get the skeleton built.

Step 3: PREVIEW IMMEDIATELY — Call preview_sketch right after generating. You are BLIND until you see the rendered output. Check: are rooms the right size? Is the layout sensible? Does it match what the user asked for?

PHASE 2 — REFINE BASED ON WHAT YOU SEE:

Step 4: FIX LAYOUT — If rooms are wrong, fix with update_sketch. Preview again.

Step 5: ADD OPENINGS — Add remaining doors/windows. Every room needs a door. Front door on the longest exterior wall. Bathroom doors swing outward (left). Bedroom doors swing inward (right). Preview to verify.

Step 6: ADD FURNITURE — Place essential furniture in every room. Arrange along walls with 60cm clearance. Preview to verify.

STANDARD DIMENSIONS (cm):
- Doors: standard 80, bathroom 70, front 90
- Windows: standard 120, kitchen 100, bathroom 60
- Min room sizes: bedroom 9sqm, bathroom 4sqm, kitchen 6sqm, living 15sqm

═══ SHARED RULES (both modes) ═══

COORDINATE SYSTEM: Origin (0,0) top-left. X right, Y down. All values in cm. 10cm grid.

The system auto-generates: walls (exterior=20cm, interior=10cm), room polygons, room colors (by label keyword), canvas size, and metadata.

CRITICAL: Do NOT skip preview_sketch after generating. You have no idea if your output is correct until you see the rasterized result. Preview early, preview often.`,
        inputSchema: {
          plan: SimpleFloorPlanInputSchema.describe('Room-first floor plan input (recommended). Also accepts full FloorPlanInput with version/walls/rooms.'),
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
        // Try to get live state from the DO first (browser edits may not be in D1 yet)
        let liveConnections = 0;
        let liveChanges: { type: string; timestamp: string; summary: string }[] = [];
        try {
          const syncId = this.env.SKETCH_SYNC.idFromName(sketch_id);
          const syncObj = this.env.SKETCH_SYNC.get(syncId);

          // Check for live in-memory state
          const stateRes = await syncObj.fetch(new Request('http://internal/state'));
          const stateData = await stateRes.json() as { plan: FloorPlan | null; connections?: number };
          if (stateData.plan) {
            // Use the live plan — it has all browser edits applied
            const plan = stateData.plan;
            liveConnections = stateData.connections ?? 0;
            const summary = [
              `**${plan.name}**`,
              `${plan.walls.length} walls, ${plan.rooms.length} rooms`,
              `Rooms: ${plan.rooms.map((r: any) => `${r.label} (${(r.area ?? 0).toFixed(1)} m\u00B2)`).join(', ')}`,
              `Total area: ${totalArea(plan.rooms).toFixed(1)} m\u00B2`,
              `Source: ${plan.metadata.source}`,
              `Updated: ${plan.metadata.updated_at}`,
            ].join('\n');

            // Get change log
            const changesRes = await syncObj.fetch(new Request('http://internal/changes'));
            const changesData = await changesRes.json() as { changes: typeof liveChanges; connections: number };
            liveChanges = changesData.changes;
            liveConnections = changesData.connections;

            const lines = [`\n---\n**Live status:** ${liveConnections} browser(s) connected`];
            if (liveChanges.length > 0) {
              lines.push(`**Recent browser edits** (${liveChanges.length}):`);
              for (const c of liveChanges.slice(-10)) {
                lines.push(`  ${c.timestamp.slice(11, 19)} ${c.summary}`);
              }
            }
            return { content: [{ type: 'text' as const, text: summary + lines.join('\n') }] };
          }
        } catch { /* SketchSync not available, fall through to D1 */ }

        // No live state — read from D1
        const result = await handleGetSketch(sketch_id, this.buildCtx());
        return result;
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
      'analyze_floor_plan_image',
      {
        description: `Analyze a floor plan image using computer vision to extract PRECISE room geometries, pixel-accurate dimensions, wall positions, and text labels. Returns structured JSON that is FAR more accurate than what you can estimate by looking at an image.

WHY THIS TOOL IS MANDATORY: You cannot accurately estimate room dimensions, wall coordinates, or spatial relationships by looking at an image. The CV pipeline uses edge detection, OCR, and geometric analysis to extract exact measurements in centimeters. Skipping this step and eyeballing the image will produce inaccurate floor plans with wrong room sizes and positions. NEVER skip this tool when the user provides a floor plan image.

TRIGGER RULES — act IMMEDIATELY based on what the user gave you:

1. USER PROVIDED A URL/LINK to an image → Call this tool RIGHT NOW with that URL as image_url.

2. USER PASTED/ATTACHED AN IMAGE in the chat (no URL) → Call upload_image to get the upload page link. Send it to the user and WAIT for them to paste back the URL. Do NOT read dimensions by eye.

OUTLINE FEEDBACK LOOP: After the first analysis, compare the building outline vertices to what you see in the image. If the outline has too many vertices for the building shape (e.g., 14 vertices for a simple rectangle that should have 4-6), re-call this tool with a higher outline_epsilon (try 0.03, then 0.04). The building shape tells you the expected vertex count: rectangle=4, L-shape=6, T-shape=8, U-shape=8. Keep the outline_epsilon below 0.05 to avoid over-simplification.

CV DATA IS ADVISORY: The CV pipeline provides measured geometry extracted by computer vision. Use it as expert input, but YOU are the authority on what rooms exist and how they're arranged.

TRUST CV FOR: scale (cm/px ratio), wall thickness, building outline polygon
TRUST YOUR EYES FOR: room count, room labels, printed dimensions, spatial relationships

When CV and your visual understanding disagree:
- State what CV says vs what you see
- Explain why you're following your interpretation
- Example: "CV detected 5 rooms but I can see 9 labeled rooms. I'll use CV scale but place all 9 rooms from printed dimensions."`,
        inputSchema: {
          image: z.string().optional().describe('Base64-encoded floor plan image (PNG or JPG) — only for small images; prefer image_url via /upload'),
          image_url: z.string().optional().describe('URL to a floor plan image — the server will fetch it'),
          name: z.string().optional().describe('Name for the floor plan'),
          outline_epsilon: z.number().optional().describe('Override outline simplification aggressiveness (default 0.015, higher=fewer vertices). Use this in a feedback loop: if the first analysis produces too many outline vertices, re-call with a higher epsilon (e.g. 0.03-0.05) to simplify.'),
          include_grid: z.boolean().optional().describe('Include the ASCII spatial grid in the response (default: false). The grid shows a 30cm-cell map of room placement. Most agents find the JSON room coordinates more actionable — only enable this if you need a spatial overview that the JSON alone doesn\'t give you.'),
        },
      },
      async ({ image, image_url, name, outline_epsilon, include_grid }) => {
        const cvUrl = this.env.CV_SERVICE_URL || 'http://localhost:8100';
        const result = await handleAnalyzeImage({ image, image_url, outline_epsilon, include_grid }, name || 'Extracted Floor Plan', cvUrl, this.env.AI, this.env.DB, this.getWorkerUrl());
        // Store source image URL + CV analysis flag in session
        if (image_url) {
          this.setState({ ...(this.state ?? {}), sourceImageUrl: image_url, cvAnalyzed: true });
        } else if (image) {
          this.setState({ ...(this.state ?? {}), cvAnalyzed: true });
        }
        return result;
      },
    );

    this.server.registerTool(
      'upload_image',
      {
        description: `Get the upload page URL for the user to upload a floor plan image.

CALL THIS TOOL WHEN: The user pasted or attached a floor plan image in chat but you don't have a URL for it. This tool returns the upload page link — send it to the user and wait for them to paste back the URL.

WORKFLOW: upload_image → user uploads → user gives you URL → analyze_floor_plan_image → generate_floor_plan

Do NOT skip this. Do NOT read dimensions from the image by eye. The CV pipeline is always better.`,
        inputSchema: {},
      },
      async () => {
        const uploadUrl = `${this.getWorkerUrl()}/upload`;
        return { content: [{ type: 'text' as const, text: `Direct the user to upload their floor plan image:\n\n**Upload page:** ${uploadUrl}\n\nTell the user:\n"I can see your floor plan! To get accurate room dimensions, I need to run it through our computer vision pipeline. Please:\n1. Open ${uploadUrl}\n2. Drop or paste your image there\n3. Copy the URL it gives you and paste it back here"\n\nThen STOP and WAIT for the user to provide the URL. Do NOT proceed without it.` }] };
      },
    );

    this.server.registerTool(
      'update_sketch',
      {
        description: `Push modifications to an existing sketch. Supports two input modes:

1. "changes" — Low-level ID-based changes (15 types: add/move/remove walls, openings, rooms, furniture, set_envelope)
2. "high_level_changes" — Label-based surgical operations (recommended for Copy Mode iteration)

HIGH-LEVEL OPERATIONS (use room labels, not IDs):

Room operations:
- resize_room: {room, side: "north"|"south"|"east"|"west", delta_cm} — expand (+) or contract (-) one side
- move_room: {room, dx, dy} — shift a room by dx/dy cm
- add_room: {label, room_type, rect: {x,y,width,depth}} or {label, room_type, polygon: [{x,y},...]}
- remove_room: {room} — removes room + its walls + furniture
- split_room: {room, axis: "vertical"|"horizontal", position_cm, labels: ["A","B"], types?: [type,type]}
- merge_rooms: {rooms: ["A","B"], label, room_type}
- rename_room: {room, new_label}
- retype_room: {room, new_type}

Opening operations:
- add_door: {between: ["Room A","Room B"]} for interior, or {room, wall_side} for exterior. Optional: position (0-1), width, swing ("left"|"right")
- add_window: {room, wall_side}. Optional: position (0-1), width, window_type ("single"|"double"|"sliding"|"bay")
- update_opening: {room, wall_side, opening_index?, width?, position?, swing?, window_type?}
- remove_opening: {room, wall_side, opening_index?}

Furniture operations:
- place_furniture: {furniture_type, room, position?: "center"|"north"|"sw"|{x,y}}. Optional: width, depth, rotation
- move_furniture: {furniture_type, room, position: "center"|"north"|{x,y}}
- remove_furniture: {furniture_type, room} or {furniture_id}

ITERATION PHILOSOPHY: Fix ONE thing at a time. After each fix, preview to verify it worked and didn't break adjacent rooms. Never regenerate the entire layout to fix a single room.

GOOD: "Kitchen is 30cm too narrow on east side" → resize_room Kitchen east +30
BAD: "Layout doesn't look right" → regenerate everything

Each iteration: identify single biggest discrepancy → minimal fix → preview → repeat.`,
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
          changes: z.array(ChangeSchema).optional().describe('Low-level changes (by ID)'),
          high_level_changes: z.array(z.any()).optional().describe('High-level changes (by room label) — surgical operations like resize_room, add_door, place_furniture'),
        },
      },
      async ({ sketch_id, changes, high_level_changes }) => {
        return handleUpdateSketch(sketch_id, changes || [], high_level_changes || [], this.buildCtx({
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
        description: `Get a visual PNG preview of a floor plan. Returns the rendered sketch as a PNG image. In Copy Mode (when a source image exists), also returns the source floor plan image for side-by-side comparison.

PURPOSE: This is your eyes. EVERY time you see the preview, follow this protocol:

COMPARISON PROTOCOL (when source image is present):

1. COUNT ROOMS: How many rooms in the source? How many in your sketch? List any missing or extra.

2. ROOM-BY-ROOM CHECK (for each room visible in the source):
   - Present in sketch? Correct label?
   - Roughly the right SIZE? (compare width/height proportions)
   - Right POSITION relative to neighbors?
   - Correct SHAPE? (rectangular vs L-shaped vs irregular)

3. OPENINGS: Doors between right rooms? Windows on right walls?

4. OVERALL SHAPE: Building outline match the source perimeter?

5. DECISION: List specific fixes needed. Each fix = one surgical change.
   "Kitchen is ~30cm too narrow on east side" → resize_room.
   Do NOT regenerate. Fix one thing at a time.

VERIFICATION (without source):
Check for: (1) walls with gaps or overlaps, (2) furniture outside rooms or overlapping, (3) missing doors/windows, (4) rooms too small or oddly shaped, (5) overlapping labels.`,
        inputSchema: {
          sketch_id: z.string().describe('The sketch ID'),
          include_source: z.boolean().optional().default(true).describe('Include source floor plan image for side-by-side comparison'),
        },
      },
      async ({ sketch_id, include_source }) => {
        return handlePreviewSketch(sketch_id, this.buildCtx(), include_source);
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
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private changeLog: { type: string; timestamp: string; summary: string }[] = [];
  private static MAX_CHANGE_LOG = 50;
  private static SAVE_DEBOUNCE_MS = 2000;

  // Use our own WebSocket protocol, not the Agent framework's state sync
  shouldSendProtocolMessages() { return false; }

  private logChange(change: Change) {
    const summary = change.type + (('wall_id' in change) ? ` wall:${(change as any).wall_id}` : '') +
      (('furniture_id' in change) ? ` furniture:${(change as any).furniture_id}` : '') +
      (('room_id' in change) ? ` room:${(change as any).room_id}` : '') +
      (('opening_id' in change) ? ` opening:${(change as any).opening_id}` : '');
    this.changeLog.push({ type: change.type, timestamp: new Date().toISOString(), summary });
    if (this.changeLog.length > SketchSync.MAX_CHANGE_LOG) {
      this.changeLog = this.changeLog.slice(-SketchSync.MAX_CHANGE_LOG);
    }
  }

  // Internal endpoint for MCP DO to trigger broadcasts
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // GET /changes — return recent browser changes for MCP agent awareness
    if (url.pathname === '/changes' && request.method === 'GET') {
      const since = url.searchParams.get('since');
      let changes = this.changeLog;
      if (since) {
        changes = changes.filter(c => c.timestamp > since);
      }
      return new Response(JSON.stringify({ changes, connections: [...this.getConnections()].length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /state — return live in-memory plan if the DO has one (avoids stale D1 reads)
    if (url.pathname === '/state' && request.method === 'GET') {
      if (this.state?.plan) {
        return new Response(JSON.stringify({ plan: this.state.plan, connections: [...this.getConnections()].length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ plan: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
      this.logChange(msg as Change);
      const updated = applyChanges(this.state.plan, [msg as Change]);
      this.setState({ ...this.state, plan: updated });
      this.dirty = true;
      this.broadcastToClients(JSON.stringify({ type: 'state_update', plan: updated }));
      this.debouncedSave();
    }
  }

  private debouncedSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      if (this.dirty && this.state?.plan && this.state?.sketchId) {
        const svg = floorPlanToSvg(this.state.plan);
        await saveSketch(this.env.DB, this.state.sketchId, this.state.plan, svg);
        this.dirty = false;
      }
    }, SketchSync.SAVE_DEBOUNCE_MS);
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

    // Upload page — fetch is relative (same-origin), display URL uses canonical WORKER_URL
    if (url.pathname === '/upload') {
      return new Response(uploadHtml(env.WORKER_URL || url.origin), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Upload image API — stores temporarily for CV analysis
    // CORS preflight for MCP App iframe uploads
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (url.pathname === '/api/upload-image' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname === '/api/upload-image' && request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
        return Response.json({ error: 'Content-Type must be image/png or image/jpeg' }, { status: 400, headers: corsHeaders });
      }
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) {
        return Response.json({ error: 'Image too large (max 10 MB)' }, { status: 413, headers: corsHeaders });
      }
      const id = crypto.randomUUID();
      const bytes = new Uint8Array(buf);
      const chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += 8192) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
      }
      const base64 = btoa(chunks.join(''));
      await env.DB.prepare(
        'INSERT INTO uploaded_images (id, data, content_type, created_at) VALUES (?, ?, ?, ?)'
      ).bind(id, base64, contentType, new Date().toISOString()).run();
      const imageUrl = `/api/images/${id}`;
      return Response.json({ url: imageUrl, id }, { headers: corsHeaders });
    }

    // Serve uploaded image
    const imgMatch = url.pathname.match(/^\/api\/images\/([A-Za-z0-9_-]+)$/);
    if (imgMatch && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT data, content_type FROM uploaded_images WHERE id = ?').bind(imgMatch[1]).first<{ data: string; content_type: string }>();
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { 'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=3600' },
      });
    }

    // Sweep endpoint — proxy to CV service for preprocessing strategy comparison
    if (url.pathname === '/api/cv/sweep' && request.method === 'POST') {
      const cvUrl = env.CV_SERVICE_URL || 'http://localhost:8100';
      const resp = await fetch(`${cvUrl}/sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      });
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
