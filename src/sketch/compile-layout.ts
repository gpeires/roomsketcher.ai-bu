import { nanoid } from 'nanoid';
import type {
  FloorPlan, Wall, Room, Point, FurnitureItem, Opening,
  SimpleFloorPlanInput, SimpleRoomInput, RoomType,
} from './types';
import type { z } from 'zod';
import type { SimpleRectRoomSchema, SimplePolygonRoomSchema } from './types';

type RectRoom = z.infer<typeof SimpleRectRoomSchema>;

function isRectRoom(room: SimpleRoomInput): room is RectRoom {
  return 'x' in room && 'width' in room;
}
import { ROOM_COLORS, WALL_THICKNESS, DEFAULT_HEIGHT } from './defaults';
import { shoelaceArea, boundingBox, wallLength } from './geometry';

// ─── Constants ──────────────────────────────────────────────────────────────

const SNAP_GRID = 10;
const SNAP_TOLERANCE = 20;

const DEFAULT_WIDTHS: Record<string, number> = {
  door: 80,
  window: 120,
  opening: 90,
};

// ─── Room type inference ────────────────────────────────────────────────────

const ROOM_TYPE_PATTERNS: [RegExp, RoomType][] = [
  [/bed|master|guest|nursery/i, 'bedroom'],
  [/bath|shower|wc|powder|toilet/i, 'bathroom'],
  [/kitchen|pantry/i, 'kitchen'],
  [/living|lounge|family|great/i, 'living'],
  [/dining|breakfast/i, 'dining'],
  [/hall|corridor|entry|foyer|lobby/i, 'hallway'],
  [/office|study|den|library/i, 'office'],
  [/closet|wardrobe|dressing|storage/i, 'closet'],
  [/laundry|w\/d|washer|utility/i, 'laundry'],
  [/garage|carport/i, 'garage'],
  [/balcony|porch/i, 'balcony'],
  [/terrace|patio|deck/i, 'terrace'],
];

function inferRoomType(label: string): RoomType {
  for (const [pattern, type] of ROOM_TYPE_PATTERNS) {
    if (pattern.test(label)) return type;
  }
  return 'other';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function snap(v: number): number {
  return Math.round(v / SNAP_GRID) * SNAP_GRID;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  roomInput: SimpleRoomInput;
}

function roomToRect(room: SimpleRoomInput): Rect {
  if (!isRectRoom(room)) {
    // Polygon room: compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of room.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      x: snap(minX),
      y: snap(minY),
      w: snap(maxX) - snap(minX),
      h: snap(maxY) - snap(minY),
      label: room.label,
      roomInput: room,
    };
  }
  // Rect room: snap endpoints, derive dimensions
  const x = snap(room.x);
  const y = snap(room.y);
  const x2 = snap(room.x + room.width);
  const y2 = snap(room.y + room.depth);
  return {
    x,
    y,
    w: x2 - x,
    h: y2 - y,
    label: room.label,
    roomInput: room,
  };
}

// ─── Edge types ─────────────────────────────────────────────────────────────

interface Edge {
  axis: 'x' | 'y';     // which axis is constant
  pos: number;          // the constant value on that axis
  start: number;        // start on perpendicular axis
  end: number;          // end on perpendicular axis
  roomIdx: number;
  side: 'left' | 'right' | 'top' | 'bottom';
}

interface SharedEdge {
  axis: 'x' | 'y';
  pos: number;
  overlapStart: number;
  overlapEnd: number;
  roomA: number;
  roomB: number;
}

function getRoomEdges(rect: Rect, idx: number): Edge[] {
  return [
    { axis: 'y', pos: rect.y, start: rect.x, end: rect.x + rect.w, roomIdx: idx, side: 'top' },
    { axis: 'y', pos: rect.y + rect.h, start: rect.x, end: rect.x + rect.w, roomIdx: idx, side: 'bottom' },
    { axis: 'x', pos: rect.x, start: rect.y, end: rect.y + rect.h, roomIdx: idx, side: 'left' },
    { axis: 'x', pos: rect.x + rect.w, start: rect.y, end: rect.y + rect.h, roomIdx: idx, side: 'right' },
  ];
}

/**
 * Extract axis-aligned edges from a polygon's vertices.
 * Used for polygon rooms to generate walls along the actual room boundary
 * instead of the bounding box.
 */
