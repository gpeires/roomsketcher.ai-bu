import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { FloorPlan, Change, Point } from './types';
import { RoomTypeSchema, PointSchema } from './types';
import { polygonBoundingBox, shoelaceArea, boundingBox } from './geometry';
import { ROOM_COLORS } from './defaults';
import { FURNITURE_CATALOG } from './furniture-catalog';
import { applyChanges } from './changes';
import {
  findRoomByLabel,
  findRoomWalls,
  findRoomWallOnSide,
  findSharedWall,
  findFurnitureInRoom,
  resolvePosition,
} from './resolve';

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const SideSchema = z.enum(['north', 'south', 'east', 'west']);
type Side = z.infer<typeof SideSchema>;

const PositionSchema = z.union([
  z.enum(['center', 'north', 'south', 'east', 'west', 'ne', 'nw', 'se', 'sw']),
  z.object({ x: z.number(), y: z.number() }),
]);

const ResizeRoomSchema = z.object({
  type: z.literal('resize_room'),
  room: z.string(),
  side: SideSchema,
  delta_cm: z.number(),
});

const MoveRoomSchema = z.object({
  type: z.literal('move_room'),
  room: z.string(),
  dx: z.number(),
  dy: z.number(),
});

const SplitRoomSchema = z.object({
  type: z.literal('split_room'),
  room: z.string(),
  axis: z.enum(['vertical', 'horizontal']),
  position_cm: z.number(),
  labels: z.tuple([z.string(), z.string()]),
  types: z.tuple([RoomTypeSchema, RoomTypeSchema]).optional(),
});

const MergeRoomsSchema = z.object({
  type: z.literal('merge_rooms'),
  rooms: z.tuple([z.string(), z.string()]),
  label: z.string(),
  room_type: RoomTypeSchema,
});

const RemoveRoomSchema = z.object({
  type: z.literal('remove_room'),
  room: z.string(),
});

const AddRoomSchema = z.object({
  type: z.literal('add_room'),
  label: z.string(),
  room_type: RoomTypeSchema,
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    depth: z.number(),
  }).optional(),
  polygon: z.array(PointSchema).min(3).optional(),
});

const AddDoorSchema = z.object({
  type: z.literal('add_door'),
  between: z.tuple([z.string(), z.string()]).optional(),
  room: z.string().optional(),
  wall_side: SideSchema.optional(),
  position: z.number().min(0).max(1).optional(),
  width: z.number().optional(),
  swing: z.enum(['left', 'right']).optional(),
});

const AddWindowSchema = z.object({
  type: z.literal('add_window'),
  between: z.tuple([z.string(), z.string()]).optional(),
  room: z.string().optional(),
  wall_side: SideSchema.optional(),
  position: z.number().min(0).max(1).optional(),
  width: z.number().optional(),
  window_type: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
});

const UpdateOpeningSchema = z.object({
  type: z.literal('update_opening'),
  room: z.string(),
  wall_side: SideSchema,
  opening_index: z.number().optional(),
  width: z.number().optional(),
  position: z.number().min(0).max(1).optional(),
  swing: z.enum(['left', 'right']).optional(),
  window_type: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
});

const RemoveOpeningSchema = z.object({
  type: z.literal('remove_opening'),
  room: z.string(),
  wall_side: SideSchema,
  opening_index: z.number().optional(),
});

const PlaceFurnitureSchema = z.object({
  type: z.literal('place_furniture'),
  furniture_type: z.string(),
  room: z.string(),
  position: PositionSchema.optional(),
  width: z.number().optional(),
  depth: z.number().optional(),
  rotation: z.number().optional(),
});

const MoveFurnitureSchema = z.object({
  type: z.literal('move_furniture'),
  furniture_type: z.string(),
  room: z.string(),
  position: PositionSchema,
});

const RemoveFurnitureHLSchema = z.object({
  type: z.literal('remove_furniture'),
  furniture_type: z.string().optional(),
  room: z.string().optional(),
  furniture_id: z.string().optional(),
});

