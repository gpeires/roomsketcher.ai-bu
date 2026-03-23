import type { FloorPlan, Room, Wall, FurnitureItem, Point } from './types';
import { pointInPolygon, polygonBoundingBox } from './geometry';

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAP_TOLERANCE = 20; // cm
const MIN_OVERLAP = 10;    // cm
const WALL_CLEARANCE = 10; // cm

// ─── Types ───────────────────────────────────────────────────────────────────

type Side = 'north' | 'south' | 'east' | 'west';
type Position = 'center' | Side | 'ne' | 'nw' | 'se' | 'sw' | Point;

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Determines which side(s) of a room a wall belongs to, based on geometric overlap
 * between the wall's axis-projected span and the room bounding box edges.
 * Returns the side(s) the wall most closely aligns with.
 */
function wallSide(wall: Wall, roomBbox: BBox): Side[] {
  const { minX, minY, maxX, maxY } = roomBbox;

  const wallMinX = Math.min(wall.start.x, wall.end.x);
  const wallMaxX = Math.max(wall.start.x, wall.end.x);
  const wallMinY = Math.min(wall.start.y, wall.end.y);
  const wallMaxY = Math.max(wall.start.y, wall.end.y);

  const sides: Side[] = [];

  const isHorizontal = Math.abs(wall.start.y - wall.end.y) < SNAP_TOLERANCE;
  const isVertical = Math.abs(wall.start.x - wall.end.x) < SNAP_TOLERANCE;

  if (isHorizontal) {
    // Check if this wall's Y is near the north (minY) or south (maxY) edge
    const wallY = (wall.start.y + wall.end.y) / 2;

    // Check horizontal overlap with the room bbox
    const overlapMin = Math.max(wallMinX, minX);
    const overlapMax = Math.min(wallMaxX, maxX);
    const overlap = overlapMax - overlapMin;

    if (overlap >= MIN_OVERLAP) {
      if (Math.abs(wallY - minY) <= SNAP_TOLERANCE) {
        sides.push('north');
      }
      if (Math.abs(wallY - maxY) <= SNAP_TOLERANCE) {
        sides.push('south');
      }
    }
  }

  if (isVertical) {
    // Check if this wall's X is near the west (minX) or east (maxX) edge
    const wallX = (wall.start.x + wall.end.x) / 2;

    // Check vertical overlap with the room bbox
    const overlapMin = Math.max(wallMinY, minY);
    const overlapMax = Math.min(wallMaxY, maxY);
    const overlap = overlapMax - overlapMin;

    if (overlap >= MIN_OVERLAP) {
      if (Math.abs(wallX - minX) <= SNAP_TOLERANCE) {
        sides.push('west');
      }
      if (Math.abs(wallX - maxX) <= SNAP_TOLERANCE) {
        sides.push('east');
      }
    }
  }

  return sides;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Case-insensitive room lookup by label.
 * Tries exact match first, then partial match (substring in either direction).
 * Throws a descriptive error listing available rooms if not found.
 */
export function findRoomByLabel(plan: FloorPlan, label: string): Room {
  const lowerLabel = label.toLowerCase();

  // Exact match (case-insensitive)
  const exact = plan.rooms.find(r => r.label.toLowerCase() === lowerLabel);
  if (exact) return exact;

  // Partial match: label contains query or query contains label
  const partial = plan.rooms.find(r => {
    const roomLower = r.label.toLowerCase();
    return roomLower.includes(lowerLabel) || lowerLabel.includes(roomLower);
  });
  if (partial) return partial;

  const available = plan.rooms.map(r => r.label).join(', ');
  throw new Error(
    `Room "${label}" not found. Available rooms: ${available}`
  );
}

/**
 * Find all walls belonging to a room using geometric bounding box matching.
 * A wall belongs to a room if it lies along one of the room's bounding box edges
 * with sufficient overlap.
 */
export function findRoomWalls(plan: FloorPlan, room: Room): Wall[] {
  const bbox = polygonBoundingBox(room.polygon);
  return plan.walls.filter(wall => {
    const sides = wallSide(wall, bbox);
    return sides.length > 0;
  });
}

/**
 * Find the wall on a specific side of a room.
 * Returns the longest matching wall, or null if none found.
 */
export function findRoomWallOnSide(
  plan: FloorPlan,
  room: Room,
  side: Side
): Wall | null {
  const bbox = polygonBoundingBox(room.polygon);

  const matching = plan.walls.filter(wall => {
    const sides = wallSide(wall, bbox);
    return sides.includes(side);
  });

  if (matching.length === 0) return null;

  // Return the longest wall
  const wallLen = (w: Wall) => {
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  return matching.reduce((best, w) => wallLen(w) > wallLen(best) ? w : best);
}

/**
 * Find the shared wall between two rooms.
 * Returns the longest shared wall, or null if the rooms are not adjacent.
 */
export function findSharedWall(
  plan: FloorPlan,
  roomA: Room,
  roomB: Room
): Wall | null {
  const bboxA = polygonBoundingBox(roomA.polygon);
  const bboxB = polygonBoundingBox(roomB.polygon);

  const wallsA = plan.walls.filter(w => wallSide(w, bboxA).length > 0);
  const wallsB = plan.walls.filter(w => wallSide(w, bboxB).length > 0);

  const idsA = new Set(wallsA.map(w => w.id));
  const shared = wallsB.filter(w => idsA.has(w.id));

  if (shared.length === 0) return null;

  const wallLen = (w: Wall) => {
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  return shared.reduce((best, w) => wallLen(w) > wallLen(best) ? w : best);
}

/**
 * Find all furniture items whose position is inside the given room's polygon.
 * Optionally filter by furniture type.
 */
export function findFurnitureInRoom(
  plan: FloorPlan,
  room: Room,
  type?: string
): FurnitureItem[] {
  return plan.furniture.filter(item => {
    if (type !== undefined && item.type !== type) return false;
    return pointInPolygon(item.position, room.polygon);
  });
}

/**
 * Convert a named position or explicit coordinates to an absolute position
 * within a room. Named positions are relative to the room's bounding box.
 * Explicit {x, y} coordinates are relative to the room's origin (minX, minY).
 */
export function resolvePosition(
  room: Room,
  position: Position,
  itemWidth: number,
  itemDepth: number
): Point {
  const bbox = polygonBoundingBox(room.polygon);
  const { minX, minY, maxX, maxY } = bbox;
  const roomWidth = maxX - minX;
  const roomHeight = maxY - minY;

  // Explicit coordinates: relative to room origin
  if (typeof position === 'object' && 'x' in position && 'y' in position) {
    return {
      x: minX + position.x,
      y: minY + position.y,
    };
  }

  const centerX = minX + (roomWidth - itemWidth) / 2;
  const centerY = minY + (roomHeight - itemDepth) / 2;
  const northY = minY + WALL_CLEARANCE;
  const southY = maxY - WALL_CLEARANCE - itemDepth;
  const westX = minX + WALL_CLEARANCE;
  const eastX = maxX - WALL_CLEARANCE - itemWidth;

  switch (position) {
    case 'center':
      return { x: centerX, y: centerY };
    case 'north':
      return { x: centerX, y: northY };
    case 'south':
      return { x: centerX, y: southY };
    case 'west':
      return { x: westX, y: centerY };
    case 'east':
      return { x: eastX, y: centerY };
    case 'nw':
      return { x: westX, y: northY };
    case 'ne':
      return { x: eastX, y: northY };
    case 'sw':
      return { x: westX, y: southY };
    case 'se':
      return { x: eastX, y: southY };
    default:
      return { x: centerX, y: centerY };
  }
}