function getPolygonEdges(polygon: Point[], rect: Rect, idx: number): Edge[] {
  const edges: Edge[] = [];
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);

    if (dx < SNAP_GRID && dy >= SNAP_GRID) {
      // Vertical edge
      const pos = snap((a.x + b.x) / 2);
      const start = Math.min(a.y, b.y);
      const end = Math.max(a.y, b.y);
      const side = pos < cx ? 'left' : 'right';
      edges.push({ axis: 'x', pos, start, end, roomIdx: idx, side: side as Edge['side'] });
    } else if (dy < SNAP_GRID && dx >= SNAP_GRID) {
      // Horizontal edge
      const pos = snap((a.y + b.y) / 2);
      const start = Math.min(a.x, b.x);
      const end = Math.max(a.x, b.x);
      const side = pos < cy ? 'top' : 'bottom';
      edges.push({ axis: 'y', pos, start, end, roomIdx: idx, side: side as Edge['side'] });
    }
    // Non-axis-aligned edges are skipped (diagonal walls not yet supported)
  }

  return edges;
}

// ─── Shared edge detection ─────────────────────────────────────────────────

function findSharedEdges(rects: Rect[], allEdges: Edge[][]): SharedEdge[] {
  const shared: SharedEdge[] = [];

  for (let i = 0; i < rects.length; i++) {
    const edgesI = allEdges[i];
    for (let j = i + 1; j < rects.length; j++) {
      const edgesJ = allEdges[j];

      for (const ei of edgesI) {
        for (const ej of edgesJ) {
          if (ei.axis !== ej.axis) continue;
          // Opposing sides?
          const opposing =
            (ei.side === 'right' && ej.side === 'left') ||
            (ei.side === 'left' && ej.side === 'right') ||
            (ei.side === 'bottom' && ej.side === 'top') ||
            (ei.side === 'top' && ej.side === 'bottom');
          if (!opposing) continue;

          // Within snap tolerance?
          if (Math.abs(ei.pos - ej.pos) > SNAP_TOLERANCE) continue;

          // Overlap in perpendicular direction?
          const overlapStart = Math.max(ei.start, ej.start);
          const overlapEnd = Math.min(ei.end, ej.end);
          if (overlapEnd - overlapStart < SNAP_GRID) continue;

          // Use the average position (snapped)
          const pos = snap((ei.pos + ej.pos) / 2);

          shared.push({
            axis: ei.axis,
            pos,
            overlapStart,
            overlapEnd,
            roomA: i,
            roomB: j,
          });
        }
      }
    }
  }

  return shared;
}

// ─── Wall generation ────────────────────────────────────────────────────────

function makeWall(
  start: Point, end: Point, type: 'exterior' | 'interior' | 'divider',
  thicknessOverrides?: { exterior?: number; interior?: number },
): Wall {
  const thickness = thicknessOverrides?.[type as 'exterior' | 'interior']
    ?? WALL_THICKNESS[type] ?? 10;
  return {
    id: nanoid(),
    start,
    end,
    thickness,
    height: DEFAULT_HEIGHT,
    type,
    openings: [],
  };
}

function subtractSegments(
  full: { start: number; end: number },
  holes: { start: number; end: number }[],
): { start: number; end: number }[] {
  // Sort holes by start
  const sorted = [...holes].sort((a, b) => a.start - b.start);
  const result: { start: number; end: number }[] = [];
  let cur = full.start;
  for (const h of sorted) {
    if (h.start > cur) {
      result.push({ start: cur, end: h.start });
    }
    cur = Math.max(cur, h.end);
  }
  if (cur < full.end) {
    result.push({ start: cur, end: full.end });
  }
  return result;
}

/**
 * Check if a point is strictly inside any room rectangle.
 * Used to determine if a wall has a room on both sides (interior) or not (exterior).
 */
function pointInsideAnyRoom(x: number, y: number, rects: Rect[]): boolean {
  const eps = 1; // 1cm tolerance for boundary hits
  for (const r of rects) {
    if (x >= r.x - eps && x <= r.x + r.w + eps && y >= r.y - eps && y <= r.y + r.h + eps) return true;
  }
  return false;
}

/**
 * Determine if a non-shared wall segment is truly exterior (on the building perimeter)
 * or interior (between rooms that don't share an exact edge).
 * Probes a point on each side of the wall midpoint — if both sides are inside a room, it's interior.
 */
