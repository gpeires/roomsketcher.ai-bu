import { nanoid } from 'nanoid';
import type {
  FloorPlan, Wall, Room, Point, FurnitureItem, Opening,
  SimpleFloorPlanInput, SimpleRoomInput, RoomType,
} from './types';
import { ROOM_COLORS } from './defaults';
import { shoelaceArea } from './geometry';

// ─── Constants ──────────────────────────────────────────────────────────────

const EXTERIOR_THICKNESS = 20;
const INTERIOR_THICKNESS = 10;
const WALL_HEIGHT = 250;
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
  if ('polygon' in room && room.polygon) {
    // Compute bounding box
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

// ─── Shared edge detection ─────────────────────────────────────────────────

function findSharedEdges(rects: Rect[]): SharedEdge[] {
  const shared: SharedEdge[] = [];

  for (let i = 0; i < rects.length; i++) {
    const edgesI = getRoomEdges(rects[i], i);
    for (let j = i + 1; j < rects.length; j++) {
      const edgesJ = getRoomEdges(rects[j], j);

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
): Wall {
  return {
    id: nanoid(),
    start,
    end,
    thickness: type === 'exterior' ? EXTERIOR_THICKNESS : type === 'interior' ? INTERIOR_THICKNESS : 5,
    height: WALL_HEIGHT,
    type,
    openings: [],
  };
}

interface WallSegment {
  axis: 'x' | 'y';
  pos: number;
  start: number;
  end: number;
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

function generateWalls(rects: Rect[], sharedEdges: SharedEdge[]): Wall[] {
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
    walls.push(makeWall(start, end, 'interior'));
  }

  // Exterior walls: each room edge minus shared edge coverage
  for (let i = 0; i < rects.length; i++) {
    const edges = getRoomEdges(rects[i], i);
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
        walls.push(makeWall(start, end, 'exterior'));
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

function wallLength(wall: Wall): number {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function placeOpenings(
  walls: Wall[],
  openings: SimpleFloorPlanInput['openings'],
  rects: Rect[],
  sharedEdges: SharedEdge[],
): void {
  if (!openings) return;

  for (const o of openings) {
    const width = o.width ?? DEFAULT_WIDTHS[o.type] ?? 80;
    const position = o.position ?? 0.5;

    let targetWall: Wall | undefined;

    if (o.between) {
      // Find interior wall between two rooms
      const [labelA, labelB] = o.between;
      const idxA = rects.findIndex(r => r.label === labelA);
      const idxB = rects.findIndex(r => r.label === labelB);
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
      const rectIdx = rects.findIndex(r => r.label === o.room);
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
): FurnitureItem[] {
  if (!furniture) return [];

  return furniture.map(f => {
    const rect = rects.find(r => r.label === f.room);
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

  // 2. Find shared edges
  const sharedEdges = findSharedEdges(rects);

  // 3. Generate walls
  const walls = generateWalls(rects, sharedEdges);

  // 4. Generate room polygons
  const rooms = rects.map((rect, i) => generateRoom(rect, input.rooms[i]));

  // 5. Place openings
  placeOpenings(walls, input.openings, rects, sharedEdges);

  // 6. Convert furniture
  const furniture = convertFurniture(input.furniture, rects);

  // 7. Compute canvas from bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 400; }
  const pad = 100;

  const now = new Date().toISOString();

  return {
    version: 1,
    id: nanoid(),
    name: input.name,
    units: input.units ?? 'metric',
    canvas: {
      width: Math.max(maxX - minX + pad * 2, 400),
      height: Math.max(maxY - minY + pad * 2, 400),
      gridSize: 10,
    },
    walls,
    rooms,
    furniture,
    annotations: [],
    metadata: {
      created_at: now,
      updated_at: now,
      source: 'ai',
    },
  };
}
