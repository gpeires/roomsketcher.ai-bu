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
  envelope: z.array(PointSchema).optional(),
  furniture: z.array(FurnitureItemSchema),
  annotations: z.array(AnnotationSchema),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    source: z.enum(['ai', 'sketcher', 'mixed']),
    source_image_url: z.string().optional(),
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
  z.object({ type: z.literal('update_opening'), wall_id: z.string(), opening_id: z.string(), offset: z.number().optional(), width: z.number().optional(), properties: z.object({ swingDirection: z.enum(['left', 'right']).optional(), swingAngle: z.number().optional(), sillHeight: z.number().optional(), windowType: z.enum(['single', 'double', 'sliding', 'bay']).optional() }).optional() }),
  z.object({ type: z.literal('add_room'), room: RoomSchema }),
  z.object({ type: z.literal('rename_room'), room_id: z.string(), label: z.string(), room_type: RoomTypeSchema.optional() }),
  z.object({ type: z.literal('remove_room'), room_id: z.string() }),
  z.object({ type: z.literal('update_room'), room_id: z.string(), polygon: z.array(PointSchema).optional(), area: z.number().optional() }),
  z.object({ type: z.literal('add_furniture'), furniture: FurnitureItemSchema }),
  z.object({ type: z.literal('move_furniture'), furniture_id: z.string(), position: PointSchema.optional(), rotation: z.number().optional() }),
  z.object({ type: z.literal('remove_furniture'), furniture_id: z.string() }),
  z.object({ type: z.literal('set_envelope'), polygon: z.array(PointSchema).min(3) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

// ─── Input schemas (relaxed, for generate_floor_plan tool) ──────────────
// Note: OpeningSchema is reused as-is — its property fields are already optional.

export const WallInputSchema = z.object({
  id: z.string(),
  start: PointSchema,
  end: PointSchema,
  thickness: z.number().optional(),
  height: z.number().optional(),
  type: z.enum(['exterior', 'interior', 'divider']),
  openings: z.array(OpeningSchema),
});

export const RoomInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: RoomTypeSchema,
  polygon: z.array(PointSchema).min(3),
  wall_ids: z.array(z.string()).optional(),
  color: z.string().optional(),
  area: z.number().optional(),
  floor_material: z.string().optional(),
});

export const FurnitureItemInputSchema = z.object({
  id: z.string(),
  type: z.string(),
  catalog_id: z.string().optional(),
  position: PointSchema,
  rotation: z.number().optional(),
  width: z.number(),
  depth: z.number(),
  label: z.string().optional(),
  material: z.string().optional(),
});

export const FloorPlanInputSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  units: z.enum(['metric', 'imperial']),
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    gridSize: z.number(),
  }).optional(),
  walls: z.array(WallInputSchema),
  rooms: z.array(RoomInputSchema),
  envelope: z.array(PointSchema).optional(),
  furniture: z.array(FurnitureItemInputSchema),
  annotations: z.array(AnnotationSchema),
  metadata: z.object({
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    source: z.enum(['ai', 'sketcher', 'mixed']).optional(),
    source_image_url: z.string().optional(),
  }).optional(),
});
export type FloorPlanInput = z.infer<typeof FloorPlanInputSchema>;

// ─── Room-first input schemas (simple, for LLM-friendly generation) ─────

export const SimpleRectRoomSchema = z.object({
  label: z.string(),
  type: RoomTypeSchema.optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  color: z.string().optional(),
});

export const SimplePolygonRoomSchema = z.object({
  label: z.string(),
  type: RoomTypeSchema.optional(),
  polygon: z.array(PointSchema).min(3),
  color: z.string().optional(),
});

export const SimpleRoomInputSchema = z.union([
  SimpleRectRoomSchema,
  SimplePolygonRoomSchema,
]);
export type SimpleRoomInput = z.infer<typeof SimpleRoomInputSchema>;

export const SimpleOpeningInputSchema = z.object({
  type: z.enum(['door', 'window', 'opening']),
  between: z.tuple([z.string(), z.string()]).optional(),
  room: z.string().optional(),
  wall: z.enum(['north', 'south', 'east', 'west']).optional(),
  width: z.number().optional(),
  position: z.number().min(0).max(1).optional(), // 0-1 along wall, default 0.5
  properties: z.object({
    swingDirection: z.enum(['left', 'right']).optional(),
    windowType: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
  }).optional(),
});
export type SimpleOpeningInput = z.infer<typeof SimpleOpeningInputSchema>;

export const SimpleFurnitureInputSchema = z.object({
  type: z.string(),
  room: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  depth: z.number(),
  rotation: z.number().optional(),
  label: z.string().optional(),
});
export type SimpleFurnitureInput = z.infer<typeof SimpleFurnitureInputSchema>;

export const SimpleFloorPlanInputSchema = z.object({
  name: z.string(),
  units: z.enum(['metric', 'imperial']).optional(),
  rooms: z.array(SimpleRoomInputSchema).min(1),
  openings: z.array(SimpleOpeningInputSchema).optional(),
  furniture: z.array(SimpleFurnitureInputSchema).optional(),
  wallThickness: z.object({
    exterior: z.number().optional(),  // cm, overrides default 20
    interior: z.number().optional(),  // cm, overrides default 10
  }).optional(),
});
export type SimpleFloorPlanInput = z.infer<typeof SimpleFloorPlanInputSchema>;

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

