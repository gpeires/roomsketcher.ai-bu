# Surgical Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude to surgically iterate on floor plan sketches using label-based operations with side-by-side visual comparison, replacing the current regenerate-from-scratch workflow.

**Architecture:** A resolution layer (`resolve.ts`) translates room labels to IDs and does geometric wall-to-room lookups. A compiler (`high-level-changes.ts`) converts high-level label-based operations into existing low-level ID-based changes. `preview_sketch` returns source + sketch images side-by-side. Tool descriptions are rewritten to guide Claude through structured visual comparison and surgical single-room fixes.

**Tech Stack:** TypeScript, Zod, Vitest, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-23-surgical-iteration-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/sketch/resolve.ts` | Label→ID resolution, wall-to-room geometric lookup, furniture-in-room lookup, relative position resolution |
| `src/sketch/resolve.test.ts` | Unit tests for all resolution functions |
| `src/sketch/high-level-changes.ts` | High-level change Zod schemas, compiler from high-level→low-level changes, `processChanges` orchestrator |
| `src/sketch/high-level-changes.test.ts` | Unit tests for each high-level operation's compilation |

### Modified Files
| File | What Changes |
|------|-------------|
| `src/sketch/types.ts:108-113` | Add `source_image_url` to metadata schema |
| `src/sketch/types.ts:118-134` | Add `set_envelope` to `ChangeSchema` discriminated union |
| `src/sketch/changes.ts:21-126` | Add `set_envelope` case to `applyChanges` switch |
| `src/types.ts:116-120` | Add `sourceImageUrl?: string` to `SketchSession` |
| `src/sketch/tools.ts:362-391` | Update `handlePreviewSketch` to return source image alongside sketch |
| `src/sketch/tools.ts:393-534` | Update `handleAnalyzeImage` to store source URL in session state |
| `src/sketch/tools.ts:161-205` | Update `handleUpdateSketch` to accept and process high-level changes |
| `src/index.ts:336-395` | Rewrite `generate_floor_plan` Copy Mode tool description |
| `src/index.ts:479-508` | Rewrite `analyze_floor_plan_image` tool description |
| `src/index.ts:510-533` | Rewrite `update_sketch` tool description + add `high_level_changes` input |
| `src/index.ts:562-575` | Rewrite `preview_sketch` tool description + add `include_source` input |

---

## Task 1: Add `set_envelope` Low-Level Change Type

**Files:**
- Modify: `src/sketch/types.ts:118-134`
- Modify: `src/sketch/changes.ts:21-126`
- Modify: `src/sketch/changes.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/sketch/changes.test.ts`, add at the end of the `describe('applyChanges', ...)` block:

```ts
it('sets the envelope polygon', () => {
  const plan = makePlan();
  const envelope = [
    { x: 0, y: 0 }, { x: 500, y: 0 },
    { x: 500, y: 400 }, { x: 0, y: 400 },
  ];
  const result = applyChanges(plan, [
    { type: 'set_envelope', polygon: envelope },
  ]);
  expect(result.envelope).toEqual(envelope);
  expect(result.metadata.source).toBe('mixed');
});

it('replaces existing envelope', () => {
  const plan = makePlan();
  plan.envelope = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const newEnvelope = [
    { x: 0, y: 0 }, { x: 600, y: 0 },
    { x: 600, y: 500 }, { x: 0, y: 500 },
  ];
  const result = applyChanges(plan, [
    { type: 'set_envelope', polygon: newEnvelope },
  ]);
  expect(result.envelope).toEqual(newEnvelope);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/changes.test.ts --reporter=verbose`
Expected: FAIL — `set_envelope` not recognized in ChangeSchema

- [ ] **Step 3: Add `set_envelope` to `ChangeSchema`**

In `src/sketch/types.ts`, add to the `ChangeSchema` discriminated union array (after the `remove_furniture` entry at line 132):

```ts
z.object({ type: z.literal('set_envelope'), polygon: z.array(PointSchema).min(3) }),
```

- [ ] **Step 4: Add `set_envelope` handler to `applyChanges`**

In `src/sketch/changes.ts`, add a new case in the switch statement (before the closing `}` of the switch, around line 126):

```ts
case 'set_envelope':
  result.envelope = change.polygon;
  break;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sketch/changes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass (no regressions)

- [ ] **Step 7: Commit**

```bash
git add src/sketch/types.ts src/sketch/changes.ts src/sketch/changes.test.ts
git -c commit.gpgsign=false commit -m "feat: add set_envelope low-level change type"
```

---

## Task 2: Add `source_image_url` to Metadata and Session

**Files:**
- Modify: `src/sketch/types.ts:108-113`
- Modify: `src/types.ts:116-120`

- [ ] **Step 1: Add `source_image_url` to FloorPlan metadata**

In `src/sketch/types.ts`, find the metadata object inside `FloorPlanSchema` (lines 108-112). Add the new field:

```ts
metadata: z.object({
  created_at: z.string(),
  updated_at: z.string(),
  source: z.enum(['ai', 'sketcher', 'mixed']),
  source_image_url: z.string().optional(),
}),
```

Also find the metadata in `FloorPlanInputSchema` (lines 187-191) and add the same field there.

- [ ] **Step 2: Add `sourceImageUrl` to `SketchSession`**

In `src/types.ts`, update the `SketchSession` interface (line 116-120):

```ts
export interface SketchSession {
  sketchId?: string;
  plan?: FloorPlan;
  cta?: SessionCTAState;
  sourceImageUrl?: string;
}
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (optional fields don't break existing tests)

- [ ] **Step 4: Commit**

```bash
git add src/sketch/types.ts src/types.ts
git -c commit.gpgsign=false commit -m "feat: add source_image_url to metadata and session"
```

---

## Task 3: Build the Resolution Layer

**Files:**
- Create: `src/sketch/resolve.ts`
- Create: `src/sketch/resolve.test.ts`

- [ ] **Step 1: Write failing tests for `findRoomByLabel`**

Create `src/sketch/resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findRoomByLabel } from './resolve';
import type { FloorPlan } from './types';

