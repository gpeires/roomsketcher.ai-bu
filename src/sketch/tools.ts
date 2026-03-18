import { nanoid } from 'nanoid';
import { FloorPlanSchema, FloorPlanInputSchema, ChangeSchema } from './types';
import type { FloorPlan, Change } from './types';
import { floorPlanToSvg } from './svg';
import { shoelaceArea, pointInPolygon } from './geometry';
import { loadSketch, saveSketch } from './persistence';
import { applyChanges } from './changes';
import { applyDefaults } from './defaults';
import { pickCTA } from './cta-config';
import type { SessionCTAState } from '../types';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// ─── generate_floor_plan ────────────────────────────────────────────────────

export async function handleGenerateFloorPlan(
  plan: unknown,
  db: D1Database,
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  workerUrl: string,
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  // Phase 1: Validate against relaxed input schema
  const parsed = FloorPlanInputSchema.safeParse(plan);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Invalid floor plan:\n${errors}` }] };
  }

  // Phase 2: Apply defaults → strict FloorPlan
  const floorPlan = applyDefaults(parsed.data);

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
  await saveSketch(db, floorPlan.id, floorPlan, svg);
  setState({ sketchId: floorPlan.id, plan: floorPlan });

  // CTA — fallback chain: first_generation → furniture_placed → room-specific
  let cta = pickCTA('first_generation', ctaState, ctaVariant);
  if (!cta && floorPlan.furniture.length > 0) {
    cta = pickCTA('furniture_placed', ctaState, ctaVariant);
  }
  if (!cta) {
    for (const r of floorPlan.rooms) {
      cta = pickCTA(`room:${r.type}`, ctaState, ctaVariant);
      if (cta) break;
    }
  }
  if (cta) {
    ctaState.ctasShown++;
    ctaState.lastCtaAt = ctaState.toolCallCount;
    updateCta(ctaState);
  }

  // Summary
  const totalArea = floorPlan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const lines = [
    `**${floorPlan.name}** created`,
    `${floorPlan.walls.length} walls, ${floorPlan.rooms.length} rooms, ${floorPlan.furniture.length} furniture items`,
    `Total area: ${totalArea.toFixed(1)} m\u00B2`,
    ``,
    `Open in sketcher: ${workerUrl}/sketcher/${floorPlan.id}`,
  ];
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── get_sketch ─────────────────────────────────────────────────────────────

export async function handleGetSketch(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
): Promise<ToolResult> {
  // Try in-memory state first
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;

  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    }
    plan = loaded.plan;
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `**${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms`,
    `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m\u00B2)`).join(', ')}`,
    `Total area: ${totalArea.toFixed(1)} m\u00B2`,
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
  db: D1Database,
  getState: () => { sketchId?: string; plan?: FloorPlan },
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  broadcast: (msg: string) => void | Promise<void>,
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
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
  const state = getState();
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  // Apply changes
  plan = applyChanges(plan, parsed);

  // Persist + update state
  const svg = floorPlanToSvg(plan);
  await saveSketch(db, sketchId, plan, svg);
  setState({ sketchId, plan });

  // Broadcast to browser
  await broadcast(JSON.stringify({ type: 'state_update', plan }));

  // CTA
  const cta = pickCTA('first_edit', ctaState, ctaVariant);
  if (cta) {
    ctaState.ctasShown++;
    ctaState.lastCtaAt = ctaState.toolCallCount;
    updateCta(ctaState);
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const lines = [
    `Applied ${parsed.length} change(s) to **${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m\u00B2`,
  ];
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── suggest_improvements ───────────────────────────────────────────────────

export async function handleSuggestImprovements(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  // Room dimensions from polygon bounding boxes
  const roomData = plan.rooms.map(r => {
    const xs = r.polygon.map(p => p.x);
    const ys = r.polygon.map(p => p.y);
    const w = (Math.max(...xs) - Math.min(...xs)) / 100;
    const h = (Math.max(...ys) - Math.min(...ys)) / 100;
    const area = r.area ?? shoelaceArea(r.polygon);

    // Furniture in this room
    const roomFurniture = plan!.furniture.filter(f =>
      pointInPolygon(f.position, r.polygon)
    );

    // Openings on walls bordering this room
    let doors = 0;
    let windows = 0;
    for (const wall of plan!.walls) {
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

  const totalArea = roomData.reduce((s, r) => s + r.area, 0);
  const emptyRooms = roomData.filter(r => r.furniture.length === 0).map(r => r.label);

  // Furniture not assigned to any room
  const assignedFurnitureIds = new Set(roomData.flatMap(r => r.furniture.map(f => f.id)));
  const unassigned = plan.furniture.filter(f => !assignedFurnitureIds.has(f.id));

  const lines = [
    `Analysis for "${plan.name}":`,
    '',
    'SPATIAL DATA:',
    ...roomData.map(r => `- ${r.label} (${r.type}): ${r.width.toFixed(1)}m x ${r.height.toFixed(1)}m (${r.area.toFixed(1)}sqm), furniture: ${r.furniture.map(f => f.label ?? f.type).join(', ') || 'none'}`),
    `- Total area: ${totalArea.toFixed(1)}sqm across ${roomData.length} rooms`,
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

  // CTA
  const cta = pickCTA('suggest_improvements', ctaState, ctaVariant);
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`);
    ctaState.ctasShown++;
    ctaState.lastCtaAt = ctaState.toolCallCount;
    updateCta(ctaState);
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ─── export_sketch ──────────────────────────────────────────────────────────

export async function handleExportSketch(
  sketchId: string,
  format: 'svg' | 'pdf' | 'summary',
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
  workerUrl: string,
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const ctaMsg = pickCTA('export', ctaState, ctaVariant);
  if (ctaMsg) {
    ctaState.ctasShown++;
    ctaState.lastCtaAt = ctaState.toolCallCount;
    updateCta(ctaState);
  }
  const cta = ctaMsg ? `\n\n_${ctaMsg.text} [Try RoomSketcher](${ctaMsg.url})_` : '';

  if (format === 'summary') {
    const text = [
      `## ${plan.name}`,
      `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m\u00B2`,
      `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m\u00B2)`).join(', ')}`,
      `${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'door').length, 0)} doors, ${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'window').length, 0)} windows`,
      cta,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  }

  if (format === 'pdf') {
    const text = [
      `Download your floor plan:`,
      `${workerUrl}/api/sketches/${sketchId}/export.pdf`,
      cta,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  }

  // SVG format (default) — provide download link
  return {
    content: [
      { type: 'text' as const, text: `**${plan.name}** — ${totalArea.toFixed(1)} m\u00B2\n\nView in sketcher: ${workerUrl}/sketcher/${sketchId}${cta}` },
    ],
  };
}
