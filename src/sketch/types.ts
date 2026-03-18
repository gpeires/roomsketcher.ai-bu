import { z } from 'zod';

// ─── Base types ─────────────────────────────────────────────────────────────

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

// ─── Layer 2: Openings ─────────────────────────────────────────────────────

export const OpeningSchema = z.object({
  id: z.string(),
  type: z.enum(['door', 'window', 'opening']),
  offset: z.number(), // distance from wall start, cm
  width: z.number(),  // cm
  properties: z.object({
    swingDirection: z.enum(['left', 'right']).optional(),
    swingAngle: z.number().optional(),
    sillHeight: z.number().optional(),
    windowType: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
  }),
});
export type Opening = z.infer<typeof OpeningSchema>;

// ─── Layer 1: Walls ─────────────────────────────────────────────────────────

export const WallSchema = z.object({
  id: z.string(),
  start: PointSchema,
  end: PointSchema,
  thickness: z.number(),
  height: z.number(),
  type: z.enum(['exterior', 'interior', 'divider']),
  openings: z.array(OpeningSchema),
});
export type Wall = z.infer<typeof WallSchema>;

// ─── Layer 3: Rooms ─────────────────────────────────────────────────────────

export const RoomTypeSchema = z.enum([
  'living', 'bedroom', 'kitchen', 'bathroom', 'hallway', 'closet',
  'laundry', 'office', 'dining', 'garage', 'balcony', 'terrace',
  'storage', 'utility', 'other',
]);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: RoomTypeSchema,
  polygon: z.array(PointSchema).min(3),
  wall_ids: z.array(z.string()).optional(),
  color: z.string(),
  area: z.number().optional(),
  floor_material: z.string().optional(),
});
export type Room = z.infer<typeof RoomSchema>;

// ─── Layer 4: Furniture (V2) ────────────────────────────────────────────────

export const FurnitureItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  catalog_id: z.string().optional(),
  position: PointSchema,
  rotation: z.number(),
  width: z.number(),
  depth: z.number(),
  label: z.string().optional(),
  material: z.string().optional(),
});
export type FurnitureItem = z.infer<typeof FurnitureItemSchema>;

// ─── Layer 5: Annotations (V2) ─────────────────────────────────────────────

export const AnnotationSchema = z.object({
  id: z.string(),
  type: z.enum(['label', 'dimension', 'symbol', 'arrow']),
  position: PointSchema,
  content: z.string(),
  rotation: z.number().optional(),
  style: z.object({
    fontSize: z.number().optional(),
    color: z.string().optional(),
  }).optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

// ─── FloorPlan ──────────────────────────────────────────────────────────────

export const FloorPlanSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  units: z.enum(['metric', 'imperial']),
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    gridSize: z.number(),
  }),
  walls: z.array(WallSchema),
  rooms: z.array(RoomSchema),
  furniture: z.array(FurnitureItemSchema),
  annotations: z.array(AnnotationSchema),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    source: z.enum(['ai', 'sketcher', 'mixed']),
  }),
});
export type FloorPlan = z.infer<typeof FloorPlanSchema>;

// ─── Changes (used by update_sketch + WebSocket) ───────────────────────────

export const ChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_wall'), wall: WallSchema }),
  z.object({ type: z.literal('move_wall'), wall_id: z.string(), start: PointSchema.optional(), end: PointSchema.optional() }),
  z.object({ type: z.literal('remove_wall'), wall_id: z.string() }),
  z.object({ type: z.literal('update_wall'), wall_id: z.string(), thickness: z.number().optional(), wall_type: z.enum(['exterior', 'interior', 'divider']).optional() }),
  z.object({ type: z.literal('add_opening'), wall_id: z.string(), opening: OpeningSchema }),
  z.object({ type: z.literal('remove_opening'), wall_id: z.string(), opening_id: z.string() }),
  z.object({ type: z.literal('add_room'), room: RoomSchema }),
  z.object({ type: z.literal('rename_room'), room_id: z.string(), label: z.string(), room_type: RoomTypeSchema.optional() }),
  z.object({ type: z.literal('remove_room'), room_id: z.string() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

// ─── WebSocket protocol ────────────────────────────────────────────────────

export type ClientMessage =
  | Change
  | { type: 'save' }
  | { type: 'load'; sketch_id: string };

export type ServerMessage =
  | { type: 'state_update'; plan: FloorPlan }
  | { type: 'state_delta'; changes: Change[] }
  | { type: 'saved'; updated_at: string }
  | { type: 'error'; message: string };

// ─── DO session state ──────────────────────────────────────────────────────

export interface SketchSession {
  sketchId?: string;
  plan?: FloorPlan;
}