const SetEnvelopeSchema = z.object({
  type: z.literal('set_envelope'),
  polygon: z.array(PointSchema).min(3),
});

const RenameRoomSchema = z.object({
  type: z.literal('rename_room'),
  room: z.string(),
  new_label: z.string(),
});

const RetypeRoomSchema = z.object({
  type: z.literal('retype_room'),
  room: z.string(),
  new_type: RoomTypeSchema,
});

export const HighLevelChangeSchema = z.discriminatedUnion('type', [
  ResizeRoomSchema,
  MoveRoomSchema,
  SplitRoomSchema,
  MergeRoomsSchema,
  RemoveRoomSchema,
  AddRoomSchema,
  AddDoorSchema,
  AddWindowSchema,
  UpdateOpeningSchema,
  RemoveOpeningSchema,
  PlaceFurnitureSchema,
  MoveFurnitureSchema,
  RemoveFurnitureHLSchema,
  SetEnvelopeSchema,
  RenameRoomSchema,
  RetypeRoomSchema,
]);

export type HighLevelChange = z.infer<typeof HighLevelChangeSchema>;

// ─── Helper functions ─────────────────────────────────────────────────────────

const SIDE_TOLERANCE = 1; // cm tolerance for identifying vertices on a side

export function oppositeSide(side: Side): Side {
  switch (side) {
    case 'north': return 'south';
    case 'south': return 'north';
    case 'east': return 'west';
    case 'west': return 'east';
  }
}

export function sideDelta(side: Side, delta_cm: number): number {
  // Positive delta_cm means expand. For north/west, expanding means moving in negative direction.
  switch (side) {
    case 'south':
    case 'east':
      return delta_cm;
    case 'north':
    case 'west':
      return -delta_cm;
  }
}

export function movePolygonSide(polygon: Point[], side: Side, delta: number): Point[] {
  const bbox = polygonBoundingBox(polygon);
  return polygon.map(p => {
    const newP = { ...p };
    switch (side) {
      case 'north':
        if (Math.abs(p.y - bbox.minY) <= SIDE_TOLERANCE) newP.y += delta;
        break;
      case 'south':
        if (Math.abs(p.y - bbox.maxY) <= SIDE_TOLERANCE) newP.y += delta;
        break;
      case 'east':
        if (Math.abs(p.x - bbox.maxX) <= SIDE_TOLERANCE) newP.x += delta;
        break;
      case 'west':
        if (Math.abs(p.x - bbox.minX) <= SIDE_TOLERANCE) newP.x += delta;
        break;
    }
    return newP;
  });
}

// ─── Compile functions ────────────────────────────────────────────────────────

function compileResizeRoom(plan: FloorPlan, change: z.infer<typeof ResizeRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const delta = sideDelta(change.side, change.delta_cm);
  const newPolygon = movePolygonSide(room.polygon, change.side, delta);
  const changes: Change[] = [
    { type: 'update_room', room_id: room.id, polygon: newPolygon },
  ];

  // Move the wall on that side
  const wall = findRoomWallOnSide(plan, room, change.side);
  if (wall) {
    const isHorizontal = change.side === 'north' || change.side === 'south';
    if (isHorizontal) {
      changes.push({
        type: 'move_wall',
        wall_id: wall.id,
        start: { x: wall.start.x, y: wall.start.y + delta },
        end: { x: wall.end.x, y: wall.end.y + delta },
      });
    } else {
      changes.push({
        type: 'move_wall',
        wall_id: wall.id,
        start: { x: wall.start.x + delta, y: wall.start.y },
        end: { x: wall.end.x + delta, y: wall.end.y },
      });
    }

    // Check if wall is shared with another room → adjust that room too
    for (const otherRoom of plan.rooms) {
      if (otherRoom.id === room.id) continue;
      const otherWalls = findRoomWalls(plan, otherRoom);
      if (otherWalls.some(w => w.id === wall.id)) {
        const otherSide = oppositeSide(change.side);
        const otherNewPolygon = movePolygonSide(otherRoom.polygon, otherSide, delta);
        changes.push({
          type: 'update_room',
          room_id: otherRoom.id,
          polygon: otherNewPolygon,
        });
      }
    }
  }

  return changes;
}

