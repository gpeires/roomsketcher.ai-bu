import { nanoid } from 'nanoid';
import { FloorPlanInputSchema, SimpleFloorPlanInputSchema, ChangeSchema } from './types';
import type { FloorPlan, Change } from './types';
import { compileLayout } from './compile-layout';
import { floorPlanToSvg } from './svg';
import { shoelaceArea, pointInPolygon, totalArea } from './geometry';
import { loadSketch, saveSketch } from './persistence';
import { applyChanges } from './changes';
import { HighLevelChangeSchema, processChanges } from './high-level-changes';
import type { HighLevelChange } from './high-level-changes';
import { applyDefaults } from './defaults';
import { pickCTA } from './cta-config';
import { searchDesignKnowledge } from '../tools/knowledge';
import { svgToPng } from './rasterize';
import type { SessionCTAState, SketchSession } from '../types';
import type { CTAMessage } from './cta-config';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };
type ToolResult = { content: ContentBlock[] };

export interface ToolContext {
  db: D1Database
  state: SketchSession
  setState: (s: SketchSession) => void
  workerUrl: string
  ctaVariant: string
  ctaState: SessionCTAState
  updateCta: (s: SessionCTAState) => void
  broadcast?: (msg: string) => void | Promise<void>
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolvePlan(sketchId: string, ctx: ToolContext): Promise<FloorPlan | ToolResult> {
  if (ctx.state.sketchId === sketchId && ctx.state.plan) return ctx.state.plan;
  const loaded = await loadSketch(ctx.db, sketchId);
  if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
  return loaded.plan;
}

function isToolResult(v: FloorPlan | ToolResult): v is ToolResult {
  return 'content' in v;
}

function fireCTA(trigger: string, ctx: ToolContext): CTAMessage | null {
  const cta = pickCTA(trigger, ctx.ctaState, ctx.ctaVariant);
  if (cta) {
    ctx.ctaState.ctasShown++;
    ctx.ctaState.lastCtaAt = ctx.ctaState.toolCallCount;
    ctx.updateCta(ctx.ctaState);
  }
  return cta;
}

function ctaSuffix(cta: CTAMessage | null): string {
  return cta ? `\n\n_${cta.text} [Try RoomSketcher](${cta.url})_` : '';
}

// ─── generate_floor_plan ────────────────────────────────────────────────────

export async function handleGenerateFloorPlan(
  plan: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Server-side Copy Mode gate: if the agent is submitting 3+ rooms but never
  // called analyze_floor_plan_image, they're likely bypassing the CV pipeline
  // by reading dimensions from a pasted image. Block and redirect to upload.
  if (!ctx.state?.cvAnalyzed) {
    const rooms = (plan as Record<string, unknown>)?.rooms;
    if (Array.isArray(rooms) && rooms.length >= 3) {
      const uploadUrl = ctx.workerUrl ? `${ctx.workerUrl}/upload` : '/upload';
      return { content: [{ type: 'text' as const, text: `⚠️ **Copy Mode requires CV analysis first.**\n\nYou're submitting ${rooms.length} rooms but haven't called analyze_floor_plan_image yet. If you're working from a reference image, the CV pipeline will produce much better results than manual dimension reading.\n\nPlease ask the user to upload their floor plan image:\n1. Open ${uploadUrl}\n2. Drop or paste the image\n3. Copy the URL and call analyze_floor_plan_image with it\n\nIf this is Design Mode (no reference image), add \`"source": "design"\` to the plan name to proceed.` }] };
    }
  }

  let floorPlan: FloorPlan;

  // Try full schema first (more specific — has version, walls, etc.)
  const fullResult = FloorPlanInputSchema.safeParse(plan);
  if (fullResult.success) {
    floorPlan = applyDefaults(fullResult.data);
  } else {
    // Try room-first simple schema
    const simpleResult = SimpleFloorPlanInputSchema.safeParse(plan);
    if (simpleResult.success) {
      floorPlan = compileLayout(simpleResult.data);
    } else {
      const errors = fullResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
      return { content: [{ type: 'text' as const, text: `Invalid floor plan:\n${errors}` }] };
    }
  }

  // Assign ID + timestamps
  floorPlan.id = nanoid();
  floorPlan.metadata.created_at = new Date().toISOString();
  floorPlan.metadata.updated_at = floorPlan.metadata.created_at;

  // Carry source image URL from session into plan metadata
  if (ctx.state?.sourceImageUrl) {
    floorPlan.metadata.source_image_url = ctx.state.sourceImageUrl;
  }

  // Compute room areas
  for (const room of floorPlan.rooms) {
    if (room.area === undefined) {
      room.area = shoelaceArea(room.polygon);
    }
  }

  // Render SVG + persist
  const svg = floorPlanToSvg(floorPlan);
  await saveSketch(ctx.db, floorPlan.id, floorPlan, svg);
  ctx.setState({ ...ctx.state, sketchId: floorPlan.id, plan: floorPlan });

  // CTA — fallback chain: first_generation → furniture_placed → room-specific
  let cta = fireCTA('first_generation', ctx);
  if (!cta && floorPlan.furniture.length > 0) {
    cta = fireCTA('furniture_placed', ctx);
  }
  if (!cta) {
    for (const r of floorPlan.rooms) {
      cta = fireCTA(`room:${r.type}`, ctx);
      if (cta) break;
    }
  }

  // Summary
  const lines = [
    `**${floorPlan.name}** created`,
    `${floorPlan.walls.length} walls, ${floorPlan.rooms.length} rooms, ${floorPlan.furniture.length} furniture items`,
    `Total area: ${totalArea(floorPlan.rooms).toFixed(1)} m\u00B2`,
    ``,
    `Open in sketcher: ${ctx.workerUrl}/sketcher/${floorPlan.id}`,
  ];
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── get_sketch ─────────────────────────────────────────────────────────────

export async function handleGetSketch(
  sketchId: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const result = await resolvePlan(sketchId, ctx);
  if (isToolResult(result)) return result;
  const plan = result;

  const summary = [
    `**${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms`,
    `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m\u00B2)`).join(', ')}`,
    `Total area: ${totalArea(plan.rooms).toFixed(1)} m\u00B2`,
    `Source: ${plan.metadata.source}`,
    `Updated: ${plan.metadata.updated_at}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text: summary }] };
}