function makeTestPlan(): FloorPlan {
  return {
    version: 1,
    id: 'test-plan',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w2', start: { x: 400, y: 0 }, end: { x: 400, y: 300 }, thickness: 10, height: 250, type: 'interior', openings: [] },
      { id: 'w3', start: { x: 400, y: 0 }, end: { x: 800, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w4', start: { x: 0, y: 0 }, end: { x: 0, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w5', start: { x: 0, y: 300 }, end: { x: 400, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w6', start: { x: 400, y: 300 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w7', start: { x: 800, y: 0 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ],
    rooms: [
      { id: 'r1', label: 'Kitchen', type: 'kitchen', polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], color: '#E8F5E9', area: 12 },
      { id: 'r2', label: 'Living Room', type: 'living', polygon: [{ x: 400, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 400, y: 300 }], color: '#FFF3E0', area: 12 },
    ],
    furniture: [
      { id: 'f1', type: 'fridge', position: { x: 50, y: 50 }, rotation: 0, width: 70, depth: 70 },
      { id: 'f2', type: 'sofa-3seat', position: { x: 500, y: 100 }, rotation: 0, width: 200, depth: 90 },
    ],
    annotations: [],
    metadata: { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', source: 'ai' },
  };
}

describe('findRoomByLabel', () => {
  it('finds room by exact label', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'Kitchen');
    expect(room.id).toBe('r1');
  });

  it('finds room case-insensitively', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'kitchen');
    expect(room.id).toBe('r1');
  });

  it('finds room with partial match', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'living room');
    expect(room.id).toBe('r2');
  });

  it('throws descriptive error when not found', () => {
    const plan = makeTestPlan();
    expect(() => findRoomByLabel(plan, 'Bedroom')).toThrow(/not found/i);
    expect(() => findRoomByLabel(plan, 'Bedroom')).toThrow(/Kitchen/);
    expect(() => findRoomByLabel(plan, 'Bedroom')).toThrow(/Living Room/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/resolve.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `findRoomByLabel`**

Create `src/sketch/resolve.ts`:

```ts
import type { FloorPlan, Room, Wall, FurnitureItem, Point } from './types';
import { pointInPolygon, polygonBoundingBox } from './geometry';

const SNAP_TOLERANCE = 20; // cm — match compile-layout.ts
const MIN_OVERLAP = 10;    // cm — minimum edge overlap to count as wall-on-side
const WALL_CLEARANCE = 10; // cm — furniture offset from wall

/**
 * Find a room by label (case-insensitive).
 * Throws descriptive error listing available labels if not found.
 */
export function findRoomByLabel(plan: FloorPlan, label: string): Room {
  const lower = label.toLowerCase();
  // Exact match first (case-insensitive)
  const exact = plan.rooms.find(r => r.label.toLowerCase() === lower);
  if (exact) return exact;
  // Partial match — label contains search or search contains label
  const partial = plan.rooms.find(r =>
    r.label.toLowerCase().includes(lower) || lower.includes(r.label.toLowerCase())
  );
  if (partial) return partial;
  const available = plan.rooms.map(r => r.label).join(', ');
  throw new Error(`Room "${label}" not found. Available rooms: ${available}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/resolve.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Write failing tests for `findRoomWalls` and `findRoomWallOnSide`**

Add to `src/sketch/resolve.test.ts`:

```ts
import { findRoomByLabel, findRoomWalls, findRoomWallOnSide, findSharedWall } from './resolve';

describe('findRoomWalls', () => {
  it('finds all walls belonging to a room', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const walls = findRoomWalls(plan, kitchen);
    // Kitchen has 4 edges: north (w1), east (w2), south (w5), west (w4)
    expect(walls.length).toBeGreaterThanOrEqual(4);
    const wallIds = walls.map(w => w.id);
    expect(wallIds).toContain('w1'); // north
    expect(wallIds).toContain('w2'); // east (shared)
    expect(wallIds).toContain('w4'); // west
    expect(wallIds).toContain('w5'); // south
  });
});

describe('findRoomWallOnSide', () => {
  it('finds the north wall of a room', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const wall = findRoomWallOnSide(plan, kitchen, 'north');
    expect(wall).not.toBeNull();
    expect(wall!.id).toBe('w1');
  });

  it('finds the east wall (shared) of kitchen', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const wall = findRoomWallOnSide(plan, kitchen, 'east');
    expect(wall).not.toBeNull();
    expect(wall!.id).toBe('w2');
  });

  it('returns null for a side with no wall', () => {
    const plan = makeTestPlan();
    // Remove west wall
    plan.walls = plan.walls.filter(w => w.id !== 'w4');
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const wall = findRoomWallOnSide(plan, kitchen, 'west');
    expect(wall).toBeNull();
  });
});

describe('findSharedWall', () => {
  it('finds the shared wall between two adjacent rooms', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const living = findRoomByLabel(plan, 'Living Room');
    const wall = findSharedWall(plan, kitchen, living);
    expect(wall).not.toBeNull();
    expect(wall!.id).toBe('w2');
  });

  it('returns null for non-adjacent rooms', () => {
    const plan = makeTestPlan();
    // Add a third room far away
    plan.rooms.push({
      id: 'r3', label: 'Bedroom', type: 'bedroom',
      polygon: [{ x: 0, y: 500 }, { x: 300, y: 500 }, { x: 300, y: 800 }, { x: 0, y: 800 }],
      color: '#E3F2FD', area: 9,
    });
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const bedroom = findRoomByLabel(plan, 'Bedroom');
    const wall = findSharedWall(plan, kitchen, bedroom);
    expect(wall).toBeNull();
  });
});
```

- [ ] **Step 6: Implement `findRoomWalls`, `findRoomWallOnSide`, `findSharedWall`**

Add to `src/sketch/resolve.ts`:

```ts
/**
 * Determine which side of a room a wall segment belongs to,
 * based on whether it overlaps with the room's polygon edges.
 * Returns 'north' | 'south' | 'east' | 'west' | null.
 */
function wallSide(wall: Wall, roomBbox: { minX: number; minY: number; maxX: number; maxY: number }): 'north' | 'south' | 'east' | 'west' | null {
  const isHorizontal = Math.abs(wall.start.y - wall.end.y) < SNAP_TOLERANCE;
  const isVertical = Math.abs(wall.start.x - wall.end.x) < SNAP_TOLERANCE;

  if (isHorizontal) {
    const y = (wall.start.y + wall.end.y) / 2;
    const minWx = Math.min(wall.start.x, wall.end.x);
    const maxWx = Math.max(wall.start.x, wall.end.x);
    // Check overlap with room's horizontal extent
    const overlap = Math.min(maxWx, roomBbox.maxX) - Math.max(minWx, roomBbox.minX);
    if (overlap < MIN_OVERLAP) return null;
    if (Math.abs(y - roomBbox.minY) < SNAP_TOLERANCE) return 'north';
    if (Math.abs(y - roomBbox.maxY) < SNAP_TOLERANCE) return 'south';
  }

  if (isVertical) {
    const x = (wall.start.x + wall.end.x) / 2;
    const minWy = Math.min(wall.start.y, wall.end.y);
    const maxWy = Math.max(wall.start.y, wall.end.y);
    const overlap = Math.min(maxWy, roomBbox.maxY) - Math.max(minWy, roomBbox.minY);
    if (overlap < MIN_OVERLAP) return null;
    if (Math.abs(x - roomBbox.minX) < SNAP_TOLERANCE) return 'west';
    if (Math.abs(x - roomBbox.maxX) < SNAP_TOLERANCE) return 'east';
  }

  return null;
}

/**
 * Find all walls that belong to a room (geometric lookup using bounding box edges).
 */
export function findRoomWalls(plan: FloorPlan, room: Room): Wall[] {
  const bbox = polygonBoundingBox(room.polygon);
  return plan.walls.filter(w => wallSide(w, bbox) !== null);
}

/**
 * Find the wall on a specific side of a room.
 * Returns the longest matching wall if multiple exist on that side.
 */
export function findRoomWallOnSide(plan: FloorPlan, room: Room, side: 'north' | 'south' | 'east' | 'west'): Wall | null {
  const bbox = polygonBoundingBox(room.polygon);
  const matches = plan.walls.filter(w => wallSide(w, bbox) === side);
  if (matches.length === 0) return null;
  // Return longest wall on that side
  return matches.reduce((best, w) => {
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    const bestLen = Math.hypot(best.end.x - best.start.x, best.end.y - best.start.y);
    return len > bestLen ? w : best;
  });
}

/**
 * Find the shared wall between two rooms.
 */
export function findSharedWall(plan: FloorPlan, roomA: Room, roomB: Room): Wall | null {
  const bboxA = polygonBoundingBox(roomA.polygon);
  const bboxB = polygonBoundingBox(roomB.polygon);
  const wallsA = new Set(plan.walls.filter(w => wallSide(w, bboxA) !== null).map(w => w.id));
  const shared = plan.walls.filter(w => wallsA.has(w.id) && wallSide(w, bboxB) !== null);
  if (shared.length === 0) return null;
  // Return the longest shared wall
  return shared.reduce((best, w) => {
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    const bestLen = Math.hypot(best.end.x - best.start.x, best.end.y - best.start.y);
    return len > bestLen ? w : best;
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/sketch/resolve.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 8: Write failing tests for `findFurnitureInRoom` and `resolvePosition`**

Add to `src/sketch/resolve.test.ts`:

```ts
import { findRoomByLabel, findRoomWalls, findRoomWallOnSide, findSharedWall, findFurnitureInRoom, resolvePosition } from './resolve';

describe('findFurnitureInRoom', () => {
  it('finds furniture inside a room polygon', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const items = findFurnitureInRoom(plan, kitchen);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('fridge');
  });

  it('filters by furniture type', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    expect(findFurnitureInRoom(plan, kitchen, 'fridge')).toHaveLength(1);
    expect(findFurnitureInRoom(plan, kitchen, 'sofa-3seat')).toHaveLength(0);
  });
});

describe('resolvePosition', () => {
  it('resolves center position', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const pos = resolvePosition(kitchen, 'center', 70, 70);
    // Kitchen bbox: 0,0 → 400,300. Center = 200,150. Offset by item half-size: 165,115
    expect(pos.x).toBeCloseTo(165, 0);
    expect(pos.y).toBeCloseTo(115, 0);
  });

  it('resolves north position', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const pos = resolvePosition(kitchen, 'north', 100, 60);
    // North wall: centered horizontally, near top
    expect(pos.x).toBeCloseTo(150, 0); // (400-100)/2 = 150
    expect(pos.y).toBeCloseTo(10, 0);  // WALL_CLEARANCE
  });

  it('resolves explicit coordinates', () => {
    const plan = makeTestPlan();
    const kitchen = findRoomByLabel(plan, 'Kitchen');
    const pos = resolvePosition(kitchen, { x: 50, y: 30 }, 70, 70);
    // Relative to room origin (0,0)
    expect(pos.x).toBe(50);
    expect(pos.y).toBe(30);
  });
});
```

- [ ] **Step 9: Implement `findFurnitureInRoom` and `resolvePosition`**

Add to `src/sketch/resolve.ts`:

```ts
/**
 * Find furniture items within a room's polygon, optionally filtered by type.
 */
export function findFurnitureInRoom(plan: FloorPlan, room: Room, type?: string): FurnitureItem[] {
  return plan.furniture.filter(f => {
    if (type && f.type !== type) return false;
    // Check if furniture position (top-left) is inside the room polygon
    // This matches existing code convention — position is the placement point
    return pointInPolygon(f.position, room.polygon);
  });
}

/**
 * Resolve a relative position name to absolute coordinates within a room.
 * Returns the top-left corner of the item at the resolved position.
 */