function compileMoveRoom(plan: FloorPlan, change: z.infer<typeof MoveRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const { dx, dy } = change;
  const changes: Change[] = [];

  // Shift polygon
  const newPolygon = room.polygon.map(p => ({ x: p.x + dx, y: p.y + dy }));
  changes.push({ type: 'update_room', room_id: room.id, polygon: newPolygon });

  // Move non-shared walls
  const roomWalls = findRoomWalls(plan, room);
  const sharedWallIds = new Set<string>();
  for (const otherRoom of plan.rooms) {
    if (otherRoom.id === room.id) continue;
    const shared = findSharedWall(plan, room, otherRoom);
    if (shared) sharedWallIds.add(shared.id);
  }

  for (const wall of roomWalls) {
    if (sharedWallIds.has(wall.id)) continue;
    changes.push({
      type: 'move_wall',
      wall_id: wall.id,
      start: { x: wall.start.x + dx, y: wall.start.y + dy },
      end: { x: wall.end.x + dx, y: wall.end.y + dy },
    });
  }

  // Move furniture in room
  const furniture = findFurnitureInRoom(plan, room);
  for (const item of furniture) {
    changes.push({
      type: 'move_furniture',
      furniture_id: item.id,
      position: { x: item.position.x + dx, y: item.position.y + dy },
    });
  }

  return changes;
}

function compileAddRoom(plan: FloorPlan, change: z.infer<typeof AddRoomSchema>): Change[] {
  let polygon: Point[];
  if (change.polygon) {
    polygon = change.polygon;
  } else if (change.rect) {
    const { x, y, width, depth } = change.rect;
    polygon = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + depth },
      { x, y: y + depth },
    ];
  } else {
    throw new Error('add_room requires either rect or polygon');
  }

  const color = ROOM_COLORS[change.room_type] ?? '#FAFAFA';
  return [{
    type: 'add_room',
    room: {
      id: nanoid(),
      label: change.label,
      type: change.room_type,
      polygon,
      color,
      area: shoelaceArea(polygon),
    },
  }];
}

function compileRemoveRoom(plan: FloorPlan, change: z.infer<typeof RemoveRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const changes: Change[] = [];

  // Remove furniture in room
  const furniture = findFurnitureInRoom(plan, room);
  for (const item of furniture) {
    changes.push({ type: 'remove_furniture', furniture_id: item.id });
  }

  // Remove non-shared walls
  const roomWalls = findRoomWalls(plan, room);
  const sharedWallIds = new Set<string>();
  for (const otherRoom of plan.rooms) {
    if (otherRoom.id === room.id) continue;
    const shared = findSharedWall(plan, room, otherRoom);
    if (shared) sharedWallIds.add(shared.id);
  }
  for (const wall of roomWalls) {
    if (sharedWallIds.has(wall.id)) continue;
    changes.push({ type: 'remove_wall', wall_id: wall.id });
  }

  // Remove room
  changes.push({ type: 'remove_room', room_id: room.id });

  return changes;
}