function classifyWallType(
  edge: Edge, segStart: number, segEnd: number, rects: Rect[],
): 'exterior' | 'interior' {
  const mid = (segStart + segEnd) / 2;
  const probe = 5; // cm offset to check other side of wall

  if (edge.axis === 'x') {
    // Vertical wall at x=edge.pos
    const leftInside = pointInsideAnyRoom(edge.pos - probe, mid, rects);
    const rightInside = pointInsideAnyRoom(edge.pos + probe, mid, rects);
    return (leftInside && rightInside) ? 'interior' : 'exterior';
  } else {
    // Horizontal wall at y=edge.pos
    const aboveInside = pointInsideAnyRoom(mid, edge.pos - probe, rects);
    const belowInside = pointInsideAnyRoom(mid, edge.pos + probe, rects);
    return (aboveInside && belowInside) ? 'interior' : 'exterior';
  }
}

function generateWalls(
  rects: Rect[], sharedEdges: SharedEdge[], allEdges: Edge[][],
  thicknessOverrides?: { exterior?: number; interior?: number },
): Wall[] {
  const walls: Wall[] = [];

  // Interior walls from shared edges
  for (const se of sharedEdges) {
    let start: Point, end: Point;
    if (se.axis === 'x') {
      // Vertical shared edge
      start = { x: se.pos, y: se.overlapStart };
      end = { x: se.pos, y: se.overlapEnd };
    } else {
      // Horizontal shared edge
      start = { x: se.overlapStart, y: se.pos };
      end = { x: se.overlapEnd, y: se.pos };
    }
    walls.push(makeWall(start, end, 'interior', thicknessOverrides));
  }

  // Non-shared walls: classify as exterior or interior based on surroundings
  for (let i = 0; i < rects.length; i++) {
    const edges = allEdges[i];
    for (const edge of edges) {
      // Find shared edges that cover parts of this edge
      const coveredHoles: { start: number; end: number }[] = [];
      for (const se of sharedEdges) {
        if (se.axis !== edge.axis) continue;
        if (se.roomA !== i && se.roomB !== i) continue;
        if (Math.abs(se.pos - edge.pos) > SNAP_TOLERANCE) continue;
        coveredHoles.push({ start: se.overlapStart, end: se.overlapEnd });
      }

      const segments = subtractSegments(
        { start: edge.start, end: edge.end },
        coveredHoles,
      );

      for (const seg of segments) {
        if (seg.end - seg.start < SNAP_GRID) continue; // skip tiny segments
        let start: Point, end: Point;
        if (edge.axis === 'x') {
          start = { x: edge.pos, y: seg.start };
          end = { x: edge.pos, y: seg.end };
        } else {
          start = { x: seg.start, y: edge.pos };
          end = { x: seg.end, y: edge.pos };
        }
        const wallType = classifyWallType(edge, seg.start, seg.end, rects);
        walls.push(makeWall(start, end, wallType, thicknessOverrides));
      }
    }
  }

  return walls;
}

// ─── Room polygon generation ────────────────────────────────────────────────

function generateRoom(rect: Rect, input: SimpleRoomInput): Room {
  const roomType: RoomType = input.type ?? inferRoomType(input.label);
  const color = input.color ?? ROOM_COLORS[roomType] ?? '#FAFAFA';

  let polygon: Point[];
  if ('polygon' in input && input.polygon) {
    polygon = input.polygon;
  } else {
    polygon = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ];
  }

  return {
    id: nanoid(),
    label: input.label,
    type: roomType,
    polygon,
    color,
    area: shoelaceArea(polygon),
  };
}

// ─── Opening placement ─────────────────────────────────────────────────────