export function resolvePosition(
  room: Room,
  position: string | { x: number; y: number },
  itemWidth: number,
  itemDepth: number,
): Point {
  if (typeof position === 'object') {
    const bbox = polygonBoundingBox(room.polygon);
    return { x: bbox.minX + position.x, y: bbox.minY + position.y };
  }

  const bbox = polygonBoundingBox(room.polygon);
  const roomW = bbox.maxX - bbox.minX;
  const roomH = bbox.maxY - bbox.minY;

  switch (position) {
    case 'center':
      return {
        x: bbox.minX + (roomW - itemWidth) / 2,
        y: bbox.minY + (roomH - itemDepth) / 2,
      };
    case 'north':
      return {
        x: bbox.minX + (roomW - itemWidth) / 2,
        y: bbox.minY + WALL_CLEARANCE,
      };
    case 'south':
      return {
        x: bbox.minX + (roomW - itemWidth) / 2,
        y: bbox.maxY - itemDepth - WALL_CLEARANCE,
      };
    case 'east':
      return {
        x: bbox.maxX - itemWidth - WALL_CLEARANCE,
        y: bbox.minY + (roomH - itemDepth) / 2,
      };
    case 'west':
      return {
        x: bbox.minX + WALL_CLEARANCE,
        y: bbox.minY + (roomH - itemDepth) / 2,
      };
    case 'ne':
      return { x: bbox.maxX - itemWidth - WALL_CLEARANCE, y: bbox.minY + WALL_CLEARANCE };
    case 'nw':
      return { x: bbox.minX + WALL_CLEARANCE, y: bbox.minY + WALL_CLEARANCE };
    case 'se':
      return { x: bbox.maxX - itemWidth - WALL_CLEARANCE, y: bbox.maxY - itemDepth - WALL_CLEARANCE };
    case 'sw':
      return { x: bbox.minX + WALL_CLEARANCE, y: bbox.maxY - itemDepth - WALL_CLEARANCE };
    default:
      return {
        x: bbox.minX + (roomW - itemWidth) / 2,
        y: bbox.minY + (roomH - itemDepth) / 2,
      };
  }
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/sketch/resolve.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 11: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 12: Commit**

```bash
git add src/sketch/resolve.ts src/sketch/resolve.test.ts
git -c commit.gpgsign=false commit -m "feat: add label-based resolution layer for surgical edits"
```

---

## Task 4: Build the High-Level Change Compiler — Schemas + Room Operations

**Files:**
- Create: `src/sketch/high-level-changes.ts`
- Create: `src/sketch/high-level-changes.test.ts`

- [ ] **Step 1: Write failing tests for `resize_room`**

Create `src/sketch/high-level-changes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compileHighLevelChange, processChanges } from './high-level-changes';
import type { FloorPlan } from './types';

// Reuse the same test plan factory as resolve.test.ts
function makeTestPlan(): FloorPlan {
  return {
    version: 1,
    id: 'test-plan',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w2', start: { x: 400, y: 0 }, end: { x: 400, y: 300 }, thickness: 10, height: 250, type: 'interior', openings: [] },
      { id: 'w3', start: { x: 400, y: 0 }, end: { x: 800, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w4', start: { x: 0, y: 0 }, end: { x: 0, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w5', start: { x: 0, y: 300 }, end: { x: 400, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w6', start: { x: 400, y: 300 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w7', start: { x: 800, y: 0 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ],
    rooms: [
      { id: 'r1', label: 'Kitchen', type: 'kitchen', polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], color: '#E8F5E9', area: 12 },
      { id: 'r2', label: 'Living Room', type: 'living', polygon: [{ x: 400, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 400, y: 300 }], color: '#FFF3E0', area: 12 },
    ],
    furniture: [
      { id: 'f1', type: 'fridge', position: { x: 50, y: 50 }, rotation: 0, width: 70, depth: 70 },
      { id: 'f2', type: 'sofa-3seat', position: { x: 500, y: 100 }, rotation: 0, width: 200, depth: 90 },
    ],
    annotations: [],
    metadata: { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', source: 'ai' },
  };
}

describe('compileHighLevelChange', () => {
  describe('resize_room', () => {
    it('expands kitchen east side by 50cm', () => {
      const plan = makeTestPlan();
      const changes = compileHighLevelChange(plan, {
        type: 'resize_room',
        room: 'Kitchen',
        side: 'east',
        delta_cm: 50,
      });
      // Should update Kitchen polygon (east edge 400→450)
      const roomUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
      expect(roomUpdate).toBeDefined();
      // Should move shared wall w2
      const wallMove = changes.find(c => c.type === 'move_wall' && c.wall_id === 'w2');
      expect(wallMove).toBeDefined();
      // Should also update Living Room polygon (west edge 400→450)
      const adjacentUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r2');
      expect(adjacentUpdate).toBeDefined();
    });

    it('contracts kitchen south side by 30cm', () => {
      const plan = makeTestPlan();
      const changes = compileHighLevelChange(plan, {
        type: 'resize_room',
        room: 'Kitchen',
        side: 'south',
        delta_cm: -30,
      });
      const roomUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
      expect(roomUpdate).toBeDefined();
      if (roomUpdate && roomUpdate.type === 'update_room' && roomUpdate.polygon) {
        // South edge should move from 300 to 270
        const southY = Math.max(...roomUpdate.polygon.map(p => p.y));
        expect(southY).toBe(270);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement schemas and `resize_room` compiler**

Create `src/sketch/high-level-changes.ts`:

```ts
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { FloorPlan, Change, Point } from './types';
import { ChangeSchema, PointSchema, RoomSchema, RoomTypeSchema, FurnitureItemSchema } from './types';
import { applyChanges } from './changes';
import { findRoomByLabel, findRoomWalls, findRoomWallOnSide, findSharedWall, findFurnitureInRoom, resolvePosition } from './resolve';
import { polygonBoundingBox, shoelaceArea } from './geometry';
import { FURNITURE_CATALOG } from './furniture-catalog';
import { ROOM_COLORS } from './defaults';

// ─── High-Level Change Schemas ─────────────────────────────────────────

const SideSchema = z.enum(['north', 'south', 'east', 'west']);

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
  axis: z.enum(['horizontal', 'vertical']),
  position_cm: z.number(),
  labels: z.tuple([z.string(), z.string()]),
  types: z.tuple([RoomTypeSchema, RoomTypeSchema]).optional(),
});

const MergeRoomsSchema = z.object({
  type: z.literal('merge_rooms'),
  rooms: z.tuple([z.string(), z.string()]),
  label: z.string(),
  room_type: RoomTypeSchema.optional(),
});

const RemoveRoomHLSchema = z.object({
  type: z.literal('remove_room'),
  room: z.string(),
});

const AddRoomHLSchema = z.object({
  type: z.literal('add_room'),
  label: z.string(),
  room_type: RoomTypeSchema,
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), depth: z.number() }).optional(),
  polygon: z.array(PointSchema).optional(),
});

// NOTE: No .refine() here — it would produce ZodEffects which breaks z.discriminatedUnion().
// Validation of between vs room+wall_side is done in compileAddDoor() instead.
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
  room: z.string(),
  wall_side: SideSchema,
  position: z.number().min(0).max(1).optional(),
  width: z.number().optional(),
  window_type: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
});

const UpdateOpeningHLSchema = z.object({
  type: z.literal('update_opening'),
  room: z.string(),
  wall_side: SideSchema,
  index: z.number().optional(),
  position: z.number().min(0).max(1).optional(),
  width: z.number().optional(),
  swing: z.enum(['left', 'right']).optional(),
  window_type: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
});

const RemoveOpeningHLSchema = z.object({
  type: z.literal('remove_opening'),
  room: z.string(),
  wall_side: SideSchema,
  index: z.number().optional(),
});

const PositionSchema = z.union([
  z.enum(['center', 'north', 'south', 'east', 'west', 'ne', 'nw', 'se', 'sw']),
  z.object({ x: z.number(), y: z.number() }),
]);

const PlaceFurnitureSchema = z.object({
  type: z.literal('place_furniture'),
  furniture_type: z.string(),
  room: z.string(),
  position: PositionSchema.optional(),
  rotation: z.number().optional(),
  width: z.number().optional(),
  depth: z.number().optional(),
});