function compileSplitRoom(plan: FloorPlan, change: z.infer<typeof SplitRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const bbox = polygonBoundingBox(room.polygon);
  const changes: Change[] = [];

  // Remove original room
  changes.push({ type: 'remove_room', room_id: room.id });

  const types = change.types ?? [room.type, room.type];

  let poly1: Point[], poly2: Point[];
  let wallStart: Point, wallEnd: Point;

  if (change.axis === 'vertical') {
    // Split at x = bbox.minX + position_cm
    const splitX = bbox.minX + change.position_cm;
    poly1 = [
      { x: bbox.minX, y: bbox.minY },
      { x: splitX, y: bbox.minY },
      { x: splitX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
    ];
    poly2 = [
      { x: splitX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: splitX, y: bbox.maxY },
    ];
    wallStart = { x: splitX, y: bbox.minY };
    wallEnd = { x: splitX, y: bbox.maxY };
  } else {
    // horizontal split at y = bbox.minY + position_cm
    const splitY = bbox.minY + change.position_cm;
    poly1 = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: splitY },
      { x: bbox.minX, y: splitY },
    ];
    poly2 = [
      { x: bbox.minX, y: splitY },
      { x: bbox.maxX, y: splitY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
    ];
    wallStart = { x: bbox.minX, y: splitY };
    wallEnd = { x: bbox.maxX, y: splitY };
  }

  const color1 = ROOM_COLORS[types[0]] ?? '#FAFAFA';
  const color2 = ROOM_COLORS[types[1]] ?? '#FAFAFA';

  changes.push({
    type: 'add_room',
    room: {
      id: nanoid(),
      label: change.labels[0],
      type: types[0],
      polygon: poly1,
      color: color1,
      area: shoelaceArea(poly1),
    },
  });

  changes.push({
    type: 'add_room',
    room: {
      id: nanoid(),
      label: change.labels[1],
      type: types[1],
      polygon: poly2,
      color: color2,
      area: shoelaceArea(poly2),
    },
  });

  // Add interior wall at split line
  changes.push({
    type: 'add_wall',
    wall: {
      id: nanoid(),
      start: wallStart,
      end: wallEnd,
      thickness: 10,
      height: 250,
      type: 'interior',
      openings: [],
    },
  });

  return changes;
}

function compileMergeRooms(plan: FloorPlan, change: z.infer<typeof MergeRoomsSchema>): Change[] {
  const roomA = findRoomByLabel(plan, change.rooms[0]);
  const roomB = findRoomByLabel(plan, change.rooms[1]);

  const sharedWall = findSharedWall(plan, roomA, roomB);
  if (!sharedWall) {
    throw new Error(
      `Cannot merge "${roomA.label}" and "${roomB.label}": no shared wall found. Rooms must be adjacent.`
    );
  }

  const changes: Change[] = [];

  // Remove both rooms
  changes.push({ type: 'remove_room', room_id: roomA.id });
  changes.push({ type: 'remove_room', room_id: roomB.id });

  // Remove shared wall
  changes.push({ type: 'remove_wall', wall_id: sharedWall.id });

  // Create merged room with bounding box polygon
  const bboxA = polygonBoundingBox(roomA.polygon);
  const bboxB = polygonBoundingBox(roomB.polygon);
  const mergedBbox = {
    minX: Math.min(bboxA.minX, bboxB.minX),
    minY: Math.min(bboxA.minY, bboxB.minY),
    maxX: Math.max(bboxA.maxX, bboxB.maxX),
    maxY: Math.max(bboxA.maxY, bboxB.maxY),
  };
  const mergedPolygon: Point[] = [
    { x: mergedBbox.minX, y: mergedBbox.minY },
    { x: mergedBbox.maxX, y: mergedBbox.minY },
    { x: mergedBbox.maxX, y: mergedBbox.maxY },
    { x: mergedBbox.minX, y: mergedBbox.maxY },
  ];

  const color = ROOM_COLORS[change.room_type] ?? '#FAFAFA';
  changes.push({
    type: 'add_room',
    room: {
      id: nanoid(),
      label: change.label,
      type: change.room_type,
      polygon: mergedPolygon,
      color,
      area: shoelaceArea(mergedPolygon),
    },
  });

  return changes;
}

function resolveWallForOpening(
  plan: FloorPlan,
  between?: [string, string],
  room?: string,
  wallSide?: Side,
): { wall_id: string; wallLength: number } {
  if (between) {
    const roomA = findRoomByLabel(plan, between[0]);
    const roomB = findRoomByLabel(plan, between[1]);
    const wall = findSharedWall(plan, roomA, roomB);
    if (!wall) {
      throw new Error(`No shared wall between "${roomA.label}" and "${roomB.label}"`);
    }
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    return { wall_id: wall.id, wallLength: Math.sqrt(dx * dx + dy * dy) };
  }

  if (room && wallSide) {
    const r = findRoomByLabel(plan, room);
    const wall = findRoomWallOnSide(plan, r, wallSide);
    if (!wall) {
      throw new Error(`No wall found on ${wallSide} side of "${r.label}"`);
    }
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    return { wall_id: wall.id, wallLength: Math.sqrt(dx * dx + dy * dy) };
  }

  throw new Error('add_door/add_window requires either "between" or "room" + "wall_side"');
}

