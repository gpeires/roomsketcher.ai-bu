# Room-First Input Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple room-first input format where LLMs specify rooms as positioned rectangles (or polygons), and a compiler generates all walls, room polygons, openings, and furniture coordinates automatically.

**Architecture:** New `SimpleFloorPlanInput` Zod schema accepted alongside the existing `FloorPlanInput`. A `compileLayout()` function detects shared edges between rooms to generate interior walls, traces the outer boundary for exterior walls, places openings on the correct walls, and converts room-relative furniture to absolute coordinates. The existing `FloorPlan` output model is unchanged.

**Tech Stack:** TypeScript, Zod, Vitest. No new dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sketch/types.ts` | Modify | Add `SimpleRoomInput`, `SimpleOpeningInput`, `SimpleFurnitureInput`, `SimpleFloorPlanInput` Zod schemas |
| `src/sketch/compile-layout.ts` | Create | `compileLayout()` — converts simple input → `FloorPlan` |
| `src/sketch/compile-layout.test.ts` | Create | Tests for the compiler |
| `src/sketch/tools.ts` | Modify | Route simple input through `compileLayout()` before existing pipeline |
| `src/index.ts` | Modify | Update `generate_floor_plan` tool to accept new schema + update description |

---

### Task 1: Schema Definitions

**Files:**
- Modify: `src/sketch/types.ts` (append after line 191)
- Test: `src/sketch/types.test.ts` (add new describe block)

- [ ] **Step 1: Write failing tests for the new schemas**

```typescript
// In src/sketch/types.test.ts — add to existing file

import { SimpleFloorPlanInputSchema } from './types';