const MoveFurnitureHLSchema = z.object({
  type: z.literal('move_furniture'),
  furniture_type: z.string(),
  room: z.string(),
  position: PositionSchema.optional(),
  rotation: z.number().optional(),
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

const RenameRoomHLSchema = z.object({
  type: z.literal('rename_room'),
  room: z.string(),
  new_label: z.string(),
  new_type: RoomTypeSchema.optional(),
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
  RemoveRoomHLSchema,
  AddRoomHLSchema,
  AddDoorSchema,
  AddWindowSchema,
  UpdateOpeningHLSchema,
  RemoveOpeningHLSchema,
  PlaceFurnitureSchema,
  MoveFurnitureHLSchema,
  RemoveFurnitureHLSchema,
  SetEnvelopeSchema,
  RenameRoomHLSchema,
  RetypeRoomSchema,
]);

export type HighLevelChange = z.infer<typeof HighLevelChangeSchema>;

// ─── Compiler ──────────────────────────────────────────────────────────

function movePolygonSide(polygon: Point[], side: 'north' | 'south' | 'east' | 'west', delta: number): Point[] {
  const bbox = polygonBoundingBox(polygon);
  return polygon.map(p => {
    const newP = { ...p };
    switch (side) {
      case 'north':
        if (Math.abs(p.y - bbox.minY) < 1) newP.y += delta; // negative delta = expand north
        break;
      case 'south':
        if (Math.abs(p.y - bbox.maxY) < 1) newP.y += delta;
        break;
      case 'west':
        if (Math.abs(p.x - bbox.minX) < 1) newP.x += delta;
        break;
      case 'east':
        if (Math.abs(p.x - bbox.maxX) < 1) newP.x += delta;
        break;
    }
    return newP;
  });
}

// Delta direction: positive = expand, negative = contract
// For north/west, expanding means moving edge in negative direction
function sideDelta(side: 'north' | 'south' | 'east' | 'west', delta_cm: number): number {
  switch (side) {
    case 'south': case 'east': return delta_cm;
    case 'north': case 'west': return -delta_cm;
  }
}

function oppositeSide(side: 'north' | 'south' | 'east' | 'west'): 'north' | 'south' | 'east' | 'west' {
  switch (side) {
    case 'north': return 'south';
    case 'south': return 'north';
    case 'east': return 'west';
    case 'west': return 'east';
  }
}

export function compileHighLevelChange(plan: FloorPlan, change: HighLevelChange): Change[] {
  switch (change.type) {
    case 'resize_room': return compileResizeRoom(plan, change);
    case 'move_room': return compileMoveRoom(plan, change);
    case 'split_room': return compileSplitRoom(plan, change);
    case 'merge_rooms': return compileMergeRooms(plan, change);
    case 'remove_room': return compileRemoveRoom(plan, change);
    case 'add_room': return compileAddRoom(plan, change);
    case 'add_door': return compileAddDoor(plan, change);
    case 'add_window': return compileAddWindow(plan, change);
    case 'update_opening': return compileUpdateOpening(plan, change);
    case 'remove_opening': return compileRemoveOpening(plan, change);
    case 'place_furniture': return compilePlaceFurniture(plan, change);
    case 'move_furniture': return compileMoveFurniture(plan, change);
    case 'remove_furniture': return compileRemoveFurniture(plan, change);
    case 'set_envelope': return [{ type: 'set_envelope', polygon: change.polygon }];
    case 'rename_room': return compileRenameRoom(plan, change);
    case 'retype_room': return compileRetypeRoom(plan, change);
  }
}

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
      changes.push({ type: 'move_wall', wall_id: wall.id, start: { x: wall.start.x, y: wall.start.y + delta }, end: { x: wall.end.x, y: wall.end.y + delta } });
    } else {
      changes.push({ type: 'move_wall', wall_id: wall.id, start: { x: wall.start.x + delta, y: wall.start.y }, end: { x: wall.end.x + delta, y: wall.end.y } });
    }

    // Check if this wall is shared with another room — if so, adjust that room too
    for (const otherRoom of plan.rooms) {
      if (otherRoom.id === room.id) continue;
      const otherBbox = polygonBoundingBox(otherRoom.polygon);
      // Check if this wall also belongs to the other room
      const isHoriz = Math.abs(wall.start.y - wall.end.y) < 20;
      const isVert = Math.abs(wall.start.x - wall.end.x) < 20;
      let otherSide: 'north' | 'south' | 'east' | 'west' | null = null;
      if (isHoriz) {
        const y = (wall.start.y + wall.end.y) / 2;
        if (Math.abs(y - otherBbox.minY) < 20) otherSide = 'north';
        else if (Math.abs(y - otherBbox.maxY) < 20) otherSide = 'south';
      }
      if (isVert) {
        const x = (wall.start.x + wall.end.x) / 2;
        if (Math.abs(x - otherBbox.minX) < 20) otherSide = 'west';
        else if (Math.abs(x - otherBbox.maxX) < 20) otherSide = 'east';
      }
      if (otherSide) {
        const otherNewPoly = movePolygonSide(otherRoom.polygon, otherSide, delta);
        changes.push({ type: 'update_room', room_id: otherRoom.id, polygon: otherNewPoly });
      }
    }
  }

  return changes;
}

// Stub implementations — will be filled in Task 5
function compileMoveRoom(plan: FloorPlan, change: z.infer<typeof MoveRoomSchema>): Change[] {
  throw new Error('Not implemented: move_room');
}
function compileSplitRoom(plan: FloorPlan, change: z.infer<typeof SplitRoomSchema>): Change[] {
  throw new Error('Not implemented: split_room');
}
function compileMergeRooms(plan: FloorPlan, change: z.infer<typeof MergeRoomsSchema>): Change[] {
  throw new Error('Not implemented: merge_rooms');
}
function compileRemoveRoom(plan: FloorPlan, change: z.infer<typeof RemoveRoomHLSchema>): Change[] {
  throw new Error('Not implemented: remove_room');
}
function compileAddRoom(plan: FloorPlan, change: z.infer<typeof AddRoomHLSchema>): Change[] {
  throw new Error('Not implemented: add_room');
}
function compileAddDoor(plan: FloorPlan, change: z.infer<typeof AddDoorSchema>): Change[] {
  throw new Error('Not implemented: add_door');
}
function compileAddWindow(plan: FloorPlan, change: z.infer<typeof AddWindowSchema>): Change[] {
  throw new Error('Not implemented: add_window');
}
function compileUpdateOpening(plan: FloorPlan, change: z.infer<typeof UpdateOpeningHLSchema>): Change[] {
  throw new Error('Not implemented: update_opening');
}
function compileRemoveOpening(plan: FloorPlan, change: z.infer<typeof RemoveOpeningHLSchema>): Change[] {
  throw new Error('Not implemented: remove_opening');
}
function compilePlaceFurniture(plan: FloorPlan, change: z.infer<typeof PlaceFurnitureSchema>): Change[] {
  throw new Error('Not implemented: place_furniture');
}
function compileMoveFurniture(plan: FloorPlan, change: z.infer<typeof MoveFurnitureHLSchema>): Change[] {
  throw new Error('Not implemented: move_furniture');
}
function compileRemoveFurniture(plan: FloorPlan, change: z.infer<typeof RemoveFurnitureHLSchema>): Change[] {
  throw new Error('Not implemented: remove_furniture');
}
function compileRenameRoom(plan: FloorPlan, change: z.infer<typeof RenameRoomHLSchema>): Change[] {
  throw new Error('Not implemented: rename_room');
}
function compileRetypeRoom(plan: FloorPlan, change: z.infer<typeof RetypeRoomSchema>): Change[] {
  throw new Error('Not implemented: retype_room');
}

// ─── Process Changes ───────────────────────────────────────────────────

/**
 * Process high-level + low-level changes into a final FloorPlan.
 * High-level changes are compiled sequentially (each sees prior results).
 * Then all low-level changes are applied atomically.
 */
export function processChanges(
  plan: FloorPlan,
  highLevelChanges: HighLevelChange[],
  lowLevelChanges: Change[],
): FloorPlan {
  let current = plan;
  const compiled: Change[] = [];

  for (const hlChange of highLevelChanges) {
    const lowLevel = compileHighLevelChange(current, hlChange);
    compiled.push(...lowLevel);
    // Apply to get updated plan for next high-level change
    current = applyChanges(current, lowLevel);
  }

  // Apply any explicit low-level changes on top
  if (lowLevelChanges.length > 0) {
    current = applyChanges(current, lowLevelChanges);
  }

  // Recompute canvas bounds
  const allPoints = current.rooms.flatMap(r => r.polygon);
  if (current.envelope) allPoints.push(...current.envelope);
  if (allPoints.length > 0) {
    const maxX = Math.max(...allPoints.map(p => p.x));
    const maxY = Math.max(...allPoints.map(p => p.y));
    current.canvas.width = Math.max(current.canvas.width, maxX + 100);
    current.canvas.height = Math.max(current.canvas.height, maxY + 100);
  }

  return current;
}
```

- [ ] **Step 4: Run tests to verify `resize_room` passes**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: PASS for resize_room tests

- [ ] **Step 5: Commit**

```bash
git add src/sketch/high-level-changes.ts src/sketch/high-level-changes.test.ts
git -c commit.gpgsign=false commit -m "feat: add high-level change schemas and resize_room compiler"
```

---

## Task 5: Implement Remaining Room Operations

**Files:**
- Modify: `src/sketch/high-level-changes.ts`
- Modify: `src/sketch/high-level-changes.test.ts`

- [ ] **Step 1: Write failing tests for `move_room`, `add_room`, `remove_room`, `split_room`, `merge_rooms`**

Add to `src/sketch/high-level-changes.test.ts`:

```ts
describe('move_room', () => {
  it('shifts kitchen by 50cm right and 30cm down', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'move_room', room: 'Kitchen', dx: 50, dy: 30,
    });
    const roomUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
    expect(roomUpdate).toBeDefined();
    if (roomUpdate?.type === 'update_room' && roomUpdate.polygon) {
      expect(roomUpdate.polygon[0]).toEqual({ x: 50, y: 30 });
    }
    // Should also move walls and furniture
    expect(changes.filter(c => c.type === 'move_wall').length).toBeGreaterThan(0);
    expect(changes.filter(c => c.type === 'move_furniture').length).toBe(1); // fridge
  });
});