function compileAddDoor(plan: FloorPlan, change: z.infer<typeof AddDoorSchema>): Change[] {
  const { wall_id, wallLength } = resolveWallForOpening(
    plan, change.between, change.room, change.wall_side,
  );
  const width = change.width ?? 80;
  const position = change.position ?? 0.5;
  const offset = position * wallLength - width / 2;

  return [{
    type: 'add_opening',
    wall_id,
    opening: {
      id: nanoid(),
      type: 'door',
      offset: Math.max(0, offset),
      width,
      properties: {
        swingDirection: change.swing ?? 'right',
      },
    },
  }];
}

function compileAddWindow(plan: FloorPlan, change: z.infer<typeof AddWindowSchema>): Change[] {
  const { wall_id, wallLength } = resolveWallForOpening(
    plan, change.between, change.room, change.wall_side,
  );
  const width = change.width ?? 120;
  const position = change.position ?? 0.5;
  const offset = position * wallLength - width / 2;

  return [{
    type: 'add_opening',
    wall_id,
    opening: {
      id: nanoid(),
      type: 'window',
      offset: Math.max(0, offset),
      width,
      properties: {
        windowType: change.window_type ?? 'single',
      },
    },
  }];
}

function compileUpdateOpening(plan: FloorPlan, change: z.infer<typeof UpdateOpeningSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const wall = findRoomWallOnSide(plan, room, change.wall_side);
  if (!wall) {
    throw new Error(`No wall found on ${change.wall_side} side of "${room.label}"`);
  }
  const idx = change.opening_index ?? 0;
  if (idx >= wall.openings.length) {
    throw new Error(`No opening at index ${idx} on ${change.wall_side} wall of "${room.label}"`);
  }
  const opening = wall.openings[idx];

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);

  const updates: Change = {
    type: 'update_opening',
    wall_id: wall.id,
    opening_id: opening.id,
    ...(change.width !== undefined ? { width: change.width } : {}),
    ...(change.position !== undefined ? { offset: change.position * wallLength - (change.width ?? opening.width) / 2 } : {}),
    ...(change.swing || change.window_type ? {
      properties: {
        ...(change.swing ? { swingDirection: change.swing } : {}),
        ...(change.window_type ? { windowType: change.window_type } : {}),
      },
    } : {}),
  };

  return [updates];
}

function compileRemoveOpening(plan: FloorPlan, change: z.infer<typeof RemoveOpeningSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const wall = findRoomWallOnSide(plan, room, change.wall_side);
  if (!wall) {
    throw new Error(`No wall found on ${change.wall_side} side of "${room.label}"`);
  }
  const idx = change.opening_index ?? 0;
  if (idx >= wall.openings.length) {
    throw new Error(`No opening at index ${idx} on ${change.wall_side} wall of "${room.label}"`);
  }
  const opening = wall.openings[idx];

  return [{
    type: 'remove_opening',
    wall_id: wall.id,
    opening_id: opening.id,
  }];
}

function compilePlaceFurniture(plan: FloorPlan, change: z.infer<typeof PlaceFurnitureSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);

  // Look up catalog for defaults
  const catalogItem = FURNITURE_CATALOG.find(c => c.type === change.furniture_type);
  const width = change.width ?? catalogItem?.defaultWidth ?? 60;
  const depth = change.depth ?? catalogItem?.defaultDepth ?? 60;
  const rotation = change.rotation ?? 0;
  const position = change.position ?? 'center';

  const resolved = resolvePosition(room, position, width, depth);

  return [{
    type: 'add_furniture',
    furniture: {
      id: nanoid(),
      type: change.furniture_type,
      position: resolved,
      rotation,
      width,
      depth,
    },
  }];
}