describe('SimpleFloorPlanInputSchema', () => {
  it('accepts a minimal rectangle room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts a polygon room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 500 }, { x: 0, y: 500 }] }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts openings between rooms', () => {
    const input = {
      name: 'Test',
      rooms: [
        { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
        { label: 'Living', x: 310, y: 0, width: 400, depth: 300 },
      ],
      openings: [{ type: 'door', between: ['Kitchen', 'Living'] }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts exterior openings with wall direction', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 }],
      openings: [{ type: 'window', room: 'Kitchen', wall: 'north' }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts room-relative furniture', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Bedroom', x: 0, y: 0, width: 400, depth: 350 }],
      furniture: [{ type: 'bed-double', room: 'Bedroom', x: 20, y: 20, width: 160, depth: 200 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts optional type field on room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Den', type: 'office', x: 0, y: 0, width: 300, depth: 250 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects room with neither rect nor polygon', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Bad' }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/types.test.ts --reporter=verbose`
Expected: FAIL — `SimpleFloorPlanInputSchema` is not exported

- [ ] **Step 3: Implement the schemas**

Add to `src/sketch/types.ts` after line 191 (after the existing `FloorPlanInput` type):

```typescript
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
});
export type SimpleFloorPlanInput = z.infer<typeof SimpleFloorPlanInputSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/types.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/types.ts src/sketch/types.test.ts
git commit -m "feat: add room-first SimpleFloorPlanInput schema"
```

---

### Task 2: Compile-Layout Core — Edge Detection + Wall Generation

**Files:**
- Create: `src/sketch/compile-layout.ts`
- Create: `src/sketch/compile-layout.test.ts`

The core algorithm: find shared edges between rooms, generate interior walls at shared edges, generate exterior walls at non-shared edges.

- [ ] **Step 1: Write failing tests for edge detection and wall generation**

```typescript
import { describe, it, expect } from 'vitest';
import { compileLayout } from './compile-layout';
import type { SimpleFloorPlanInput } from './types';

describe('compileLayout', () => {
  describe('wall generation', () => {
    it('generates 4 exterior walls for a single room', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Single Room',
        rooms: [{ label: 'Living', x: 0, y: 0, width: 400, depth: 300 }],
      };
      const plan = compileLayout(input);
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      expect(exterior).toHaveLength(4);
      // All walls should have thickness 20
      for (const w of exterior) {
        expect(w.thickness).toBe(20);
      }
    });

    it('generates an interior wall between two adjacent rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Two Rooms',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
      expect(interior[0].thickness).toBe(10);
      // Shared edge at x=300, from y=0 to y=250 (overlap region)
      expect(interior[0].start).toEqual({ x: 300, y: 0 });
      expect(interior[0].end).toEqual({ x: 300, y: 250 });
    });

    it('generates correct exterior walls for two adjacent rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Two Rooms',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      // Top: 2 segments (Kitchen top + Living top, potentially merged)
      // Bottom: Kitchen bottom + Living bottom (different y-ends, so separate)
      // Left: Kitchen left
      // Right: Living right
      // Plus the step on the bottom-right where Living extends below Kitchen
      expect(exterior.length).toBeGreaterThanOrEqual(5);
    });

    it('snaps coordinates to 10cm grid', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Snapped',
        rooms: [{ label: 'Room', x: 3, y: 7, width: 303, depth: 248 }],
      };
      const plan = compileLayout(input);
      // All wall coordinates should be multiples of 10
      for (const w of plan.walls) {
        expect(w.start.x % 10).toBe(0);
        expect(w.start.y % 10).toBe(0);
        expect(w.end.x % 10).toBe(0);
        expect(w.end.y % 10).toBe(0);
      }
    });

    it('detects shared edges within snap tolerance', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Near-aligned',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 305, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      // 5cm gap should snap to shared edge → interior wall
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
    });

    it('handles rooms stacked vertically', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Stacked',
        rooms: [
          { label: 'Bedroom', x: 0, y: 0, width: 400, depth: 300 },
          { label: 'Living', x: 0, y: 300, width: 400, depth: 350 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
      // Horizontal wall at y=300
      expect(interior[0].start.y).toBe(300);
      expect(interior[0].end.y).toBe(300);
    });

    it('handles L-shaped layouts (3 rooms, one row shorter)', () => {
      const input: SimpleFloorPlanInput = {
        name: 'L-Shape',
        rooms: [
          { label: 'Bedroom', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 250 },
          { label: 'Kitchen', x: 300, y: 250, width: 400, depth: 200 },
        ],
      };
      const plan = compileLayout(input);
      // Should have interior walls between Bedroom-Living and Living-Kitchen
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(2);
      // Exterior walls should trace the L-shaped perimeter
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      expect(exterior.length).toBeGreaterThanOrEqual(6); // L-shape has 6 sides
    });
  });

  describe('room polygons', () => {
    it('generates rectangular polygons for rect rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 100, y: 100, width: 300, depth: 200 }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms).toHaveLength(1);
      expect(plan.rooms[0].polygon).toEqual([
        { x: 100, y: 100 },
        { x: 400, y: 100 },
        { x: 400, y: 300 },
        { x: 100, y: 300 },
      ]);
    });

    it('preserves polygon for polygon rooms', () => {
      const poly = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 500 }, { x: 0, y: 500 }];
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'L-Room', polygon: poly }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].polygon).toEqual(poly);
    });

    it('assigns colors by keyword matching on label', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [
          { label: 'Master Bedroom', x: 0, y: 0, width: 400, depth: 300 },
          { label: 'Kitchen', x: 400, y: 0, width: 300, depth: 300 },
          { label: 'Main Bathroom', x: 0, y: 300, width: 300, depth: 200 },
        ],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].color).toBe('#E3F2FD'); // bedroom blue
      expect(plan.rooms[1].color).toBe('#FFF3E0'); // kitchen orange
      expect(plan.rooms[2].color).toBe('#E0F7FA'); // bathroom cyan
    });

    it('respects explicit color override', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 0, y: 0, width: 300, depth: 200, color: '#FF0000' }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].color).toBe('#FF0000');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/compile-layout.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement compileLayout core**

Create `src/sketch/compile-layout.ts`:

```typescript
import { nanoid } from 'nanoid';
import type { FloorPlan, Wall, Room, Point } from './types';
import type { SimpleFloorPlanInput, SimpleRoomInput } from './types';
import { ROOM_COLORS } from './defaults';
import { shoelaceArea } from './geometry';

// ─── Constants ──────────────────────────────────────────────────────────────

const EXTERIOR_THICKNESS = 20;
const INTERIOR_THICKNESS = 10;
const WALL_HEIGHT = 250;
const SNAP_GRID = 10;
const SNAP_TOLERANCE = 15; // rooms within 15cm are considered adjacent

// ─── Helpers ────────────────────────────────────────────────────────────────

function snap(v: number): number {
  return Math.round(v / SNAP_GRID) * SNAP_GRID;
}

interface Rect {
  label: string;
  type?: string;
  x: number;
  y: number;
  w: number;
  d: number;
  color?: string;
  polygon?: Point[];
}

function toRect(room: SimpleRoomInput): Rect {
  if ('polygon' in room) {
    const xs = room.polygon.map(p => p.x);
    const ys = room.polygon.map(p => p.y);
    const x = snap(Math.min(...xs));
    const y = snap(Math.min(...ys));
    return {
      label: room.label,
      type: room.type,
      x,
      y,
      w: snap(Math.max(...xs)) - x,
      d: snap(Math.max(...ys)) - y,
      color: room.color,
      polygon: room.polygon.map(p => ({ x: snap(p.x), y: snap(p.y) })),
    };
  }
  // Snap endpoints, derive dimensions (preserves intended room extent)
  const x = snap(room.x);
  const y = snap(room.y);
  const x2 = snap(room.x + room.width);
  const y2 = snap(room.y + room.depth);
  return {
    label: room.label,
    type: room.type,
    x,
    y,
    w: x2 - x,
    d: y2 - y,
    color: room.color,
  };
}

// ─── Edge detection ─────────────────────────────────────────────────────────

interface Edge {
  axis: 'vertical' | 'horizontal';
  pos: number;       // x for vertical, y for horizontal
  start: number;     // start of the edge (y for vertical, x for horizontal)
  end: number;       // end of the edge
  roomIdx: number;
  side: 'left' | 'right' | 'top' | 'bottom';
}

function roomEdges(r: Rect, idx: number): Edge[] {
  return [
    { axis: 'vertical', pos: r.x, start: r.y, end: r.y + r.d, roomIdx: idx, side: 'left' },
    { axis: 'vertical', pos: r.x + r.w, start: r.y, end: r.y + r.d, roomIdx: idx, side: 'right' },
    { axis: 'horizontal', pos: r.y, start: r.x, end: r.x + r.w, roomIdx: idx, side: 'top' },
    { axis: 'horizontal', pos: r.y + r.d, start: r.x, end: r.x + r.w, roomIdx: idx, side: 'bottom' },
  ];
}

interface SharedEdge {
  axis: 'vertical' | 'horizontal';
  pos: number;
  start: number;
  end: number;
  roomA: number;
  roomB: number;
}

function findSharedEdges(rects: Rect[]): SharedEdge[] {
  const allEdges: Edge[] = rects.flatMap((r, i) => roomEdges(r, i));
  const shared: SharedEdge[] = [];

  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      const a = allEdges[i];
      const b = allEdges[j];
      if (a.axis !== b.axis) continue;
      if (a.roomIdx === b.roomIdx) continue;
      // Must be opposing sides
      if (a.axis === 'vertical' && !((a.side === 'right' && b.side === 'left') || (a.side === 'left' && b.side === 'right'))) continue;
      if (a.axis === 'horizontal' && !((a.side === 'bottom' && b.side === 'top') || (a.side === 'top' && b.side === 'bottom'))) continue;
      // Position within snap tolerance
      if (Math.abs(a.pos - b.pos) > SNAP_TOLERANCE) continue;
      // Overlap in the perpendicular direction
      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapEnd <= overlapStart) continue;

      shared.push({
        axis: a.axis,
        pos: snap((a.pos + b.pos) / 2), // average & snap
        start: overlapStart,
        end: overlapEnd,
        roomA: a.roomIdx,
        roomB: b.roomIdx,
      });
    }
  }
  return shared;
}

// ─── Wall generation ────────────────────────────────────────────────────────

function generateWalls(rects: Rect[], sharedEdges: SharedEdge[]): Wall[] {
  const walls: Wall[] = [];

  // Interior walls from shared edges
  for (const se of sharedEdges) {
    const start: Point = se.axis === 'vertical'
      ? { x: se.pos, y: se.start }
      : { x: se.start, y: se.pos };
    const end: Point = se.axis === 'vertical'
      ? { x: se.pos, y: se.end }
      : { x: se.end, y: se.pos };
    walls.push({
      id: nanoid(),
      start,
      end,
      thickness: INTERIOR_THICKNESS,
      height: WALL_HEIGHT,
      type: 'interior',
      openings: [],
    });
  }

  // Exterior walls: room edges not covered by shared edges
  // Build a set of "claimed" segments per room edge
  for (let ri = 0; ri < rects.length; ri++) {
    const r = rects[ri];
    const edges = roomEdges(r, ri);

    for (const edge of edges) {
      // Find shared edges that cover parts of this edge
      const covering = sharedEdges.filter(se =>
        se.axis === edge.axis &&
        Math.abs(se.pos - edge.pos) <= SNAP_TOLERANCE &&
        (se.roomA === ri || se.roomB === ri)
      );

      // Compute uncovered segments
      let uncovered = [{ start: edge.start, end: edge.end }];
      for (const se of covering) {
        const next: { start: number; end: number }[] = [];
        for (const seg of uncovered) {
          // Subtract se from seg
          if (se.start >= seg.end || se.end <= seg.start) {
            next.push(seg); // no overlap
          } else {
            if (se.start > seg.start) next.push({ start: seg.start, end: se.start });
            if (se.end < seg.end) next.push({ start: se.end, end: seg.end });
          }
        }
        uncovered = next;
      }

      // Generate exterior wall for each uncovered segment
      for (const seg of uncovered) {
        if (seg.end - seg.start < SNAP_GRID) continue; // skip tiny segments
        const start: Point = edge.axis === 'vertical'
          ? { x: edge.pos, y: seg.start }
          : { x: seg.start, y: edge.pos };
        const end: Point = edge.axis === 'vertical'
          ? { x: edge.pos, y: seg.end }
          : { x: seg.end, y: edge.pos };
        walls.push({
          id: nanoid(),
          start,
          end,
          thickness: EXTERIOR_THICKNESS,
          height: WALL_HEIGHT,
          type: 'exterior',
          openings: [],
        });
      }
    }
  }

  return walls;
}

// ─── Color inference ────────────────────────────────────────────────────────

const LABEL_PATTERNS: [RegExp, string][] = [
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

function resolveRoomType(label: string, explicit?: string): string {
  if (explicit) return explicit;
  for (const [pattern, type] of LABEL_PATTERNS) {
    if (pattern.test(label)) return type;
  }
  return 'other';
}

function resolveColor(label: string, explicitType?: string, explicitColor?: string): string {
  if (explicitColor) return explicitColor;
  const type = resolveRoomType(label, explicitType);
  return ROOM_COLORS[type] ?? '#FAFAFA';
}

// ─── Room generation ────────────────────────────────────────────────────────

function generateRooms(rects: Rect[]): Room[] {
  return rects.map(r => {
    const polygon = r.polygon ?? [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.d },
      { x: r.x, y: r.y + r.d },
    ];
    const type = resolveRoomType(r.label, r.type);
    return {
      id: nanoid(),
      label: r.label,
      type: type as Room['type'],
      polygon,
      color: resolveColor(r.label, r.type, r.color),
      area: shoelaceArea(polygon),
    };
  });
}

// ─── Main compiler ──────────────────────────────────────────────────────────

export function compileLayout(input: SimpleFloorPlanInput): FloorPlan {
  // 1. Normalize rooms to rects
  const rects = input.rooms.map(toRect);

  // 2. Find shared edges
  const sharedEdges = findSharedEdges(rects);

  // 3. Generate walls
  const walls = generateWalls(rects, sharedEdges);

  // 4. Generate rooms
  const rooms = generateRooms(rects);

  // 5. Convert furniture (room-relative → absolute)
  const furniture = (input.furniture ?? []).map(f => {
    const room = rects.find(r => r.label === f.room);
    const rx = room?.x ?? 0;
    const ry = room?.y ?? 0;
    return {
      id: nanoid(),
      type: f.type,
      position: { x: rx + f.x, y: ry + f.y },
      rotation: f.rotation ?? 0,
      width: f.width,
      depth: f.depth,
      label: f.label,
    };
  });

  // 6. Place openings on walls
  placeOpenings(input.openings ?? [], walls, rects, sharedEdges);

  // 7. Compute canvas from bounding box
  const allX = walls.flatMap(w => [w.start.x, w.end.x]);
  const allY = walls.flatMap(w => [w.start.y, w.end.y]);
  const pad = 100;
  const canvas = {
    width: Math.max((Math.max(...allX) - Math.min(...allX)) + pad * 2, 400),
    height: Math.max((Math.max(...allY) - Math.min(...allY)) + pad * 2, 400),
    gridSize: SNAP_GRID,
  };

  return {
    version: 1,
    id: nanoid(),
    name: input.name,
    units: input.units ?? 'metric',
    canvas,
    walls,
    rooms,
    furniture,
    annotations: [],
    metadata: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: 'ai',
    },
  };
}

// ─── Opening placement ──────────────────────────────────────────────────────

function placeOpenings(
  openings: NonNullable<SimpleFloorPlanInput['openings']>,
  walls: Wall[],
  rects: Rect[],
  sharedEdges: SharedEdge[],
): void {
  const DEFAULT_WIDTHS: Record<string, number> = { door: 80, window: 120, opening: 90 };

  for (const o of openings) {
    const width = o.width ?? DEFAULT_WIDTHS[o.type] ?? 80;
    let targetWall: Wall | undefined;
    let offset: number;

    if (o.between) {
      // Find interior wall between the two rooms
      const [labelA, labelB] = o.between;
      const idxA = rects.findIndex(r => r.label === labelA);
      const idxB = rects.findIndex(r => r.label === labelB);
      if (idxA < 0 || idxB < 0) continue;

      const se = sharedEdges.find(e =>
        (e.roomA === idxA && e.roomB === idxB) || (e.roomA === idxB && e.roomB === idxA)
      );
      if (!se) continue;

      // Find the wall on this shared edge
      targetWall = walls.find(w =>
        w.type === 'interior' &&
        ((se.axis === 'vertical' && w.start.x === se.pos && w.start.y === se.start) ||
         (se.axis === 'horizontal' && w.start.y === se.pos && w.start.x === se.start))
      );
      if (!targetWall) continue;

      const wallLen = se.end - se.start;
      const pos = o.position ?? 0.5;
      offset = snap(pos * wallLen - width / 2);
      offset = Math.max(20, Math.min(offset, wallLen - width - 20));
    } else if (o.room && o.wall) {
      // Find exterior wall on the specified side
      const ri = rects.findIndex(r => r.label === o.room);
      if (ri < 0) continue;
      const r = rects[ri];

      let wallStart: Point, wallEnd: Point;
      switch (o.wall) {
        case 'north': wallStart = { x: r.x, y: r.y }; wallEnd = { x: r.x + r.w, y: r.y }; break;
        case 'south': wallStart = { x: r.x, y: r.y + r.d }; wallEnd = { x: r.x + r.w, y: r.y + r.d }; break;
        case 'west':  wallStart = { x: r.x, y: r.y }; wallEnd = { x: r.x, y: r.y + r.d }; break;
        case 'east':  wallStart = { x: r.x + r.w, y: r.y }; wallEnd = { x: r.x + r.w, y: r.y + r.d }; break;
      }

      targetWall = walls.find(w =>
        w.type === 'exterior' &&
        w.start.x === wallStart!.x && w.start.y === wallStart!.y &&
        w.end.x === wallEnd!.x && w.end.y === wallEnd!.y
      );
      if (!targetWall) continue;

      const wallLen = o.wall === 'north' || o.wall === 'south' ? r.w : r.d;
      const pos = o.position ?? 0.5;
      offset = snap(pos * wallLen - width / 2);
      offset = Math.max(20, Math.min(offset, wallLen - width - 20));
    } else {
      continue;
    }

    targetWall.openings.push({
      id: nanoid(),
      type: o.type,
      offset,
      width,
      properties: {
        swingDirection: o.properties?.swingDirection,
        windowType: o.properties?.windowType,
      },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/compile-layout.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/compile-layout.ts src/sketch/compile-layout.test.ts
git commit -m "feat: compileLayout — room-first to FloorPlan compiler"
```

---

### Task 3: Opening Placement Tests

**Files:**
- Modify: `src/sketch/compile-layout.test.ts`

- [ ] **Step 1: Add tests for opening placement**

```typescript
// Add to compile-layout.test.ts

describe('opening placement', () => {
  it('places a door between two rooms on the shared wall', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Test',
      rooms: [
        { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
        { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
      ],
      openings: [{ type: 'door', between: ['Kitchen', 'Living'] }],
    };
    const plan = compileLayout(input);
    const interior = plan.walls.filter(w => w.type === 'interior');
    expect(interior).toHaveLength(1);
    expect(interior[0].openings).toHaveLength(1);
    expect(interior[0].openings[0].type).toBe('door');
    expect(interior[0].openings[0].width).toBe(80); // default
  });

  it('places a window on an exterior wall by direction', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Test',
      rooms: [{ label: 'Bedroom', x: 0, y: 0, width: 400, depth: 300 }],
      openings: [{ type: 'window', room: 'Bedroom', wall: 'north' }],
    };
    const plan = compileLayout(input);
    const northWall = plan.walls.find(w =>
      w.type === 'exterior' && w.start.y === 0 && w.end.y === 0
    );
    expect(northWall).toBeDefined();
    expect(northWall!.openings).toHaveLength(1);
    expect(northWall!.openings[0].type).toBe('window');
    expect(northWall!.openings[0].width).toBe(120); // default
  });

  it('centers openings by default (position=0.5)', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Test',
      rooms: [{ label: 'Room', x: 0, y: 0, width: 400, depth: 300 }],
      openings: [{ type: 'window', room: 'Room', wall: 'north', width: 100 }],
    };
    const plan = compileLayout(input);
    const northWall = plan.walls.find(w =>
      w.type === 'exterior' && w.start.y === 0 && w.end.y === 0
    );
    // Centered: (400 * 0.5) - (100 / 2) = 150
    expect(northWall!.openings[0].offset).toBe(150);
  });

  it('respects custom position along wall', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Test',
      rooms: [{ label: 'Room', x: 0, y: 0, width: 400, depth: 300 }],
      openings: [{ type: 'door', room: 'Room', wall: 'south', position: 0.2 }],
    };
    const plan = compileLayout(input);
    const southWall = plan.walls.find(w =>
      w.type === 'exterior' && w.start.y === 300 && w.end.y === 300
    );
    expect(southWall!.openings).toHaveLength(1);
    // position 0.2 of 400 = 80, minus half door width (40) = 40, snapped = 40
    expect(southWall!.openings[0].offset).toBe(40);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/sketch/compile-layout.test.ts --reporter=verbose`
Expected: All PASS (opening placement was implemented in Task 2)

- [ ] **Step 3: Commit**

```bash
git add src/sketch/compile-layout.test.ts
git commit -m "test: opening placement tests for compileLayout"
```

---

### Task 4: Furniture + Full Integration Tests

**Files:**
- Modify: `src/sketch/compile-layout.test.ts`

- [ ] **Step 1: Add furniture and end-to-end tests**

```typescript
// Add to compile-layout.test.ts

describe('furniture placement', () => {
  it('converts room-relative furniture to absolute coordinates', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Test',
      rooms: [{ label: 'Bedroom', x: 200, y: 100, width: 400, depth: 300 }],
      furniture: [{ type: 'bed-double', room: 'Bedroom', x: 20, y: 50, width: 160, depth: 200 }],
    };
    const plan = compileLayout(input);
    expect(plan.furniture).toHaveLength(1);
    expect(plan.furniture[0].position).toEqual({ x: 220, y: 150 });
  });
});

describe('full compilation', () => {
  it('compiles a 2BR apartment layout', () => {
    const input: SimpleFloorPlanInput = {
      name: 'NYC 2BR',
      rooms: [
        { label: 'Bedroom', x: 0, y: 0, width: 330, depth: 250 },
        { label: 'Bathroom', x: 330, y: 0, width: 150, depth: 250 },
        { label: 'Primary Bedroom', x: 480, y: 0, width: 320, depth: 270 },
        { label: 'Living & Dining', x: 0, y: 250, width: 500, depth: 360 },
        { label: 'Kitchen', x: 500, y: 250, width: 300, depth: 200 },
        { label: 'Foyer', x: 330, y: 610, width: 260, depth: 160 },
      ],
      openings: [
        { type: 'door', between: ['Bedroom', 'Living & Dining'] },
        { type: 'door', between: ['Primary Bedroom', 'Kitchen'] },
        { type: 'door', between: ['Living & Dining', 'Foyer'] },
        { type: 'window', room: 'Bedroom', wall: 'north' },
        { type: 'window', room: 'Primary Bedroom', wall: 'north' },
        { type: 'window', room: 'Living & Dining', wall: 'west' },
      ],
      furniture: [
        { type: 'bed-double', room: 'Bedroom', x: 20, y: 20, width: 160, depth: 200 },
        { type: 'bed-double', room: 'Primary Bedroom', x: 20, y: 20, width: 160, depth: 200 },
        { type: 'sofa', room: 'Living & Dining', x: 50, y: 50, width: 220, depth: 90 },
      ],
    };
    const plan = compileLayout(input);

    // Structure checks
    expect(plan.rooms).toHaveLength(6);
    expect(plan.walls.length).toBeGreaterThan(0);
    expect(plan.furniture).toHaveLength(3);

    // All rooms have areas
    for (const r of plan.rooms) {
      expect(r.area).toBeGreaterThan(0);
    }

    // Has both interior and exterior walls
    expect(plan.walls.some(w => w.type === 'interior')).toBe(true);
    expect(plan.walls.some(w => w.type === 'exterior')).toBe(true);

    // Openings placed on walls
    const wallsWithOpenings = plan.walls.filter(w => w.openings.length > 0);
    expect(wallsWithOpenings.length).toBeGreaterThanOrEqual(6);

    // FloorPlan structure is valid
    expect(plan.version).toBe(1);
    expect(plan.name).toBe('NYC 2BR');
    expect(plan.units).toBe('metric');
  });

  it('output is compatible with floorPlanToSvg', async () => {
    // Import SVG renderer to verify compiled output renders without error
    const { floorPlanToSvg } = await import('./svg');
    const input: SimpleFloorPlanInput = {
      name: 'SVG Test',
      rooms: [
        { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
        { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
      ],
      openings: [
        { type: 'door', between: ['Kitchen', 'Living'] },
        { type: 'window', room: 'Kitchen', wall: 'north' },
      ],
    };
    const plan = compileLayout(input);
    const svg = floorPlanToSvg(plan);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('id="rooms"');
    expect(svg).toContain('id="walls"');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/sketch/compile-layout.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/sketch/compile-layout.test.ts
git commit -m "test: furniture and end-to-end tests for compileLayout"
```

---

### Task 5: Tool Integration

**Files:**
- Modify: `src/sketch/tools.ts:60-116` (handleGenerateFloorPlan)
- Modify: `src/index.ts:407-408` (inputSchema)

The `generate_floor_plan` tool should accept EITHER the existing `FloorPlanInput` or the new `SimpleFloorPlanInput`. Try the full schema first (more specific — has `version`, `walls`, etc.), then fall back to the simple schema. This avoids ambiguity since a valid `FloorPlanInput` could also partially match `SimpleFloorPlanInput`.

- [ ] **Step 1: Update handleGenerateFloorPlan to accept both formats**

In `src/sketch/tools.ts`, modify `handleGenerateFloorPlan`:

```typescript
// Add import at top of file
import { SimpleFloorPlanInputSchema } from './types';
import { compileLayout } from './compile-layout';

// Replace the existing handleGenerateFloorPlan function:
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

  // Compute room areas (if not already set by compiler)
  for (const room of floorPlan.rooms) {
    if (room.area === undefined) {
      room.area = shoelaceArea(room.polygon);
    }
  }

  // Render SVG + persist
  const svg = floorPlanToSvg(floorPlan);
  await saveSketch(ctx.db, floorPlan.id, floorPlan, svg);
  ctx.setState({ ...ctx.state, sketchId: floorPlan.id, plan: floorPlan });

  // CTA — fallback chain
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
```

- [ ] **Step 2: Update the inputSchema in index.ts to accept either format**

In `src/index.ts`, change the inputSchema at line ~407-408:

```typescript
// Before:
inputSchema: {
  plan: FloorPlanInputSchema.describe('The complete FloorPlan JSON object'),
},

// After:
inputSchema: {
  plan: SimpleFloorPlanInputSchema.describe('Room-first floor plan input (recommended). Also accepts full FloorPlanInput with version/walls/rooms.'),
},
```

Add the `SimpleFloorPlanInputSchema` import at the top of `index.ts`. The simple schema is advertised in MCP so LLMs see its structure. The full schema is still accepted at runtime via the fallback in `handleGenerateFloorPlan`.

- [ ] **Step 3: Run all tests to verify nothing is broken**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git commit -m "feat: generate_floor_plan accepts room-first SimpleFloorPlanInput"
```

---

### Task 6: Update Tool Instructions

**Files:**
- Modify: `src/index.ts:335-406` (tool description)

Replace the COPY MODE instructions with room-first schema guidance. Keep DESIGN MODE for backward compatibility.

- [ ] **Step 1: Update the tool description**

Replace the COPY MODE section in the tool description (lines 341-376 approximately) with instructions that reference the simple schema:

```
═══ COPY MODE (user provided a reference floor plan image) ═══
Your job is REPLICATION. Do NOT call list_templates or search_design_knowledge. Use the ROOM-FIRST INPUT FORMAT.

Step 1 — EXTRACT DIMENSIONS:
Read every dimension label. Convert to cm (ft×30.48, in×2.54). List each room with label, width, depth. Derive missing dimensions by subtraction from the overall footprint or by calibrating from a known object (door=80cm, toilet=40cm). Write your dimension table ONCE — do NOT recalculate.

Step 2 — POSITION ROOMS:
Place rooms as rectangles with {label, x, y, width, depth}. Start the first room at x=0, y=0. Place adjacent rooms by adding width (horizontal neighbor) or depth (vertical neighbor). Rooms that touch at the same coordinate get an interior wall automatically. No gaps needed — the system handles wall thickness.

Rules:
- Open-plan spaces (kitchen/living/dining with no wall) = ONE room, not separate rooms
- Walk-in closets: add parent field pointing to the bedroom label
- L-shaped rooms: use polygon override instead of x/y/width/depth
- Snap to 10cm grid (the system does this, but round your numbers too)

Step 3 — ADD OPENINGS:
Use {type, between: [room1, room2]} for interior doors. Use {type, room, wall: "north"|"south"|"east"|"west"} for exterior doors/windows. Default position is centered; set position: 0.0-1.0 to shift along the wall.

Step 4 — ADD FURNITURE:
Positions are RELATIVE to the room's top-left corner: {type, room: "Bedroom", x: 20, y: 30, width, depth}. Place ONLY furniture visible in the reference image.

Step 5 — GENERATE:
Call generate_floor_plan with {name, rooms, openings, furniture}. The system generates all walls, room polygons, colors, and canvas automatically. Then call preview_sketch to verify.
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "docs: update copy-mode instructions for room-first input"
```

---

### Task 7: Deploy + Manual Test

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 2: Deploy**

Run: `bash deploy.sh`
Expected: Deployment successful

- [ ] **Step 3: Manual test with a reference floor plan**

Use the RoomSketcher MCP to copy the NYC 2BR floor plan. Verify:
- All 6+ rooms appear with correct proportions
- Interior walls exist between adjacent rooms
- Exterior walls trace the building perimeter
- Doors and windows are placed on correct walls
- Furniture appears inside the correct rooms
- The SVG renders correctly in the browser sketcher