describe('add_room', () => {
  it('adds a bedroom with rect', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_room', label: 'Bedroom', room_type: 'bedroom',
      rect: { x: 0, y: 300, width: 400, depth: 300 },
    });
    const addRoom = changes.find(c => c.type === 'add_room');
    expect(addRoom).toBeDefined();
    if (addRoom?.type === 'add_room') {
      expect(addRoom.room.label).toBe('Bedroom');
      expect(addRoom.room.type).toBe('bedroom');
      expect(addRoom.room.polygon).toHaveLength(4);
    }
  });

  it('adds a room with explicit polygon', () => {
    const plan = makeTestPlan();
    const poly = [{ x: 0, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 500 }, { x: 200, y: 500 }, { x: 200, y: 600 }, { x: 0, y: 600 }];
    const changes = compileHighLevelChange(plan, {
      type: 'add_room', label: 'L-Room', room_type: 'living', polygon: poly,
    });
    const addRoom = changes.find(c => c.type === 'add_room');
    expect(addRoom).toBeDefined();
    if (addRoom?.type === 'add_room') {
      expect(addRoom.room.polygon).toEqual(poly);
    }
  });
});

describe('remove_room', () => {
  it('removes room and its private walls and furniture', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'remove_room', room: 'Kitchen',
    });
    expect(changes.find(c => c.type === 'remove_room' && c.room_id === 'r1')).toBeDefined();
    // Should remove fridge (f1) which is in Kitchen
    expect(changes.find(c => c.type === 'remove_furniture' && c.furniture_id === 'f1')).toBeDefined();
    // Should NOT remove shared wall w2
    expect(changes.find(c => c.type === 'remove_wall' && c.wall_id === 'w2')).toBeUndefined();
    // Should remove private walls (w1, w4, w5)
    expect(changes.filter(c => c.type === 'remove_wall').length).toBeGreaterThan(0);
  });
});

describe('split_room', () => {
  it('splits kitchen vertically at 200cm', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'split_room', room: 'Kitchen', axis: 'vertical', position_cm: 200,
      labels: ['Kitchen', 'Pantry'], types: ['kitchen', 'storage'],
    });
    expect(changes.find(c => c.type === 'remove_room' && c.room_id === 'r1')).toBeDefined();
    const addRooms = changes.filter(c => c.type === 'add_room');
    expect(addRooms).toHaveLength(2);
    expect(changes.find(c => c.type === 'add_wall')).toBeDefined();
  });
});