function compileMoveFurniture(plan: FloorPlan, change: z.infer<typeof MoveFurnitureSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const items = findFurnitureInRoom(plan, room, change.furniture_type);
  if (items.length === 0) {
    throw new Error(`No "${change.furniture_type}" found in "${room.label}"`);
  }
  const item = items[0];
  const resolved = resolvePosition(room, change.position, item.width, item.depth);

  return [{
    type: 'move_furniture',
    furniture_id: item.id,
    position: resolved,
  }];
}

function compileRemoveFurniture(plan: FloorPlan, change: z.infer<typeof RemoveFurnitureHLSchema>): Change[] {
  if (change.furniture_id) {
    return [{ type: 'remove_furniture', furniture_id: change.furniture_id }];
  }

  if (change.room && change.furniture_type) {
    const room = findRoomByLabel(plan, change.room);
    const items = findFurnitureInRoom(plan, room, change.furniture_type);
    return items.map(item => ({ type: 'remove_furniture' as const, furniture_id: item.id }));
  }

  if (change.room) {
    const room = findRoomByLabel(plan, change.room);
    const items = findFurnitureInRoom(plan, room);
    return items.map(item => ({ type: 'remove_furniture' as const, furniture_id: item.id }));
  }

  throw new Error('remove_furniture requires furniture_id, or room (+ optional furniture_type)');
}

function compileRenameRoom(plan: FloorPlan, change: z.infer<typeof RenameRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  return [{
    type: 'rename_room',
    room_id: room.id,
    label: change.new_label,
  }];
}

function compileRetypeRoom(plan: FloorPlan, change: z.infer<typeof RetypeRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  return [{
    type: 'rename_room',
    room_id: room.id,
    label: room.label, // keep existing label
    room_type: change.new_type,
  }];
}

function compileSetEnvelope(_plan: FloorPlan, change: z.infer<typeof SetEnvelopeSchema>): Change[] {
  return [{
    type: 'set_envelope',
    polygon: change.polygon,
  }];
}

// ─── Main compiler ────────────────────────────────────────────────────────────

export function compileHighLevelChange(plan: FloorPlan, change: HighLevelChange): Change[] {
  switch (change.type) {
    case 'resize_room': return compileResizeRoom(plan, change);
    case 'move_room': return compileMoveRoom(plan, change);
    case 'add_room': return compileAddRoom(plan, change);
    case 'remove_room': return compileRemoveRoom(plan, change);
    case 'split_room': return compileSplitRoom(plan, change);
    case 'merge_rooms': return compileMergeRooms(plan, change);
    case 'add_door': return compileAddDoor(plan, change);
    case 'add_window': return compileAddWindow(plan, change);
    case 'update_opening': return compileUpdateOpening(plan, change);
    case 'remove_opening': return compileRemoveOpening(plan, change);
    case 'place_furniture': return compilePlaceFurniture(plan, change);
    case 'move_furniture': return compileMoveFurniture(plan, change);
    case 'remove_furniture': return compileRemoveFurniture(plan, change);
    case 'rename_room': return compileRenameRoom(plan, change);
    case 'retype_room': return compileRetypeRoom(plan, change);
    case 'set_envelope': return compileSetEnvelope(plan, change);
  }
}

// ─── processChanges ───────────────────────────────────────────────────────────

export function processChanges(
  plan: FloorPlan,
  highLevelChanges: HighLevelChange[],
  lowLevelChanges: Change[] = [],
): FloorPlan {
  // Compile high-level changes sequentially (each sees results of prior)
  let current = plan;
  for (const hlChange of highLevelChanges) {
    const compiled = compileHighLevelChange(current, hlChange);
    current = applyChanges(current, compiled);
  }

  // Apply low-level changes on top
  if (lowLevelChanges.length > 0) {
    current = applyChanges(current, lowLevelChanges);
  }

  // Recompute canvas bounds
  const bb = boundingBox(current.walls, current.envelope);
  const pad = 100;
  current = {
    ...current,
    canvas: {
      ...current.canvas,
      width: Math.max(bb.maxX - bb.minX + pad * 2, 400),
      height: Math.max(bb.maxY - bb.minY + pad * 2, 400),
    },
  };

  return current;
}
