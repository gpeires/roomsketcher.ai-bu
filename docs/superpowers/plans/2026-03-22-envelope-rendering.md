# Envelope-Based Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace individual exterior wall rendering with an envelope-minus-rooms structural mass approach, support polygon rooms, and add fixture catalog.

**Architecture:** Compute a building envelope (union of room polygons expanded by exterior wall thickness) and render it as a single filled shape. Room polygons are layered on top as colored cutouts. Interior partition walls remain as thin lines. Exterior walls stay in the data model as opening containers but are not rendered as thick polygons. Grid-based rasterization for polygon union, contour tracing for envelope boundary.

**Tech Stack:** TypeScript, Vitest, SVG rendering. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-22-envelope-rendering-design.md`

**Test commands:** `npm test` (currently 187 tests). Deploy: `bash deploy.sh`

**Test images for visual verification:**
- Shore Drive (primary): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`
- Unit 2C: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`

**CV fix list:** Accumulate CV issues discovered during rendering work in `docs/superpowers/specs/2026-03-22-cv-fixes-needed.md`

---

## File Structure

| File | Role | Change |
|------|------|--------|
| `src/sketch/geometry.ts` | Pure geometry functions | Add: `rasterizeToGrid`, `traceContour`, `offsetAxisAlignedPolygon`, `polygonBoundingBox` |
| `src/sketch/geometry.test.ts` | Geometry unit tests | New file for testing geometry functions |
| `src/sketch/types.ts` | Type definitions | Add `envelope?: Point[]` to FloorPlan schemas |
| `src/sketch/compile-layout.ts` | Layout compiler | Add `computeEnvelope()`, snap polygon vertices, update `boundingBox` usage |
| `src/sketch/compile-layout.test.ts` | Compiler tests | Add envelope tests, update existing wall count expectations |
| `src/sketch/svg.ts` | SVG renderer | Add `renderStructure()`, update `floorPlanToSvg()` rendering pipeline |
| `src/sketcher/html.ts` | Browser renderer | Mirror envelope rendering changes |
| `src/sketch/defaults.ts` | Constants | Add `ENVELOPE_GAP_THRESHOLD` |
| `src/sketch/furniture-symbols.ts` | Furniture SVG symbols | Add kitchen/bath/utility fixtures |

---

## Phase 1: Polygon Rooms + Envelope Rendering

### Task 1: Geometry — Grid Rasterization + Contour Tracing

**Files:**
- Modify: `src/sketch/geometry.ts`
- Create: `src/sketch/geometry.test.ts`

- [ ] **Step 1: Write failing test for `polygonBoundingBox`**

```typescript
// src/sketch/geometry.test.ts
import { describe, it, expect } from 'vitest';
import { polygonBoundingBox } from './geometry';