describe('merge_rooms', () => {
  it('merges kitchen and living room', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'merge_rooms', rooms: ['Kitchen', 'Living Room'], label: 'Open Plan',
    });
    expect(changes.filter(c => c.type === 'remove_room')).toHaveLength(2);
    expect(changes.find(c => c.type === 'remove_wall' && c.wall_id === 'w2')).toBeDefined();
    const addRoom = changes.find(c => c.type === 'add_room');
    expect(addRoom).toBeDefined();
    if (addRoom?.type === 'add_room') {
      expect(addRoom.room.label).toBe('Open Plan');
      // Merged polygon should span full width (0-800)
      const xs = addRoom.room.polygon.map((p: {x: number}) => p.x);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBe(800);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: FAIL — "Not implemented" errors

- [ ] **Step 3: Implement `move_room`, `add_room`, `remove_room`, `split_room`, `merge_rooms`**

Replace the stub functions in `src/sketch/high-level-changes.ts`:

```ts
function compileMoveRoom(plan: FloorPlan, change: z.infer<typeof MoveRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const newPolygon = room.polygon.map(p => ({ x: p.x + change.dx, y: p.y + change.dy }));
  const changes: Change[] = [
    { type: 'update_room', room_id: room.id, polygon: newPolygon },
  ];
  // Move walls belonging to this room
  const walls = findRoomWalls(plan, room);
  for (const w of walls) {
    // Only move walls that are NOT shared with another room
    const isShared = plan.rooms.some(r => {
      if (r.id === room.id) return false;
      const bbox = polygonBoundingBox(r.polygon);
      const isH = Math.abs(w.start.y - w.end.y) < 20;
      const isV = Math.abs(w.start.x - w.end.x) < 20;
      if (isH) {
        const y = (w.start.y + w.end.y) / 2;
        return (Math.abs(y - bbox.minY) < 20 || Math.abs(y - bbox.maxY) < 20);
      }
      if (isV) {
        const x = (w.start.x + w.end.x) / 2;
        return (Math.abs(x - bbox.minX) < 20 || Math.abs(x - bbox.maxX) < 20);
      }
      return false;
    });
    if (!isShared) {
      changes.push({
        type: 'move_wall', wall_id: w.id,
        start: { x: w.start.x + change.dx, y: w.start.y + change.dy },
        end: { x: w.end.x + change.dx, y: w.end.y + change.dy },
      });
    }
  }
  // Move furniture in this room
  const furniture = findFurnitureInRoom(plan, room);
  for (const f of furniture) {
    changes.push({
      type: 'move_furniture', furniture_id: f.id,
      position: { x: f.position.x + change.dx, y: f.position.y + change.dy },
    });
  }
  return changes;
}

function compileAddRoom(plan: FloorPlan, change: z.infer<typeof AddRoomHLSchema>): Change[] {
  let polygon: Point[];
  if (change.polygon) {
    polygon = change.polygon;
  } else if (change.rect) {
    const { x, y, width, depth } = change.rect;
    polygon = [
      { x, y }, { x: x + width, y },
      { x: x + width, y: y + depth }, { x, y: y + depth },
    ];
  } else {
    throw new Error('add_room requires either rect or polygon');
  }

  const color = ROOM_COLORS[change.room_type] || ROOM_COLORS.other || '#F5F5F5';
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

function compileRemoveRoom(plan: FloorPlan, change: z.infer<typeof RemoveRoomHLSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const changes: Change[] = [{ type: 'remove_room', room_id: room.id }];

  // Remove furniture in this room
  const furniture = findFurnitureInRoom(plan, room);
  for (const f of furniture) {
    changes.push({ type: 'remove_furniture', furniture_id: f.id });
  }

  // Remove walls that ONLY belong to this room (not shared)
  const walls = findRoomWalls(plan, room);
  for (const w of walls) {
    const isShared = plan.rooms.some(r => {
      if (r.id === room.id) return false;
      const bbox = polygonBoundingBox(r.polygon);
      const isH = Math.abs(w.start.y - w.end.y) < 20;
      const isV = Math.abs(w.start.x - w.end.x) < 20;
      if (isH) {
        const y = (w.start.y + w.end.y) / 2;
        return (Math.abs(y - bbox.minY) < 20 || Math.abs(y - bbox.maxY) < 20);
      }
      if (isV) {
        const x = (w.start.x + w.end.x) / 2;
        return (Math.abs(x - bbox.minX) < 20 || Math.abs(x - bbox.maxX) < 20);
      }
      return false;
    });
    if (!isShared) {
      changes.push({ type: 'remove_wall', wall_id: w.id });
    }
  }

  return changes;
}

function compileSplitRoom(plan: FloorPlan, change: z.infer<typeof SplitRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const bbox = polygonBoundingBox(room.polygon);

  let poly1: Point[], poly2: Point[], wallStart: Point, wallEnd: Point;

  if (change.axis === 'vertical') {
    const splitX = bbox.minX + change.position_cm;
    poly1 = [{ x: bbox.minX, y: bbox.minY }, { x: splitX, y: bbox.minY }, { x: splitX, y: bbox.maxY }, { x: bbox.minX, y: bbox.maxY }];
    poly2 = [{ x: splitX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY }, { x: bbox.maxX, y: bbox.maxY }, { x: splitX, y: bbox.maxY }];
    wallStart = { x: splitX, y: bbox.minY };
    wallEnd = { x: splitX, y: bbox.maxY };
  } else {
    const splitY = bbox.minY + change.position_cm;
    poly1 = [{ x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY }, { x: bbox.maxX, y: splitY }, { x: bbox.minX, y: splitY }];
    poly2 = [{ x: bbox.minX, y: splitY }, { x: bbox.maxX, y: splitY }, { x: bbox.maxX, y: bbox.maxY }, { x: bbox.minX, y: bbox.maxY }];
    wallStart = { x: bbox.minX, y: splitY };
    wallEnd = { x: bbox.maxX, y: splitY };
  }

  const type1 = change.types?.[0] || room.type;
  const type2 = change.types?.[1] || room.type;
  const color1 = ROOM_COLORS[type1] || room.color;
  const color2 = ROOM_COLORS[type2] || room.color;

  return [
    { type: 'remove_room', room_id: room.id },
    { type: 'add_room', room: { id: nanoid(), label: change.labels[0], type: type1, polygon: poly1, color: color1, area: shoelaceArea(poly1) } },
    { type: 'add_room', room: { id: nanoid(), label: change.labels[1], type: type2, polygon: poly2, color: color2, area: shoelaceArea(poly2) } },
    { type: 'add_wall', wall: { id: nanoid(), start: wallStart, end: wallEnd, thickness: 10, height: 250, type: 'interior', openings: [] } },
  ];
}

function compileMergeRooms(plan: FloorPlan, change: z.infer<typeof MergeRoomsSchema>): Change[] {
  const roomA = findRoomByLabel(plan, change.rooms[0]);
  const roomB = findRoomByLabel(plan, change.rooms[1]);
  const sharedWall = findSharedWall(plan, roomA, roomB);
  if (!sharedWall) {
    throw new Error(`Cannot merge "${change.rooms[0]}" and "${change.rooms[1]}": no shared wall found. Rooms must be adjacent.`);
  }

  const bboxA = polygonBoundingBox(roomA.polygon);
  const bboxB = polygonBoundingBox(roomB.polygon);
  const mergedPoly: Point[] = [
    { x: Math.min(bboxA.minX, bboxB.minX), y: Math.min(bboxA.minY, bboxB.minY) },
    { x: Math.max(bboxA.maxX, bboxB.maxX), y: Math.min(bboxA.minY, bboxB.minY) },
    { x: Math.max(bboxA.maxX, bboxB.maxX), y: Math.max(bboxA.maxY, bboxB.maxY) },
    { x: Math.min(bboxA.minX, bboxB.minX), y: Math.max(bboxA.maxY, bboxB.maxY) },
  ];

  const roomType = change.room_type || roomA.type;
  const color = ROOM_COLORS[roomType] || roomA.color;

  const changes: Change[] = [
    { type: 'remove_room', room_id: roomA.id },
    { type: 'remove_room', room_id: roomB.id },
    { type: 'add_room', room: { id: nanoid(), label: change.label, type: roomType, polygon: mergedPoly, color, area: shoelaceArea(mergedPoly) } },
  ];

  if (sharedWall) {
    changes.push({ type: 'remove_wall', wall_id: sharedWall.id });
  }

  return changes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/high-level-changes.ts src/sketch/high-level-changes.test.ts
git -c commit.gpgsign=false commit -m "feat: implement move/add/remove/split/merge room operations"
```

---

## Task 6: Implement Opening and Furniture Operations

**Files:**
- Modify: `src/sketch/high-level-changes.ts`
- Modify: `src/sketch/high-level-changes.test.ts`

- [ ] **Step 1: Write failing tests for opening and furniture operations**

Add to `src/sketch/high-level-changes.test.ts`:

```ts
describe('add_door', () => {
  it('adds interior door between kitchen and living room', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_door', between: ['Kitchen', 'Living Room'], width: 80,
    });
    const addOpening = changes.find(c => c.type === 'add_opening');
    expect(addOpening).toBeDefined();
    if (addOpening?.type === 'add_opening') {
      expect(addOpening.wall_id).toBe('w2'); // shared wall
      expect(addOpening.opening.type).toBe('door');
      expect(addOpening.opening.width).toBe(80);
    }
  });

  it('adds exterior door on kitchen south wall', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_door', room: 'Kitchen', wall_side: 'south', width: 90,
    });
    const addOpening = changes.find(c => c.type === 'add_opening');
    expect(addOpening).toBeDefined();
    if (addOpening?.type === 'add_opening') {
      expect(addOpening.wall_id).toBe('w5');
    }
  });
});

describe('add_window', () => {
  it('adds window on living room east wall', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_window', room: 'Living Room', wall_side: 'east', width: 120,
    });
    const addOpening = changes.find(c => c.type === 'add_opening');
    expect(addOpening).toBeDefined();
    if (addOpening?.type === 'add_opening') {
      expect(addOpening.opening.type).toBe('window');
      expect(addOpening.opening.width).toBe(120);
    }
  });
});

describe('place_furniture', () => {
  it('places furniture with named position', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'place_furniture', furniture_type: 'bed-double', room: 'Living Room', position: 'north',
    });
    const addFurn = changes.find(c => c.type === 'add_furniture');
    expect(addFurn).toBeDefined();
    if (addFurn?.type === 'add_furniture') {
      expect(addFurn.furniture.type).toBe('bed-double');
      expect(addFurn.furniture.position.y).toBeCloseTo(10, 0); // WALL_CLEARANCE from north
    }
  });
});

describe('rename_room', () => {
  it('renames kitchen to Kitchenette', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'rename_room', room: 'Kitchen', new_label: 'Kitchenette',
    });
    expect(changes).toEqual([
      { type: 'rename_room', room_id: 'r1', label: 'Kitchenette' },
    ]);
  });
});

describe('retype_room', () => {
  it('changes room type', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'retype_room', room: 'Living Room', new_type: 'dining',
    });
    expect(changes).toEqual([
      { type: 'rename_room', room_id: 'r2', label: 'Living Room', room_type: 'dining' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: FAIL — "Not implemented" errors

- [ ] **Step 3: Implement all remaining operations**

Replace the remaining stubs in `src/sketch/high-level-changes.ts`:

```ts
function compileAddDoor(plan: FloorPlan, change: z.infer<typeof AddDoorSchema>): Change[] {
  let wall: Wall | null = null;
  if (change.between) {
    const roomA = findRoomByLabel(plan, change.between[0]);
    const roomB = findRoomByLabel(plan, change.between[1]);
    wall = findSharedWall(plan, roomA, roomB);
    if (!wall) throw new Error(`No shared wall between "${change.between[0]}" and "${change.between[1]}"`);
  } else if (change.room && change.wall_side) {
    const room = findRoomByLabel(plan, change.room);
    wall = findRoomWallOnSide(plan, room, change.wall_side);
    if (!wall) throw new Error(`No wall on ${change.wall_side} side of "${change.room}"`);
  }
  if (!wall) throw new Error('Invalid add_door: provide "between" or "room" + "wall_side"');

  const wallLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const width = change.width || 80;
  const pos = change.position ?? 0.5;
  const offset = pos * wallLen - width / 2;

  return [{
    type: 'add_opening',
    wall_id: wall.id,
    opening: {
      id: nanoid(),
      type: 'door',
      offset: Math.max(0, offset),
      width,
      properties: {
        swingDirection: change.swing || 'right',
        swingAngle: 90,
      },
    },
  }];
}

function compileAddWindow(plan: FloorPlan, change: z.infer<typeof AddWindowSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const wall = findRoomWallOnSide(plan, room, change.wall_side);
  if (!wall) throw new Error(`No wall on ${change.wall_side} side of "${change.room}"`);

  const wallLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const width = change.width || 120;
  const pos = change.position ?? 0.5;
  const offset = pos * wallLen - width / 2;

  return [{
    type: 'add_opening',
    wall_id: wall.id,
    opening: {
      id: nanoid(),
      type: 'window',
      offset: Math.max(0, offset),
      width,
      properties: {
        windowType: change.window_type || 'single',
        sillHeight: 90,
      },
    },
  }];
}

function compileUpdateOpening(plan: FloorPlan, change: z.infer<typeof UpdateOpeningHLSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const wall = findRoomWallOnSide(plan, room, change.wall_side);
  if (!wall) throw new Error(`No wall on ${change.wall_side} side of "${change.room}"`);
  const idx = change.index ?? 0;
  if (idx >= wall.openings.length) throw new Error(`No opening at index ${idx} on ${change.wall_side} wall of "${change.room}"`);
  const opening = wall.openings[idx];
  const wallLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

  const updates: { offset?: number; width?: number; properties?: { swingDirection?: 'left' | 'right'; swingAngle?: number; sillHeight?: number; windowType?: 'single' | 'double' | 'sliding' | 'bay' } } = {};
  if (change.position !== undefined) {
    const w = change.width || opening.width;
    updates.offset = Math.max(0, change.position * wallLen - w / 2);
  }
  if (change.width !== undefined) updates.width = change.width;
  const props: { swingDirection?: 'left' | 'right'; windowType?: 'single' | 'double' | 'sliding' | 'bay' } = {};
  if (change.swing) props.swingDirection = change.swing;
  if (change.window_type) props.windowType = change.window_type;
  if (Object.keys(props).length > 0) updates.properties = props;

  return [{ type: 'update_opening', wall_id: wall.id, opening_id: opening.id, ...updates }];
}

function compileRemoveOpening(plan: FloorPlan, change: z.infer<typeof RemoveOpeningHLSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const wall = findRoomWallOnSide(plan, room, change.wall_side);
  if (!wall) throw new Error(`No wall on ${change.wall_side} side of "${change.room}"`);
  const idx = change.index ?? 0;
  if (idx >= wall.openings.length) throw new Error(`No opening at index ${idx} on ${change.wall_side} wall of "${change.room}"`);
  return [{ type: 'remove_opening', wall_id: wall.id, opening_id: wall.openings[idx].id }];
}

function compilePlaceFurniture(plan: FloorPlan, change: z.infer<typeof PlaceFurnitureSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const catalogItem = FURNITURE_CATALOG.find(c => c.type === change.furniture_type);
  const width = change.width || catalogItem?.defaultWidth || 80;
  const depth = change.depth || catalogItem?.defaultDepth || 60;
  const position = resolvePosition(room, change.position || 'center', width, depth);

  return [{
    type: 'add_furniture',
    furniture: {
      id: nanoid(),
      type: change.furniture_type,
      position,
      rotation: change.rotation || 0,
      width,
      depth,
    },
  }];
}

function compileMoveFurniture(plan: FloorPlan, change: z.infer<typeof MoveFurnitureHLSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  const items = findFurnitureInRoom(plan, room, change.furniture_type);
  if (items.length === 0) throw new Error(`No ${change.furniture_type} found in "${change.room}"`);
  const item = items[0];
  const position = change.position ? resolvePosition(room, change.position, item.width, item.depth) : item.position;
  return [{ type: 'move_furniture', furniture_id: item.id, position, rotation: change.rotation }];
}

function compileRemoveFurniture(plan: FloorPlan, change: z.infer<typeof RemoveFurnitureHLSchema>): Change[] {
  if (change.furniture_id) {
    return [{ type: 'remove_furniture', furniture_id: change.furniture_id }];
  }
  if (change.room && change.furniture_type) {
    const room = findRoomByLabel(plan, change.room);
    const items = findFurnitureInRoom(plan, room, change.furniture_type);
    if (items.length === 0) throw new Error(`No ${change.furniture_type} found in "${change.room}"`);
    return [{ type: 'remove_furniture', furniture_id: items[0].id }];
  }
  throw new Error('remove_furniture requires furniture_id or room + furniture_type');
}

function compileRenameRoom(plan: FloorPlan, change: z.infer<typeof RenameRoomHLSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  return [{ type: 'rename_room', room_id: room.id, label: change.new_label, room_type: change.new_type }];
}

function compileRetypeRoom(plan: FloorPlan, change: z.infer<typeof RetypeRoomSchema>): Change[] {
  const room = findRoomByLabel(plan, change.room);
  return [{ type: 'rename_room', room_id: room.id, label: room.label, room_type: change.new_type }];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/high-level-changes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Add `processChanges` integration test and error-case tests**

Add to `src/sketch/high-level-changes.test.ts`:

```ts
describe('processChanges', () => {
  it('chains multiple high-level changes sequentially', () => {
    const plan = makeTestPlan();
    const result = processChanges(plan, [
      { type: 'resize_room', room: 'Kitchen', side: 'east', delta_cm: 50 },
      { type: 'add_door', between: ['Kitchen', 'Living Room'], width: 80 },
    ], []);
    // Kitchen should be wider and have a door on the shared wall
    const kitchen = result.rooms.find(r => r.label === 'Kitchen');
    expect(kitchen).toBeDefined();
    // The shared wall should have an opening
    const sharedWall = result.walls.find(w => w.openings.length > 0);
    expect(sharedWall).toBeDefined();
  });

  it('applies low-level changes after high-level', () => {
    const plan = makeTestPlan();
    const result = processChanges(plan, [], [
      { type: 'rename_room', room_id: 'r1', label: 'Galley Kitchen' },
    ]);
    expect(result.rooms.find(r => r.id === 'r1')?.label).toBe('Galley Kitchen');
  });

  it('recomputes canvas bounds after changes', () => {
    const plan = makeTestPlan();
    plan.canvas.width = 500; // artificially small
    const result = processChanges(plan, [
      { type: 'move_room', room: 'Living Room', dx: 500, dy: 0 },
    ], []);
    expect(result.canvas.width).toBeGreaterThan(1000);
  });
});

describe('error handling', () => {
  it('throws descriptive error for non-existent room', () => {
    const plan = makeTestPlan();
    expect(() => compileHighLevelChange(plan, {
      type: 'resize_room', room: 'Bedroom', side: 'east', delta_cm: 50,
    })).toThrow(/not found/i);
    expect(() => compileHighLevelChange(plan, {
      type: 'resize_room', room: 'Bedroom', side: 'east', delta_cm: 50,
    })).toThrow(/Kitchen/); // should list available rooms
  });

  it('throws for merge of non-adjacent rooms', () => {
    const plan = makeTestPlan();
    plan.rooms.push({
      id: 'r3', label: 'Bedroom', type: 'bedroom',
      polygon: [{ x: 0, y: 500 }, { x: 300, y: 500 }, { x: 300, y: 800 }, { x: 0, y: 800 }],
      color: '#E3F2FD', area: 9,
    });
    expect(() => compileHighLevelChange(plan, {
      type: 'merge_rooms', rooms: ['Kitchen', 'Bedroom'], label: 'Merged',
    })).toThrow(/no shared wall/i);
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/sketch/high-level-changes.ts src/sketch/high-level-changes.test.ts
git -c commit.gpgsign=false commit -m "feat: implement opening, furniture, label high-level operations"
```

---

## Task 7: Wire Up `update_sketch` to Accept High-Level Changes

**Files:**
- Modify: `src/sketch/tools.ts:161-205`
- Modify: `src/index.ts:510-533`

- [ ] **Step 1: Update `handleUpdateSketch` in `src/sketch/tools.ts`**

Modify `handleUpdateSketch` (line 161) to accept and process high-level changes. The function signature adds a new parameter:

```ts
export async function handleUpdateSketch(
  sketchId: string,
  changes: unknown[],
  highLevelChanges: unknown[],
  ctx: ToolContext,
): Promise<ToolResult> {
```

After the existing change validation loop (lines 167-174), add high-level change validation:

```ts
import { HighLevelChangeSchema, processChanges } from './high-level-changes';
import type { HighLevelChange } from './high-level-changes';

// ... existing low-level validation ...

const parsedHL: HighLevelChange[] = [];
for (const c of highLevelChanges) {
  const result = HighLevelChangeSchema.safeParse(c);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Invalid high-level change: ${result.error.issues.map(i => i.message).join(', ')}\n\nInput: ${JSON.stringify(c, null, 2)}` }] };
  }
  parsedHL.push(result.data);
}