function placeOpenings(
  walls: Wall[],
  openings: SimpleFloorPlanInput['openings'],
  rects: Rect[],
  sharedEdges: SharedEdge[],
  rectByLabel: Map<string, number>,
): void {
  if (!openings) return;

  for (const o of openings) {
    const width = o.width ?? DEFAULT_WIDTHS[o.type] ?? 80;
    const position = o.position ?? 0.5;

    let targetWall: Wall | undefined;

    if (o.between) {
      // Find interior wall between two rooms
      const [labelA, labelB] = o.between;
      const idxA = rectByLabel.get(labelA) ?? -1;
      const idxB = rectByLabel.get(labelB) ?? -1;
      if (idxA < 0 || idxB < 0) continue;

      // Find the shared edge
      const se = sharedEdges.find(s =>
        (s.roomA === idxA && s.roomB === idxB) ||
        (s.roomA === idxB && s.roomB === idxA)
      );
      if (!se) continue;

      // Find the corresponding interior wall
      targetWall = walls.find(w => {
        if (w.type !== 'interior') return false;
        if (se.axis === 'x') {
          return w.start.x === se.pos && w.end.x === se.pos &&
            w.start.y === se.overlapStart && w.end.y === se.overlapEnd;
        } else {
          return w.start.y === se.pos && w.end.y === se.pos &&
            w.start.x === se.overlapStart && w.end.x === se.overlapEnd;
        }
      });
    } else if (o.room && o.wall) {
      // Find exterior wall on the given side of the room
      const rectIdx = rectByLabel.get(o.room) ?? -1;
      if (rectIdx < 0) continue;
      const rect = rects[rectIdx];

      targetWall = walls.find(w => {
        if (w.type !== 'exterior') return false;
        switch (o.wall) {
          case 'north':
            return w.start.y === rect.y && w.end.y === rect.y &&
              w.start.x >= rect.x && w.end.x <= rect.x + rect.w;
          case 'south':
            return w.start.y === rect.y + rect.h && w.end.y === rect.y + rect.h &&
              w.start.x >= rect.x && w.end.x <= rect.x + rect.w;
          case 'west':
            return w.start.x === rect.x && w.end.x === rect.x &&
              w.start.y >= rect.y && w.end.y <= rect.y + rect.h;
          case 'east':
            return w.start.x === rect.x + rect.w && w.end.x === rect.x + rect.w &&
              w.start.y >= rect.y && w.end.y <= rect.y + rect.h;
          default:
            return false;
        }
      });
    }

    if (!targetWall) continue;

    const len = wallLength(targetWall);
    const offset = Math.round(position * len - width / 2);

    const opening: Opening = {
      id: nanoid(),
      type: o.type,
      offset: Math.max(0, offset),
      width,
      properties: {
        swingDirection: o.properties?.swingDirection ?? (o.type === 'door' ? 'left' : undefined),
        windowType: o.properties?.windowType ?? (o.type === 'window' ? 'single' : undefined),
      },
    };

    targetWall.openings.push(opening);
  }
}

// ─── Furniture conversion ───────────────────────────────────────────────────

function convertFurniture(
  furniture: SimpleFloorPlanInput['furniture'],
  rects: Rect[],
  rectByLabel: Map<string, number>,
): FurnitureItem[] {
  if (!furniture) return [];

  return furniture.map(f => {
    const idx = rectByLabel.get(f.room);
    const rect = idx !== undefined ? rects[idx] : undefined;
    const roomX = rect?.x ?? 0;
    const roomY = rect?.y ?? 0;

    return {
      id: nanoid(),
      type: f.type,
      position: { x: roomX + f.x, y: roomY + f.y },
      rotation: f.rotation ?? 0,
      width: f.width,
      depth: f.depth,
      label: f.label,
    };
  });
}

// ─── Main compiler ──────────────────────────────────────────────────────────

export function compileLayout(input: SimpleFloorPlanInput): FloorPlan {
  // 1. Snap & normalize rooms
  const rects = input.rooms.map(r => roomToRect(r));
  // Use polygon edges for polygon rooms, bounding box edges for rect rooms
  const allEdges = rects.map((r, i) => {
    const roomInput = input.rooms[i];
    if ('polygon' in roomInput && roomInput.polygon && roomInput.polygon.length > 4) {
      const polyEdges = getPolygonEdges(roomInput.polygon, r, i);
      // Fall back to rect edges if polygon didn't produce enough axis-aligned edges
      return polyEdges.length >= 3 ? polyEdges : getRoomEdges(r, i);
    }
    return getRoomEdges(r, i);
  });
  const rectByLabel = new Map(rects.map((r, i) => [r.label, i]));

  // 2. Find shared edges
  const sharedEdges = findSharedEdges(rects, allEdges);

  // 3. Generate walls
  const walls = generateWalls(rects, sharedEdges, allEdges, input.wallThickness);

  // 4. Generate room polygons
  const rooms = rects.map((rect, i) => generateRoom(rect, input.rooms[i]));

  // 5. Place openings
  placeOpenings(walls, input.openings, rects, sharedEdges, rectByLabel);

  // 6. Convert furniture
  const furniture = convertFurniture(input.furniture, rects, rectByLabel);

  // 7. Compute canvas from bounding box
  const bb = boundingBox(walls);
  const pad = 100;

  return {
    version: 1,
    id: '',
    name: input.name,
    units: input.units ?? 'metric',
    canvas: {
      width: Math.max(bb.maxX - bb.minX + pad * 2, 400),
      height: Math.max(bb.maxY - bb.minY + pad * 2, 400),
      gridSize: 10,
    },
    walls,
    rooms,
    furniture,
    annotations: [],
    metadata: {
      created_at: '',
      updated_at: '',
      source: 'ai',
    },
  };
}
