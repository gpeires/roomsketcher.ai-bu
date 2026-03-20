import { nanoid } from 'nanoid';
import { FloorPlanInputSchema, SimpleFloorPlanInputSchema, ChangeSchema } from './types';
import type { FloorPlan, Change } from './types';
import { compileLayout } from './compile-layout';
import { floorPlanToSvg } from './svg';
import { shoelaceArea, pointInPolygon, totalArea } from './geometry';
import { loadSketch, saveSketch } from './persistence';
import { applyChanges } from './changes';
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
  ctx: ToolContext,
): Promise<ToolResult> {
  // Validate changes
  const parsed: Change[] = [];
  for (const c of changes) {
    const result = ChangeSchema.safeParse(c);
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: `Invalid change: ${result.error.issues.map(i => i.message).join(', ')}` }] };
    }
    parsed.push(result.data);
  }

  // Load plan
  const planResult = await resolvePlan(sketchId, ctx);
  if (isToolResult(planResult)) return planResult;

  // Apply changes
  const plan = applyChanges(planResult, parsed);

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

  const lines = [
    `Applied ${parsed.length} change(s) to **${plan.name}**`,
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
): Promise<ToolResult> {
  const result = await resolvePlan(sketchId, ctx);
  if (isToolResult(result)) return result;
  const plan = result;

  const svg = floorPlanToSvg(plan);
  const pngBytes = await svgToPng(svg, 1200);
  const base64 = Buffer.from(pngBytes).toString('base64');

  const text = [
    `**${plan.name}** preview`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${plan.furniture.length} furniture items`,
    `Total area: ${totalArea(plan.rooms).toFixed(1)} m\u00B2`,
  ].join('\n');

  return {
    content: [
      { type: 'image' as const, data: base64, mimeType: 'image/png' as const },
      { type: 'text' as const, text },
    ],
  };
}