if (parsed.length === 0 && parsedHL.length === 0) {
  return { content: [{ type: 'text', text: 'No changes provided. Supply "changes" and/or "high_level_changes".' }] };
}
```

Replace the `applyChanges` call (line 181) with `processChanges`:

```ts
const plan = processChanges(planResult, parsedHL, parsed);
```

Wrap in try-catch to handle resolution errors:

```ts
let plan: FloorPlan;
try {
  plan = processChanges(planResult, parsedHL, parsed);
} catch (err) {
  return { content: [{ type: 'text', text: `Change failed: ${(err as Error).message}` }] };
}
```

- [ ] **Step 2: Update `update_sketch` tool registration in `src/index.ts`**

At line 510, update the tool registration to add `high_level_changes` input:

```ts
import { HighLevelChangeSchema } from './sketch/high-level-changes';

// In the registerTool call:
inputSchema: {
  sketch_id: z.string().describe('The sketch ID'),
  changes: z.array(ChangeSchema).optional().describe('Low-level changes (by ID)'),
  high_level_changes: z.array(HighLevelChangeSchema).optional().describe('High-level changes (by room label) — surgical operations like resize_room, add_door, place_furniture'),
},
```

Update the handler call (around line 521):

```ts
async ({ sketch_id, changes, high_level_changes }) => {
  return handleUpdateSketch(sketch_id, changes || [], high_level_changes || [], this.buildCtx({
    broadcast: async (msg) => { ... },
  }));
},
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git -c commit.gpgsign=false commit -m "feat: wire update_sketch to accept high-level changes"
```

---

## Task 8: Implement Side-by-Side Preview

**Files:**
- Modify: `src/sketch/tools.ts:362-391` (handlePreviewSketch)
- Modify: `src/sketch/tools.ts:393-534` (handleAnalyzeImage)
- Modify: `src/index.ts:562-575` (preview_sketch registration)

- [ ] **Step 1: Store source URL in session state from the caller**

**IMPORTANT:** `handleAnalyzeImage` does NOT accept `ToolContext` — it has a different signature (see `tools.ts:393-399`). Store the source URL in the **caller** in `src/index.ts` instead.

In `src/index.ts`, in the `analyze_floor_plan_image` tool handler (around line 504), after the `handleAnalyzeImage` call returns successfully, store the URL in session state:

```ts
async ({ image, image_url, name, outline_epsilon }) => {
  const cvUrl = this.env.CV_SERVICE_URL || 'http://localhost:8100';
  const result = await handleAnalyzeImage({ image, image_url, outline_epsilon }, name || 'Extracted Floor Plan', cvUrl, this.env.AI, this.env.DB, this.getWorkerUrl());
  // Store source image URL in session for side-by-side preview
  if (image_url) {
    const session = this.getState();
    session.sourceImageUrl = image_url;
    this.setState(session);
  }
  return result;
},
```

Then in `handleGenerateFloorPlan` (`tools.ts:61`), read the source URL from `ctx.state` (NOT `ctx.session` — the interface uses `state`) and store it in metadata:

```ts
if (ctx.state?.sourceImageUrl) {
  floorPlan.metadata.source_image_url = ctx.state.sourceImageUrl;
}
```

Add this after the floor plan is created but before it's saved (around where `saveSketch` is called).

- [ ] **Step 2: Update `handlePreviewSketch` to return source image**

Modify `handlePreviewSketch` (line 362) to accept `includeSource` parameter:

```ts
export async function handlePreviewSketch(
  sketchId: string,
  ctx: ToolContext,
  includeSource: boolean = true,
): Promise<ToolResult> {
```

After the existing PNG generation (around line 377), add source image fetching:

```ts
const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];

