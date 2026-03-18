import { nanoid } from 'nanoid';
import { FloorPlanSchema, ChangeSchema } from './types';
import type { FloorPlan, Change } from './types';
import { floorPlanToSvg } from './svg';
import { shoelaceArea } from './geometry';
import { loadSketch, saveSketch } from './persistence';
import { applyChanges } from './changes';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// ─── generate_floor_plan ────────────────────────────────────────────────────

export async function handleGenerateFloorPlan(
  plan: unknown,
  db: D1Database,
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  workerUrl: string,
): Promise<ToolResult> {
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

  // Render SVG + persist
  const svg = floorPlanToSvg(floorPlan);
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

  return { content: [{ type: 'text' as const, text: summary }] };
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
    `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m²)`).join(', ')}`,
    `Total area: ${totalArea.toFixed(1)} m²`,
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

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `Applied ${parsed.length} change(s) to **${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m²`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text: summary }] };
}

// ─── suggest_improvements ───────────────────────────────────────────────────

export async function handleSuggestImprovements(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
): Promise<ToolResult> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  const rooms = plan.rooms.map(r => ({
    label: r.label,
    type: r.type,
    area: r.area ?? shoelaceArea(r.polygon),
    wallCount: r.wall_ids?.length ?? 0,
  }));

  const totalArea = rooms.reduce((s, r) => s + r.area, 0);
  const doorCount = plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'door').length, 0);
  const windowCount = plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'window').length, 0);

  const analysis = [
    `## Floor Plan Analysis: ${plan.name}`,
    ``,
    `**Dimensions:** ${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m² total`,
    `**Openings:** ${doorCount} doors, ${windowCount} windows`,
    ``,
    `### Rooms`,
    ...rooms.map(r => `- **${r.label}** (${r.type}): ${r.area.toFixed(1)} m²`),
    ``,
    `### Analysis Prompts`,
    `Consider these aspects of the floor plan:`,
    `1. **Room proportions** — Are any rooms unusually narrow or oversized for their purpose?`,
    `2. **Traffic flow** — Can you walk from the entrance to all rooms without passing through a bedroom?`,
    `3. **Door placement** — Do doors swing into walls or furniture? Is there clearance?`,
    `4. **Natural light** — Do living spaces have windows? Bathrooms can be interior.`,
    `5. **Missing rooms** — Is there a closet near the entrance? Storage? Laundry space?`,
    `6. **Kitchen triangle** — If applicable, is the fridge-sink-stove layout efficient?`,
    ``,
    `### Want more?`,
    `- **3D visualization** of this layout → [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=suggest)`,
    `- **Furniture placement** with 7000+ items → RoomSketcher Pro`,
    `- **HD renders** for presentations → RoomSketcher VIP`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text: analysis }] };
}

// ─── export_sketch ──────────────────────────────────────────────────────────

export async function handleExportSketch(
  sketchId: string,
  format: 'svg' | 'pdf' | 'summary',
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
  workerUrl: string,
): Promise<ToolResult> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const cta = `\n\n_For 3D visualization, HD renders, and professional floor plans, try [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=export)._`;

  if (format === 'summary') {
    const text = [
      `## ${plan.name}`,
      `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m²`,
      `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m²)`).join(', ')}`,
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
      { type: 'text' as const, text: `**${plan.name}** — ${totalArea.toFixed(1)} m²\n\nView in sketcher: ${workerUrl}/sketcher/${sketchId}${cta}` },
    ],
  };
}
