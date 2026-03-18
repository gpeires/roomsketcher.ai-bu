import { nanoid } from 'nanoid';
import { FloorPlanSchema } from './types';
import type { FloorPlan } from './types';
import { floorPlanToSvg } from './svg';
import { shoelaceArea } from './geometry';
import { loadSketch, saveSketch } from './persistence';

/** UTF-8-safe base64 encoding (btoa only handles Latin-1) */
function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

// ─── generate_floor_plan ────────────────────────────────────────────────────

export async function handleGenerateFloorPlan(
  plan: unknown,
  db: D1Database,
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  workerUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // Validate
  const parsed = FloorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Invalid floor plan:\n${errors}` }] };
  }

  const floorPlan = parsed.data;

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

  // Render SVG
  const svg = floorPlanToSvg(floorPlan);
  const svgBase64 = toBase64(svg);

  // Persist
  await saveSketch(db, floorPlan.id, floorPlan, svg);
  setState({ sketchId: floorPlan.id, plan: floorPlan });

  // Summary
  const totalArea = floorPlan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `**${floorPlan.name}** created`,
    `${floorPlan.walls.length} walls, ${floorPlan.rooms.length} rooms`,
    `Total area: ${totalArea.toFixed(1)} m²`,
    ``,
    `Open in sketcher: ${workerUrl}/sketcher/${floorPlan.id}`,
    ``,
    `_This is a 2D preview. For 3D walkthroughs and 7000+ furniture items, try [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=generate)._`,
  ].join('\n');

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: svgBase64, mimeType: 'image/svg+xml' },
    ],
  };
}

// ─── get_sketch ─────────────────────────────────────────────────────────────

export async function handleGetSketch(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // Try in-memory state first
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  let svg: string | undefined;

  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    }
    plan = loaded.plan;
    svg = loaded.svg ?? undefined;
  }

  if (!svg) {
    svg = floorPlanToSvg(plan);
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `**${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms`,
    `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m²)`).join(', ')}`,
    `Total area: ${totalArea.toFixed(1)} m²`,
    `Source: ${plan.metadata.source}`,
    `Updated: ${plan.metadata.updated_at}`,
  ].join('\n');

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: toBase64(svg), mimeType: 'image/svg+xml' },
    ],
  };
}

// ─── open_sketcher ──────────────────────────────────────────────────────────

export function handleOpenSketcher(
  sketchId: string,
  workerUrl: string,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: `Open the sketcher: ${workerUrl}/sketcher/${sketchId}` }],
  };
}