// Sketch preview (existing)
content.push({ type: 'image', data: base64, mimeType: 'image/png' });
content.push({ type: 'text', text: `**Your sketch:** ${summaryText}` });

// Source image (new)
if (includeSource && plan.metadata.source_image_url) {
  try {
    const resp = await fetch(plan.metadata.source_image_url);
    if (resp.ok) {
      const sourceBytes = new Uint8Array(await resp.arrayBuffer());
      let sourceBase64 = '';
      for (let i = 0; i < sourceBytes.length; i += 8192) {
        sourceBase64 += String.fromCharCode(...sourceBytes.subarray(i, i + 8192));
      }
      sourceBase64 = btoa(sourceBase64);
      const contentType = resp.headers.get('content-type') || 'image/png';
      content.push({ type: 'image', data: sourceBase64, mimeType: contentType });
      content.push({ type: 'text', text: '**Source image** (compare against your sketch above)' });
    }
  } catch {
    // Non-fatal — source image fetch failed, continue without it
  }
}

return { content };
```

- [ ] **Step 3: Update `preview_sketch` tool registration in `src/index.ts`**

At line 562, add `include_source` parameter:

```ts
inputSchema: {
  sketch_id: z.string().describe('The sketch ID'),
  include_source: z.boolean().optional().default(true).describe('Include source floor plan image for side-by-side comparison'),
},
```

Update the handler:

```ts
async ({ sketch_id, include_source }) => {
  return handlePreviewSketch(sketch_id, this.buildCtx(), include_source);
},
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git -c commit.gpgsign=false commit -m "feat: add side-by-side source image in preview_sketch"
```

---

## Task 9: Rewrite Tool Descriptions

**Files:**
- Modify: `src/index.ts:336-395` (generate_floor_plan)
- Modify: `src/index.ts:479-508` (analyze_floor_plan_image)
- Modify: `src/index.ts:510-533` (update_sketch)
- Modify: `src/index.ts:562-575` (preview_sketch)

This task rewrites the tool descriptions to implement the prompting philosophy from the spec. No code logic changes — only string content in `description` fields.

- [ ] **Step 1: Rewrite `preview_sketch` description**

Replace the existing description (line 565) with:

```ts
description: `Get a visual PNG preview of a floor plan. Returns the rendered sketch as a PNG image. In Copy Mode (when a source image exists), also returns the source floor plan image for side-by-side comparison.

PURPOSE: This is your eyes. EVERY time you see the preview, follow this protocol:

COMPARISON PROTOCOL (when source image is present):

1. COUNT ROOMS: How many rooms in the source? How many in your sketch? List any missing or extra.

2. ROOM-BY-ROOM CHECK (for each room visible in the source):
   - Present in sketch? Correct label?
   - Roughly the right SIZE? (compare width/height proportions)
   - Right POSITION relative to neighbors?
   - Correct SHAPE? (rectangular vs L-shaped vs irregular)

3. OPENINGS: Doors between right rooms? Windows on right walls?

4. OVERALL SHAPE: Building outline match the source perimeter?

5. DECISION: List specific fixes needed. Each fix = one surgical change.
   "Kitchen is ~30cm too narrow on east side" → resize_room.
   Do NOT regenerate. Fix one thing at a time.

VERIFICATION (without source):
Check for: (1) walls with gaps or overlaps, (2) furniture outside rooms or overlapping, (3) missing doors/windows, (4) rooms too small or oddly shaped, (5) overlapping labels.`,
```

- [ ] **Step 2: Rewrite `update_sketch` description**

Replace the existing description (line 513) with:

```ts
description: `Push modifications to an existing sketch. Supports two input modes:

1. "changes" — Low-level ID-based changes (14 types: add/move/remove walls, openings, rooms, furniture)
2. "high_level_changes" — Label-based surgical operations (recommended for Copy Mode iteration)

HIGH-LEVEL OPERATIONS (use room labels, not IDs):
- resize_room: {room, side, delta_cm} — expand/contract one side
- move_room: {room, dx, dy} — shift a room
- split_room: {room, axis, position_cm, labels} — divide into two rooms
- merge_rooms: {rooms: [a, b], label} — combine two adjacent rooms
- add_room: {label, room_type, rect or polygon} — add a new room
- remove_room: {room} — remove room + its walls + furniture
- add_door: {between: [a, b]} or {room, wall_side} — add a door
- add_window: {room, wall_side} — add a window
- place_furniture: {furniture_type, room, position} — place by name (center/north/sw/etc)
- rename_room / retype_room — change labels or types

ITERATION PHILOSOPHY: Fix ONE thing at a time. After each fix, preview to verify it worked and didn't break adjacent rooms. Never regenerate the entire layout to fix a single room.

GOOD: "Kitchen is 30cm too narrow on east side" → resize_room Kitchen east +30
BAD: "Layout doesn't look right" → regenerate everything

Each iteration: identify single biggest discrepancy → minimal fix → preview → repeat.`,
```

- [ ] **Step 3: Rewrite `analyze_floor_plan_image` description**

Update the CV-as-advisory framing (line 479). Add to the existing description after the OUTLINE FEEDBACK LOOP section:

```ts
CV DATA IS ADVISORY: The CV pipeline provides measured geometry extracted by computer vision. Use it as expert input, but YOU are the authority on what rooms exist and how they're arranged.

TRUST CV FOR: scale (cm/px ratio), wall thickness, building outline polygon
TRUST YOUR EYES FOR: room count, room labels, printed dimensions, spatial relationships

When CV and your visual understanding disagree:
- State what CV says vs what you see
- Explain why you're following your interpretation
- Example: "CV detected 5 rooms but I can see 9 labeled rooms. I'll use CV scale but place all 9 rooms from printed dimensions."
```

- [ ] **Step 4: Rewrite `generate_floor_plan` Copy Mode workflow**

Update the COPY MODE section (line 342) with the new workflow from the spec. Key changes:
- Step 1: "Read the CV output but also look at the source image yourself. Count every room you can see."
- Step 2: "BUILD ALL ROOMS — Call generate_floor_plan with ALL rooms you can identify. Start with CV-detected rooms, ADD rooms the CV missed."
- Step 3: "PREVIEW AND COMPARE — Call preview_sketch. Follow the COMPARISON PROTOCOL."
- Step 4: "FIX ONE THING AT A TIME — Use high-level surgical operations."

Add the architectural irregularity guidance:

```
PRESERVE ARCHITECTURAL DETAILS: Real apartments have walls that jut out, structural setbacks, non-rectangular foyers. A slightly irregular polygon that matches the source is BETTER than a clean rectangle that doesn't. Use polygon input when rooms aren't rectangular.
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (description changes only)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git -c commit.gpgsign=false commit -m "feat: rewrite tool descriptions for surgical iteration workflow"
```

---

## Task 10: Deploy and Validate

**Files:** None (deployment + manual validation)

- [ ] **Step 1: Run full test suite one final time**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Deploy**

Run: `bash deploy.sh`
Expected: Successful deployment with health check passing

- [ ] **Step 3: Validate with Unit 2C (primary test case)**

Run the full Copy Mode workflow via MCP tools:
1. `analyze_floor_plan_image` with `https://roomsketcher.kworq.com/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`
2. `generate_floor_plan` with all rooms (CV-detected + manually identified)
3. `preview_sketch` — verify side-by-side comparison works
4. Use `update_sketch` with `high_level_changes` to fix discrepancies
5. Verify all 9 rooms are present and correctly positioned

- [ ] **Step 4: Validate with remaining test images**

Run Copy Mode on:
- Shore Drive: `https://roomsketcher.kworq.com/api/images/ee498fc2-d89b-4d1c-ba48-cd21caebe740`
- Res 507: `https://roomsketcher.kworq.com/api/images/b84581fb-5c89-4d89-822e-e62e10f3a4d2`
- Apt 6C: `https://roomsketcher.kworq.com/api/images/0f60f8fb-96d8-4a98-b3ec-5b56a65ea1e2`

Verify each produces an acceptable sketch.

- [ ] **Step 5: Commit any final fixes**

If validation reveals issues, fix and commit.