// ─── open_sketcher ──────────────────────────────────────────────────────────

export function handleOpenSketcher(
  sketchId: string,
  workerUrl: string,
): ToolResult {
  return {
    content: [{ type: 'text' as const, text: `Open the sketcher: ${workerUrl}/sketcher/${sketchId}` }],
  };
}

// ─── update_sketch ──────────────────────────────────────────────────────────

export async function handleUpdateSketch(
  sketchId: string,
  changes: unknown[],
  highLevelChanges: unknown[],
  ctx: ToolContext,
): Promise<ToolResult> {
  // Validate low-level changes
  const parsed: Change[] = [];
  for (const c of changes) {
    const result = ChangeSchema.safeParse(c);
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: `Invalid change: ${result.error.issues.map(i => i.message).join(', ')}\n\nInput: ${JSON.stringify(c, null, 2)}` }] };
    }
    parsed.push(result.data);
  }

  // Validate high-level changes
  const parsedHL: HighLevelChange[] = [];
  for (const c of highLevelChanges) {
    const result = HighLevelChangeSchema.safeParse(c);
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: `Invalid high-level change: ${result.error.issues.map(i => i.message).join(', ')}\n\nInput: ${JSON.stringify(c, null, 2)}` }] };
    }
    parsedHL.push(result.data);
  }

  if (parsed.length === 0 && parsedHL.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No changes provided. Supply "changes" and/or "high_level_changes".' }] };
  }

  // Load plan
  const planResult = await resolvePlan(sketchId, ctx);
  if (isToolResult(planResult)) return planResult;

  // Apply changes (high-level compiled first, then low-level)
  let plan: FloorPlan;
  try {
    plan = processChanges(planResult, parsedHL, parsed);
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Change failed: ${(err as Error).message}` }] };
  }

  // Persist + update state
  const svg = floorPlanToSvg(plan);
  await saveSketch(ctx.db, sketchId, plan, svg);
  ctx.setState({ ...ctx.state, sketchId, plan });

  // Broadcast to browser
  if (ctx.broadcast) {
    await ctx.broadcast(JSON.stringify({ type: 'state_update', plan }));
  }

  // CTA
  const cta = fireCTA('first_edit', ctx);

  const totalChanges = parsed.length + parsedHL.length;
  const lines = [
    `Applied ${totalChanges} change(s) to **${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea(plan.rooms).toFixed(1)} m\u00B2`,
  ];
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── suggest_improvements ───────────────────────────────────────────────────

export async function handleSuggestImprovements(
  sketchId: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const result = await resolvePlan(sketchId, ctx);
  if (isToolResult(result)) return result;
  const plan = result;

  // Room dimensions from polygon bounding boxes
  const roomData = plan.rooms.map(r => {
    const xs = r.polygon.map(p => p.x);
    const ys = r.polygon.map(p => p.y);
    const w = (Math.max(...xs) - Math.min(...xs)) / 100;
    const h = (Math.max(...ys) - Math.min(...ys)) / 100;
    const area = r.area ?? shoelaceArea(r.polygon);

    // Furniture in this room
    const roomFurniture = plan.furniture.filter(f =>
      pointInPolygon(f.position, r.polygon)
    );

    // Openings on walls bordering this room
    let doors = 0;
    let windows = 0;
    for (const wall of plan.walls) {
      const startInRoom = pointInPolygon(wall.start, r.polygon);
      const endInRoom = pointInPolygon(wall.end, r.polygon);
      if (startInRoom || endInRoom) {
        for (const o of wall.openings) {
          if (o.type === 'door') doors++;
          if (o.type === 'window') windows++;
        }
      }
    }

    return { label: r.label, type: r.type, width: w, height: h, area, furniture: roomFurniture, doors, windows };
  });

  const total = roomData.reduce((s, r) => s + r.area, 0);
  const emptyRooms = roomData.filter(r => r.furniture.length === 0).map(r => r.label);

  // Furniture not assigned to any room
  const assignedFurnitureIds = new Set(roomData.flatMap(r => r.furniture.map(f => f.id)));
  const unassigned = plan.furniture.filter(f => !assignedFurnitureIds.has(f.id));

  const lines = [
    `Analysis for "${plan.name}":`,
    '',
    'SPATIAL DATA:',
    ...roomData.map(r => `- ${r.label} (${r.type}): ${r.width.toFixed(1)}m x ${r.height.toFixed(1)}m (${r.area.toFixed(1)}sqm), furniture: ${r.furniture.map(f => f.label ?? f.type).join(', ') || 'none'}`),
    `- Total area: ${total.toFixed(1)}sqm across ${roomData.length} rooms`,
    '',
    'OPENING DATA:',
    ...roomData.map(r => `- ${r.label}: ${r.doors} doors, ${r.windows} windows`),
    '',
    'FURNITURE DATA:',
    ...roomData.map(r => `- ${r.label}: ${r.furniture.length} items`),
    ...(emptyRooms.length > 0 ? [`- Rooms with no furniture: ${emptyRooms.join(', ')}`] : []),
    ...(unassigned.length > 0 ? [`- Unassigned (outside all rooms): ${unassigned.map(f => f.label ?? f.type).join(', ')}`] : []),
    '',
    'REVIEW THESE AREAS (use your architectural knowledge to evaluate):',
    '- Room proportions: Are any rooms too narrow, oversized relative to others, or unusually shaped for their purpose?',
    '- Circulation: Can someone walk naturally from the front door to every room? Are hallways and doorways wide enough for comfortable movement?',
    '- Openings: Does every room have appropriate doors and windows? Do doors swing in practical directions? Is there natural light where needed?',
    '- Furniture: Does the furniture fit comfortably with walking clearance? Are there rooms that feel empty or overcrowded? Is the arrangement functional?',
    '- Light and ventilation: Do kitchens and bathrooms have windows or ventilation paths? Are living spaces well-lit?',
    '- Flow: Does the layout make sense for daily life? Is the kitchen near the dining area? Are bedrooms away from noisy spaces?',
    '- Overall: Does this feel like a place someone would want to live in?',
  ];

  // Search design knowledge per room type
  const roomTypes = [...new Set(roomData.map(r => r.type).filter(Boolean))];
  if (roomTypes.length > 0) {
    const knowledgeByType = await Promise.all(
      roomTypes.map(async (type) => {
        const results = await searchDesignKnowledge(ctx.db, type, {
          roomType: type,
          limit: 3,
          includeInsights: true,
        });
        return { type, chunks: results.chunks, insights: results.insights };
      })
    );

    const hasKnowledge = knowledgeByType.some(k => k.chunks.length > 0 || k.insights.length > 0);
    if (hasKnowledge) {
      lines.push('', 'DESIGN GUIDANCE (from RoomSketcher professional standards):');
      for (const { type, chunks, insights } of knowledgeByType) {
        if (chunks.length === 0 && insights.length === 0) continue;
        lines.push(`\n${type.toUpperCase()}:`);
        for (const c of chunks) {
          lines.push(`- ${c.heading}: ${c.content.slice(0, 500)}`);
        }
        for (const ins of insights) {
          if (!ins.stale) lines.push(`- [insight] ${ins.content}`);
        }
      }
    }
  }

  // CTA
  const cta = fireCTA('suggest_improvements', ctx);
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── export_sketch ──────────────────────────────────────────────────────────

export async function handleExportSketch(
  sketchId: string,
  format: 'svg' | 'pdf' | 'summary',
  ctx: ToolContext,
): Promise<ToolResult> {
  const result = await resolvePlan(sketchId, ctx);
  if (isToolResult(result)) return result;
  const plan = result;

  const total = totalArea(plan.rooms);
  const cta = ctaSuffix(fireCTA('export', ctx));

  if (format === 'summary') {
    const text = [
      `## ${plan.name}`,
      `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${total.toFixed(1)} m\u00B2`,
      `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m\u00B2)`).join(', ')}`,
      `${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'door').length, 0)} doors, ${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'window').length, 0)} windows`,
      cta,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  }

  if (format === 'pdf') {
    const text = [
      `Download your floor plan:`,
      `${ctx.workerUrl}/api/sketches/${sketchId}/export.pdf`,
      cta,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  }

  // SVG format (default) — provide download link
  return {
    content: [
      { type: 'text' as const, text: `**${plan.name}** — ${total.toFixed(1)} m\u00B2\n\nView in sketcher: ${ctx.workerUrl}/sketcher/${sketchId}${cta}` },
    ],
  };
}

// ─── preview_sketch ──────────────────────────────────────────────────────────

export async function handlePreviewSketch(
  sketchId: string,
  ctx: ToolContext,
  includeSource: boolean = true,
): Promise<ToolResult> {
  const result = await resolvePlan(sketchId, ctx);
  if (isToolResult(result)) return result;
  const plan = result;

  const svg = floorPlanToSvg(plan);
  const pngBytes = await svgToPng(svg, 1200);
  const pngArr = new Uint8Array(pngBytes);
  const pngChunks: string[] = [];
  for (let i = 0; i < pngArr.length; i += 8192) {
    pngChunks.push(String.fromCharCode(...pngArr.subarray(i, i + 8192)));
  }
  const base64 = btoa(pngChunks.join(''));

  const summaryText = [
    `**${plan.name}** preview`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${plan.furniture.length} furniture items`,
    `Total area: ${totalArea(plan.rooms).toFixed(1)} m\u00B2`,
  ].join('\n');

  const content: ContentBlock[] = [
    { type: 'image' as const, data: base64, mimeType: 'image/png' as const },
    { type: 'text' as const, text: `**Your sketch:** ${summaryText}` },
  ];

  // Source image for side-by-side comparison
  if (includeSource && plan.metadata.source_image_url) {
    try {
      const resp = await fetch(plan.metadata.source_image_url);
      if (resp.ok) {
        const sourceBytes = new Uint8Array(await resp.arrayBuffer());
        let sourceBase64 = '';
        for (let i = 0; i < sourceBytes.length; i += 8192) {
          sourceBase64 += String.fromCharCode(...sourceBytes.subarray(i, i + 8192));
        }
        sourceBase64 = btoa(sourceBase64);
        const contentType = resp.headers.get('content-type') || 'image/png';
        content.push({ type: 'image' as const, data: sourceBase64, mimeType: contentType as 'image/png' });
        content.push({ type: 'text' as const, text: '**Source image** (compare against your sketch above)' });
      }
    } catch {
      // Non-fatal — source image fetch failed, continue without it
    }
  }

  return { content };
}