describe('polygonBoundingBox', () => {
  it('computes bounding box of a simple rectangle polygon', () => {
    const polygon = [
      { x: 100, y: 50 },
      { x: 400, y: 50 },
      { x: 400, y: 300 },
      { x: 100, y: 300 },
    ];
    expect(polygonBoundingBox(polygon)).toEqual({
      minX: 100, minY: 50, maxX: 400, maxY: 300,
    });
  });

  it('computes bounding box of an L-shaped polygon', () => {
    const polygon = [
      { x: 0, y: 0 }, { x: 300, y: 0 },
      { x: 300, y: 200 }, { x: 500, y: 200 },
      { x: 500, y: 400 }, { x: 0, y: 400 },
    ];
    expect(polygonBoundingBox(polygon)).toEqual({
      minX: 0, minY: 0, maxX: 500, maxY: 400,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: FAIL — `polygonBoundingBox` not exported

- [ ] **Step 3: Implement `polygonBoundingBox`**

Add to `src/sketch/geometry.ts`:

```typescript
export function polygonBoundingBox(polygon: Point[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for `rasterizeToGrid`**

```typescript
// Add to src/sketch/geometry.test.ts
import { rasterizeToGrid } from './geometry';

describe('rasterizeToGrid', () => {
  it('rasterizes a single rectangle to a grid', () => {
    const polygon = [
      { x: 0, y: 0 }, { x: 30, y: 0 },
      { x: 30, y: 20 }, { x: 0, y: 20 },
    ];
    const { grid, originX, originY } = rasterizeToGrid([polygon], 10);
    // 3 columns (0,10,20) x 2 rows (0,10) = cells that are filled
    expect(grid.length).toBe(2); // rows
    expect(grid[0].length).toBe(3); // cols
    expect(grid[0][0]).toBe(true);
    expect(grid[1][2]).toBe(true);
  });

  it('rasterizes two non-overlapping rectangles', () => {
    const poly1 = [
      { x: 0, y: 0 }, { x: 20, y: 0 },
      { x: 20, y: 20 }, { x: 0, y: 20 },
    ];
    const poly2 = [
      { x: 40, y: 0 }, { x: 60, y: 0 },
      { x: 60, y: 20 }, { x: 40, y: 20 },
    ];
    const { grid } = rasterizeToGrid([poly1, poly2], 10);
    // Gap at columns 2,3 (x=20..40)
    expect(grid[0][0]).toBe(true);
    expect(grid[0][1]).toBe(true);
    expect(grid[0][2]).toBe(false); // gap
    expect(grid[0][3]).toBe(false); // gap
    expect(grid[0][4]).toBe(true);
    expect(grid[0][5]).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement `rasterizeToGrid`**

Add to `src/sketch/geometry.ts`:

```typescript
export interface GridResult {
  grid: boolean[][];
  originX: number;
  originY: number;
  cols: number;
  rows: number;
}

/**
 * Rasterize axis-aligned polygons onto a boolean grid.
 * Each cell is true if the cell center is inside any polygon.
 */
export function rasterizeToGrid(polygons: Point[][], gridSize: number): GridResult {
  // Find global bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const originX = Math.floor(minX / gridSize) * gridSize;
  const originY = Math.floor(minY / gridSize) * gridSize;
  const cols = Math.ceil((maxX - originX) / gridSize);
  const rows = Math.ceil((maxY - originY) / gridSize);

  const grid: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false)
  );

  // For each cell, test if its center is inside any polygon
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = originX + c * gridSize + gridSize / 2;
      const cy = originY + r * gridSize + gridSize / 2;
      for (const poly of polygons) {
        if (pointInPolygon({ x: cx, y: cy }, poly)) {
          grid[r][c] = true;
          break;
        }
      }
    }
  }

  return { grid, originX, originY, cols, rows };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing test for `traceContour`**

```typescript
// Add to src/sketch/geometry.test.ts
import { traceContour } from './geometry';

describe('traceContour', () => {
  it('traces a single filled rectangle', () => {
    const grid = [
      [true, true, true],
      [true, true, true],
    ];
    const contour = traceContour(grid, 10, 0, 0);
    // Should produce a rectangle: (0,0) -> (30,0) -> (30,20) -> (0,20)
    expect(contour.length).toBeGreaterThanOrEqual(4);
    // Verify it forms a closed polygon covering the right area
    const xs = contour.map(p => p.x);
    const ys = contour.map(p => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(30);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(20);
  });

  it('traces an L-shaped region', () => {
    const grid = [
      [true, true, true],
      [true, false, false],
      [true, false, false],
    ];
    const contour = traceContour(grid, 10, 0, 0);
    // L-shape: 6 vertices
    expect(contour.length).toBe(6);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: FAIL

- [ ] **Step 11: Implement `traceContour`**

Add to `src/sketch/geometry.ts`. This uses a marching-squares-like boundary trace on the boolean grid:

```typescript
/**
 * Trace the outer boundary of filled cells in a boolean grid.
 * Returns an axis-aligned polygon (vertices in order).
 * Uses a boundary-following algorithm on the grid edges.
 */
export function traceContour(
  grid: boolean[][], gridSize: number, originX: number, originY: number,
): Point[] {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  if (rows === 0 || cols === 0) return [];

  // Helper: is cell (r,c) filled?
  const filled = (r: number, c: number) =>
    r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c];

  // Collect all boundary edges between filled and unfilled cells.
  // Each edge is a segment between two grid-corner points.
  // Grid corners are at (originX + c*gridSize, originY + r*gridSize).
  type Edge = { x1: number; y1: number; x2: number; y2: number };
  const edges: Edge[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue;
      const x = originX + c * gridSize;
      const y = originY + r * gridSize;
      const s = gridSize;
      // Top edge: if cell above is not filled
      if (!filled(r - 1, c)) edges.push({ x1: x, y1: y, x2: x + s, y2: y });
      // Bottom edge
      if (!filled(r + 1, c)) edges.push({ x1: x + s, y1: y + s, x2: x, y2: y + s });
      // Left edge
      if (!filled(r, c - 1)) edges.push({ x1: x, y1: y + s, x2: x, y2: y });
      // Right edge
      if (!filled(r, c + 1)) edges.push({ x1: x + s, y1: y, x2: x + s, y2: y + s });
    }
  }

  if (edges.length === 0) return [];

  // Chain edges into a polygon: each edge's end point matches the next edge's start point
  const edgeMap = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.x1},${e.y1}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key)!.push(e);
  }

  const used = new Set<number>();
  const polygon: Point[] = [];
  let current = edges[0];
  used.add(0);
  polygon.push({ x: current.x1, y: current.y1 });

  for (let i = 0; i < edges.length - 1; i++) {
    const nextKey = `${current.x2},${current.y2}`;
    const candidates = edgeMap.get(nextKey);
    if (!candidates) break;
    const next = candidates.find((_, idx) => {
      const globalIdx = edges.indexOf(_);
      return !used.has(globalIdx);
    });
    if (!next) break;
    used.add(edges.indexOf(next));
    // Only add point if direction changes (avoid collinear points)
    const prev = polygon[polygon.length - 1];
    const mid = { x: current.x2, y: current.y2 };
    const nxt = { x: next.x2, y: next.y2 };
    const sameLine = (prev.x === mid.x && mid.x === nxt.x) ||
                     (prev.y === mid.y && mid.y === nxt.y);
    if (!sameLine) {
      polygon.push(mid);
    }
    current = next;
  }

  return polygon;
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: PASS

- [ ] **Step 13: Write failing test for `offsetAxisAlignedPolygon`**

```typescript
// Add to src/sketch/geometry.test.ts
import { offsetAxisAlignedPolygon } from './geometry';

describe('offsetAxisAlignedPolygon', () => {
  it('expands a rectangle outward by 10cm', () => {
    const rect = [
      { x: 100, y: 100 }, { x: 400, y: 100 },
      { x: 400, y: 300 }, { x: 100, y: 300 },
    ];
    const expanded = offsetAxisAlignedPolygon(rect, 10);
    const bb = polygonBoundingBox(expanded);
    expect(bb.minX).toBe(90);
    expect(bb.minY).toBe(90);
    expect(bb.maxX).toBe(410);
    expect(bb.maxY).toBe(310);
  });

  it('handles L-shaped polygon with concave corner', () => {
    // L-shape: top-left block + bottom spanning full width
    const L = [
      { x: 0, y: 0 }, { x: 200, y: 0 },
      { x: 200, y: 200 }, { x: 400, y: 200 },
      { x: 400, y: 400 }, { x: 0, y: 400 },
    ];
    const expanded = offsetAxisAlignedPolygon(L, 10);
    // Should have more vertices than the original (concave corner gets extra vertex)
    expect(expanded.length).toBeGreaterThanOrEqual(6);
    const bb = polygonBoundingBox(expanded);
    expect(bb.minX).toBe(-10);
    expect(bb.minY).toBe(-10);
    expect(bb.maxX).toBe(410);
    expect(bb.maxY).toBe(410);
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: FAIL

- [ ] **Step 15: Implement `offsetAxisAlignedPolygon`**

Add to `src/sketch/geometry.ts`:

```typescript
/**
 * Offset an axis-aligned polygon outward by `distance`.
 * Each edge shifts outward along its normal. At convex corners edges meet naturally.
 * At concave corners (inward notch), an extra vertex is inserted.
 * Polygon must be wound counter-clockwise (standard SVG winding).
 */
export function offsetAxisAlignedPolygon(polygon: Point[], distance: number): Point[] {
  const n = polygon.length;
  if (n < 3) return [...polygon];

  // Compute outward normal for each edge
  const normals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) { normals.push({ x: 0, y: 0 }); continue; }
    // Outward normal (for CCW winding): rotate edge direction 90° clockwise
    normals.push({ x: dy / len, y: -dx / len });
  }

  // Offset each edge and find intersections at corners
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prevIdx = (i - 1 + n) % n;
    const prevNormal = normals[prevIdx];
    const currNormal = normals[i];

    // Offset corner point along both adjacent edge normals
    const p = polygon[i];

    // For axis-aligned polygons, normals are either (0,1), (0,-1), (1,0), (-1,0)
    // At convex corners, both normals point "outward" — just add both offsets
    // At concave corners, normals point "inward" on one axis — need extra vertex
    const cross = prevNormal.x * currNormal.y - prevNormal.y * currNormal.x;

    if (Math.abs(cross) < 0.001) {
      // Collinear edges — just offset
      result.push({ x: p.x + currNormal.x * distance, y: p.y + currNormal.y * distance });
    } else if (cross > 0) {
      // Convex corner — single offset point at intersection
      result.push({
        x: p.x + (prevNormal.x + currNormal.x) * distance,
        y: p.y + (prevNormal.y + currNormal.y) * distance,
      });
    } else {
      // Concave corner — insert two points (one per edge) to avoid self-intersection
      result.push({
        x: p.x + prevNormal.x * distance,
        y: p.y + prevNormal.y * distance,
      });
      result.push({
        x: p.x + currNormal.x * distance,
        y: p.y + currNormal.y * distance,
      });
    }
  }

  return result;
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: PASS

- [ ] **Step 17: Commit geometry functions**

```bash
git add src/sketch/geometry.ts src/sketch/geometry.test.ts
git -c commit.gpgsign=false commit -m "feat(geometry): add grid rasterization, contour tracing, polygon offset"
```

---

### Task 2: Types — Add Envelope to FloorPlan

**Files:**
- Modify: `src/sketch/types.ts`

- [ ] **Step 1: Add `envelope` field to FloorPlanSchema**

In `src/sketch/types.ts`, add `envelope: z.array(PointSchema).optional()` to `FloorPlanSchema` (after `rooms`) and to `FloorPlanInputSchema`.

- [ ] **Step 2: Add `ENVELOPE_GAP_THRESHOLD` to defaults**

In `src/sketch/defaults.ts`, add:
```typescript
export const ENVELOPE_GAP_THRESHOLD = 50; // cm — gaps smaller than this are bridged
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npm test`
Expected: All 187 tests pass (envelope is optional, no breaking change)

- [ ] **Step 4: Commit**

```bash
git add src/sketch/types.ts src/sketch/defaults.ts
git -c commit.gpgsign=false commit -m "feat(types): add optional envelope polygon to FloorPlan schema"
```

---

### Task 3: Compile-Layout — Envelope Computation

**Files:**
- Modify: `src/sketch/compile-layout.ts`
- Modify: `src/sketch/compile-layout.test.ts`
- Modify: `src/sketch/geometry.ts` (import from)

- [ ] **Step 1: Write failing test for envelope generation**

Add to `src/sketch/compile-layout.test.ts`:

```typescript
describe('envelope computation', () => {
  it('generates an envelope for a single room', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Single Room',
      rooms: [{ label: 'Living', x: 0, y: 0, width: 400, depth: 300 }],
    };
    const plan = compileLayout(input);
    expect(plan.envelope).toBeDefined();
    expect(plan.envelope!.length).toBeGreaterThanOrEqual(4);
    // Envelope should be larger than room by exterior wall thickness (20cm default)
    const bb = plan.envelope!.reduce(
      (acc, p) => ({
        minX: Math.min(acc.minX, p.x), minY: Math.min(acc.minY, p.y),
        maxX: Math.max(acc.maxX, p.x), maxY: Math.max(acc.maxY, p.y),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    expect(bb.minX).toBeLessThan(0);
    expect(bb.minY).toBeLessThan(0);
    expect(bb.maxX).toBeGreaterThan(400);
    expect(bb.maxY).toBeGreaterThan(300);
  });

  it('generates envelope that bridges small gaps between rooms', () => {
    const input: SimpleFloorPlanInput = {
      name: 'Gap Test',
      rooms: [
        { label: 'Room A', x: 0, y: 0, width: 200, depth: 200 },
        { label: 'Room B', x: 240, y: 0, width: 200, depth: 200 }, // 40cm gap
      ],
    };
    const plan = compileLayout(input);
    expect(plan.envelope).toBeDefined();
    // Envelope should bridge the 40cm gap (< 50cm threshold)
    const xs = plan.envelope!.map(p => p.x);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(440);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/compile-layout.test.ts`
Expected: FAIL — `plan.envelope` is undefined

- [ ] **Step 3: Implement `computeEnvelope` in compile-layout.ts**

Add to `src/sketch/compile-layout.ts`:

```typescript
import { rasterizeToGrid, traceContour, offsetAxisAlignedPolygon } from './geometry';
import { ENVELOPE_GAP_THRESHOLD } from './defaults';

function computeEnvelope(
  rooms: Room[],
  exteriorThickness: number,
  gridSize: number = SNAP_GRID,
): Point[] | undefined {
  if (rooms.length === 0) return undefined;

  const polygons = rooms.map(r => r.polygon);

  // 1. Rasterize all room polygons onto a grid
  const { grid, originX, originY, cols, rows } = rasterizeToGrid(polygons, gridSize);

  // 2. Bridge small gaps via morphological close
  //    (dilate by gap threshold / gridSize cells, then erode by same amount)
  const dilateSteps = Math.ceil(ENVELOPE_GAP_THRESHOLD / gridSize / 2);
  let closed = grid;
  for (let step = 0; step < dilateSteps; step++) {
    closed = dilateGrid(closed, rows, cols);
  }
  for (let step = 0; step < dilateSteps; step++) {
    closed = erodeGrid(closed, rows, cols);
  }

  // 3. Trace the outer boundary contour
  const contour = traceContour(closed, gridSize, originX, originY);
  if (contour.length < 3) return undefined;

  // 4. Offset outward by exterior wall thickness
  return offsetAxisAlignedPolygon(contour, exteriorThickness / 2);
}

function dilateGrid(grid: boolean[][], rows: number, cols: number): boolean[][] {
  const result = grid.map(row => [...row]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c]) continue;
      // Fill if any 4-neighbor is filled
      if ((r > 0 && grid[r - 1][c]) || (r < rows - 1 && grid[r + 1][c]) ||
          (c > 0 && grid[r][c - 1]) || (c < cols - 1 && grid[r][c + 1])) {
        result[r][c] = true;
      }
    }
  }
  return result;
}

function erodeGrid(grid: boolean[][], rows: number, cols: number): boolean[][] {
  const result = grid.map(row => [...row]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue;
      // Clear if any 4-neighbor is unfilled (or edge)
      if (r === 0 || !grid[r - 1][c] || r === rows - 1 || !grid[r + 1][c] ||
          c === 0 || !grid[r][c - 1] || c === cols - 1 || !grid[r][c + 1]) {
        result[r][c] = false;
      }
    }
  }
  return result;
}
```

Then in `compileLayout()`, after step 4 (generate room polygons), add:

```typescript
  // 5. Compute building envelope
  const exteriorThickness = input.wallThickness?.exterior ?? WALL_THICKNESS.exterior;
  const envelope = computeEnvelope(rooms, exteriorThickness);
```

And add `envelope` to the returned FloorPlan object.

- [ ] **Step 4: Snap polygon vertices before processing**

At the top of `compileLayout()`, before `const rects = ...`:

```typescript
  // Snap polygon vertices to grid
  const snappedRooms = input.rooms.map(r => {
    if ('polygon' in r && r.polygon) {
      return { ...r, polygon: r.polygon.map(p => ({ x: snap(p.x), y: snap(p.y) })) };
    }
    return r;
  });
```

Then use `snappedRooms` instead of `input.rooms` for the rest of the function.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: New envelope tests pass, existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/sketch/compile-layout.ts src/sketch/compile-layout.test.ts
git -c commit.gpgsign=false commit -m "feat(compile): compute building envelope from room union"
```

---

### Task 4: SVG Renderer — Envelope Structural Mass

**Files:**
- Modify: `src/sketch/svg.ts`
- Modify: `src/sketch/geometry.ts` (update `boundingBox` to accept envelope)

- [ ] **Step 1: Update `boundingBox` to accept envelope**

In `src/sketch/geometry.ts`, modify the `boundingBox` function to accept an optional envelope:

```typescript
export function boundingBox(walls: Wall[], envelope?: Point[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  // ... existing wall-based computation ...

  // Also include envelope points if provided
  if (envelope) {
    for (const p of envelope) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  return { minX: minX - expand, minY: minY - expand, maxX: maxX + expand, maxY: maxY + expand };
}
```

- [ ] **Step 2: Add `renderStructure` to svg.ts**

Add new function to `src/sketch/svg.ts`:

```typescript
function renderStructure(envelope: Point[], rooms: Room[]): string {
  // 1. Envelope as filled structural mass
  const envPoints = envelope.map(p => `${p.x},${p.y}`).join(' ');
  const envPoly = `<polygon points="${envPoints}" fill="#333" stroke="none"/>`;

  // 2. Room polygons as colored cutouts (drawn on top, occluding the envelope)
  const roomCutouts = rooms.map(room => {
    const points = room.polygon.map(p => `${p.x},${p.y}`).join(' ');
    return `<polygon points="${points}" fill="${room.color}" stroke="none" data-id="${room.id}" data-type="room"/>`;
  }).join('\n    ');

  return envPoly + '\n    ' + roomCutouts;
}
```

- [ ] **Step 3: Update `floorPlanToSvg` to use envelope rendering**

In `src/sketch/svg.ts`, modify `floorPlanToSvg`:

```typescript
export function floorPlanToSvg(plan: FloorPlan): string {
  const bb = boundingBox(plan.walls, plan.envelope);
  // ... existing door arc / furniture bounding box expansion ...

  // Separate wall types for rendering
  const interiorWalls = plan.walls.filter(w => w.type === 'interior' || w.type === 'divider');
  const exteriorWalls = plan.walls.filter(w => w.type === 'exterior');

  // Use envelope rendering if available, otherwise fall back to legacy wall rendering
  const useEnvelope = !!plan.envelope;

  const structureLayer = useEnvelope
    ? renderStructure(plan.envelope!, plan.rooms)
    : renderRooms(plan.rooms, plan.units);

  const wallLayer = useEnvelope
    ? renderWalls(interiorWalls) // Only interior walls
    : renderWalls(plan.walls);  // Legacy: all walls

  const junctionLayer = useEnvelope
    ? '' // No junctions needed — envelope handles corners
    : renderJunctions(plan.walls);

  // Room labels and areas (drawn on top of structure)
  const labelLayer = useEnvelope
    ? renderRoomLabels(plan.rooms, plan.units)
    : ''; // Legacy mode: labels rendered inside renderRooms

  // Openings: interior on partition walls, exterior on exterior walls (both cut gaps)
  const openingWalls = useEnvelope ? [...interiorWalls, ...exteriorWalls] : plan.walls;

  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" style="background:#fff">
  <g id="structure">
    ${structureLayer}
  </g>
  <g id="walls">
    ${wallLayer}
    ${junctionLayer}
  </g>
  <g id="openings">
    ${renderOpenings(openingWalls)}
  </g>
  ${useEnvelope ? `<g id="room-labels">\n    ${labelLayer}\n  </g>` : ''}
  <g id="furniture">
    ${renderFurniture(plan.furniture)}
  </g>
  <g id="dimensions">
    ${renderDimensions(useEnvelope ? interiorWalls : plan.walls, plan.units)}
  </g>
  <g id="watermark">
    ${renderWatermark(vbX + vbW, vbY + vbH)}
  </g>
</svg>`;
}
```

- [ ] **Step 4: Add `renderRoomLabels` function**

When using envelope mode, room fills are handled by `renderStructure`, but labels/areas need a separate function:

```typescript
function renderRoomLabels(rooms: Room[], units: 'metric' | 'imperial'): string {
  return rooms.map(room => {
    const area = room.area ?? shoelaceArea(room.polygon);
    const areaLabel = units === 'imperial'
      ? `${(area * 10.7639).toFixed(1)} ft²`
      : `${area.toFixed(1)} m²`;
    const c = centroid(room.polygon);
    const label = `<text x="${c.x}" y="${c.y - 8}" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">${escXml(room.label)}</text>`;
    const areaText = `<text x="${c.x}" y="${c.y + 10}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">${areaLabel}</text>`;
    return [label, areaText].join('\n    ');
  }).join('\n    ');
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/sketch/svg.ts src/sketch/geometry.ts
git -c commit.gpgsign=false commit -m "feat(svg): envelope-based structural mass rendering"
```

---

### Task 5: Visual Verification Loop — Shore Drive

**Files:** No code changes — this is a generate/preview/compare cycle.

- [ ] **Step 1: Generate Shore Drive sketch using MCP tools**

Use `generate_floor_plan` with the CV-detected rooms from Shore Drive. Use the corrected room labels and types from the source image.

- [ ] **Step 2: Preview the generated sketch**

Use `preview_sketch` to get the rasterized SVG preview.

- [ ] **Step 3: Compare rasterized SVG vs source image**

Fetch source: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`

Compare:
- Does the building envelope follow the room layout (not a bounding rectangle)?
- Is structural mass visible between Bath/CL/W/D zones?
- Are interior walls thin lines?
- Are exterior openings (windows) rendering correctly through the envelope?

- [ ] **Step 4: Fix issues found, iterate**

Adjust geometry functions, rendering, or envelope computation. Re-generate, re-preview, compare again. Repeat until the output visibly improves over the pre-refactor version.

- [ ] **Step 5: Spot-check with Unit 2C**

Generate and preview Unit 2C to verify no regressions.

- [ ] **Step 6: Note CV issues in fix list**

Create `docs/superpowers/specs/2026-03-22-cv-fixes-needed.md` and log any CV-sourced issues (wrong room counts, bad labels, scale errors, missing rooms).

- [ ] **Step 7: Deploy and commit**

```bash
bash deploy.sh
```

---

### Task 6: Browser Renderer — Mirror Envelope Rendering

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Read the current browser renderer**

Read `src/sketcher/html.ts` to understand its rendering approach (it's a template string generating HTML/JS/Canvas or inline SVG).

- [ ] **Step 2: Add envelope rendering to browser**

Mirror the SVG renderer's structural mass approach:
1. Draw envelope polygon as filled `#333`
2. Draw room polygons as colored fills on top
3. Draw interior walls as thin lines
4. Draw openings with gaps cut through envelope
5. Room labels on top

Match the same z-ordering as svg.ts.

- [ ] **Step 3: Add backward compatibility check**

Check `if (plan.envelope)` — use envelope rendering for new sketches, fall back to legacy wall rendering for old sketches.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Deploy and verify in browser**

```bash
bash deploy.sh
```

Open the Shore Drive sketch URL in browser, compare to SVG preview. They should match.

- [ ] **Step 6: Commit**

```bash
git add src/sketcher/html.ts
git -c commit.gpgsign=false commit -m "feat(html): mirror envelope rendering in browser renderer"
```

---

## Phase 2: Fixture Catalog + Fill Patterns

### Task 7: Kitchen and Bathroom Fixtures

**Files:**
- Modify: `src/sketch/furniture-symbols.ts`

- [ ] **Step 1: Read current furniture-symbols.ts**

Understand the existing `furnitureSymbol()` dispatch pattern and SVG snippet format.

- [ ] **Step 2: Add kitchen fixture symbols**

Add cases for:
- `refrigerator` — rectangle with inner rectangle (door outline)
- `range` — rectangle with 4 circles (burners)
- `dishwasher` — rectangle with "DW" text
- `kitchen-sink` — rectangle with oval basin

Each takes `(width: number, depth: number)` and returns an SVG string.

- [ ] **Step 3: Add bathroom fixture symbols**

Add cases for:
- `toilet` — oval bowl + rectangular tank
- `bathtub` — rounded rectangle with drain circle
- `shower` — square with corner arc (spray head)
- `bathroom-sink` — semi-circle basin

- [ ] **Step 4: Add utility fixture symbols**

Add case for:
- `washer-dryer` — two stacked circles in a rectangle

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/sketch/furniture-symbols.ts
git -c commit.gpgsign=false commit -m "feat(furniture): add kitchen, bathroom, and utility fixture symbols"
```

---

### Task 8: Outdoor Room Fill Patterns

**Files:**
- Modify: `src/sketch/svg.ts`
- Modify: `src/sketch/defaults.ts`

- [ ] **Step 1: Add diagonal hatch pattern for outdoor rooms**

In `src/sketch/svg.ts`, add an SVG `<defs>` pattern for outdoor rooms:

```svg
<pattern id="outdoor-hatch" patternUnits="userSpaceOnUse" width="8" height="8">
  <path d="M0,8 L8,0" stroke="#9E9E9E" stroke-width="0.5"/>
</pattern>
```

- [ ] **Step 2: Apply hatch to balcony/terrace rooms in `renderStructure`**

When rendering room cutouts in envelope mode, check `room.type`. For `balcony` or `terrace`, use the hatch pattern as fill instead of the solid room color.

- [ ] **Step 3: Run tests and deploy**

Run: `npm test && bash deploy.sh`

- [ ] **Step 4: Visual verify — generate a sketch with a balcony, preview it**

- [ ] **Step 5: Commit**

```bash
git add src/sketch/svg.ts src/sketch/defaults.ts
git -c commit.gpgsign=false commit -m "feat(svg): outdoor hatch pattern for balcony and terrace rooms"
```

---

### Task 9: Final Visual Verification + CV Fix List

- [ ] **Step 1: Regenerate all 4 test images**

Generate sketches from all 4 test images (Shore Drive, Unit 2C, Apt 6C, Res 507). Preview each.

- [ ] **Step 2: Compare each against source**

For each sketch, compare rasterized SVG vs rasterized source. Document:
- What improved
- What still needs work
- Which issues trace to CV vs rendering

- [ ] **Step 3: Finalize CV fix list**

Complete `docs/superpowers/specs/2026-03-22-cv-fixes-needed.md` with all accumulated CV issues, prioritized by impact.

- [ ] **Step 4: Commit CV fix list**

```bash
git add docs/superpowers/specs/2026-03-22-cv-fixes-needed.md
git -c commit.gpgsign=false commit -m "docs: CV fix list accumulated during rendering work"
```