export async function handleAnalyzeImage(
  input: { image?: string; image_url?: string; outline_epsilon?: number; include_grid?: boolean },
  name: string,
  cvServiceUrl: string,
  _ai?: Ai,
  _db?: D1Database,
  workerUrl?: string,
): Promise<ToolResult> {
  if (!input.image && !input.image_url) {
    return { content: [{ type: 'text' as const, text: `No image provided. Use upload_image to upload a pasted image first, then call this tool with the returned URL.` }] };
  }

  // Fetch the source image for visual feedback
  let imageBase64: string | undefined;
  let imageMime: 'image/png' | 'image/jpeg' = 'image/png';
  if (input.image) {
    imageBase64 = input.image;
  } else if (input.image_url) {
    try {
      const imgResp = await fetch(input.image_url, { signal: AbortSignal.timeout(15_000) });
      if (imgResp.ok) {
        const ct = imgResp.headers.get('content-type') || '';
        imageMime = ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' as const : 'image/png' as const;
        const buf = await imgResp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 8192) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        }
        imageBase64 = btoa(chunks.join(''));
      }
    } catch { /* non-fatal */ }
  }

  // CV-only analysis — Claude interprets the image directly
  const body: Record<string, string | number> = { name };
  if (input.image) body.image = input.image;
  else body.image_url = input.image_url!;
  if (input.outline_epsilon != null) body.outline_epsilon = input.outline_epsilon;

  const resp = await fetch(`${cvServiceUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: [{ type: 'text' as const, text: `CV analysis failed: ${err}` }] };
  }

  const cvResult = await resp.json() as {
    name: string;
    rooms: Array<{ label: string; x: number; y: number; width: number; depth: number; polygon?: Array<{ x: number; y: number }> }>;
    openings?: Array<Record<string, unknown>>;
    adjacency?: Array<Record<string, unknown>>;
    outline?: Array<{ x: number; y: number }>;
    spatial_grid?: {
      grid: string[];
      legend: Record<string, string>;
      cell_size_cm: number;
      origin: { x: number; y: number };
      size: { cols: number; rows: number };
    };
    meta: {
      walls_detected: number;
      rooms_detected: number;
      text_regions: number;
      scale_cm_per_px: number;
      scale_confidence?: string;
      wall_thickness?: { thin_cm: number; thick_cm: number };
    };
  };

  // Auto-convert CV output to ready-to-use sketch input
  const { cvToSketchInput } = await import('../ai/convert');
  const sketchInput = cvToSketchInput(cvResult);

  const scaleWarning = cvResult.meta.scale_confidence === 'fallback'
    ? '\n\n⚠️ **Scale Warning:** No dimension labels were matched to walls. Room sizes are estimated using a fallback scale and may be significantly wrong. Compare the rooms against the source image and adjust sizes as needed.'
    : '';

  // Build outline section
  const outlineSection = cvResult.outline
    ? [
        '',
        '## Building outline (perimeter polygon, cm)',
        'This is the detected outer boundary of the building. Use this as the target shape — place rooms INSIDE this outline.',
        '```json',
        JSON.stringify(cvResult.outline, null, 2),
        '```',
      ]
    : [];

  // Build spatial grid section (off by default — JSON coordinates are more actionable for most agents)
  const gridSection = (input.include_grid && cvResult.spatial_grid)
    ? [
        '',
        `## Spatial grid (each cell = ${cvResult.spatial_grid.cell_size_cm}cm)`,
        'This shows WHERE each room sits in the layout. Use this as your visual map for room placement.',
        '```',
        ...cvResult.spatial_grid.grid,
        '```',
        '',
        '**Legend:** ' + Object.entries(cvResult.spatial_grid.legend)
          .map(([abbrev, label]) => `${abbrev}=${label}`)
          .join(', '),
        `Grid origin: (${cvResult.spatial_grid.origin.x}cm, ${cvResult.spatial_grid.origin.y}cm), · = empty/wall`,
      ]
    : [];

  const summary = [
    `**CV Analysis Complete** — ${cvResult.rooms.length} rooms detected`,
    `Scale: ${cvResult.meta.scale_cm_per_px.toFixed(2)} cm/px (${cvResult.meta.scale_confidence ?? 'measured'})`,
    `Walls: ${cvResult.meta.walls_detected}, Text regions: ${cvResult.meta.text_regions}`,
    ...(cvResult.meta.wall_thickness ? [`Wall thickness: interior ${cvResult.meta.wall_thickness.thin_cm}cm, exterior ${cvResult.meta.wall_thickness.thick_cm}cm`] : []),
    scaleWarning,
    ...outlineSection,
    ...gridSection,
    '',
    '',
    '## CV detected rooms',
    '```json',
    JSON.stringify(cvResult.rooms, null, 2),
    '```',
    '',
    '## Ready-to-use input for generate_floor_plan',
    'Compare the source image above against the CV output below. Fix any wrong labels, missing rooms, or incorrect sizes before passing to generate_floor_plan:',
    '```json',
    JSON.stringify(sketchInput, null, 2),
    '```',
  ].join('\n');

  const content: ContentBlock[] = [];
  if (imageBase64) {
    content.push({ type: 'image' as const, data: imageBase64, mimeType: imageMime as 'image/png' });
  }
  content.push({ type: 'text' as const, text: summary });
  return { content };
}
