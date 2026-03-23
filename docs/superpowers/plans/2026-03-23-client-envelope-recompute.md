# Client-Side Envelope Recomputation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the building envelope auto-recompute in real-time during wall drag in the browser, and after surgical geometry changes on the server, so the thick perimeter outline always matches current room geometry.

**Architecture:** Port the `computeEnvelope` pipeline (rasterize → morphological close → contour trace → offset) from `compile-layout.ts` / `geometry.ts` to vanilla JS in `html.ts`. Hook it into mousemove drag handlers, commit handlers, undo/redo, and `applyChangeLocal`. Add server-side recompute in `processChanges`. Remove `set_envelope` as a user-facing high-level operation.

**Tech Stack:** TypeScript (server), vanilla ES5 JS (browser/sketcher), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-23-client-envelope-recompute-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/sketch/compile-layout.ts` | Modify | Export `computeEnvelope` (currently module-private) |
| `src/sketch/high-level-changes.ts` | Modify | Remove `set_envelope` high-level op, add envelope recompute in `processChanges` |
| `src/sketch/types.ts` | Modify | Remove `SetEnvelopeSchema` from `HighLevelChangeSchema` union |
| `src/index.ts` | Modify | Remove `set_envelope` from tool description text |
| `src/sketcher/html.ts` | Modify | Port envelope functions, add room propagation during drag, hook envelope recompute into all mutation paths |
| `src/sketch/high-level-changes.test.ts` | Modify | Remove `set_envelope` test, add envelope recompute test |

---

### Task 1: Export `computeEnvelope` from compile-layout.ts

**Files:**
- Modify: `src/sketch/compile-layout.ts:522` — add `export` keyword

- [ ] **Step 1: Add `export` to `computeEnvelope`**

In `src/sketch/compile-layout.ts`, change line 522 from:

```typescript
function computeEnvelope(
```

to:

```typescript
export function computeEnvelope(
```

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors (the function was already used internally, now it's just exported)

- [ ] **Step 3: Commit**

```bash
git add src/sketch/compile-layout.ts
git commit -m "refactor: export computeEnvelope from compile-layout"
```

---

### Task 2: Remove `set_envelope` from high-level changes

**Files:**
- Modify: `src/sketch/high-level-changes.ts:138-141` — remove `SetEnvelopeSchema`
- Modify: `src/sketch/high-level-changes.ts:169` — remove from `HighLevelChangeSchema` union
- Modify: `src/sketch/high-level-changes.ts:727-732` — remove `compileSetEnvelope`
- Modify: `src/sketch/high-level-changes.ts:753` — remove switch case
- Modify: `src/sketch/types.ts:134` — remove from `ChangeSchema` union (low-level stays — see note)
- Modify: `src/index.ts:531,558` — remove from tool description

**IMPORTANT:** Only the **high-level** `set_envelope` is removed. The **low-level** `set_envelope` in `src/sketch/changes.ts:126` and `src/sketch/types.ts:134` stays — it's used internally. Wait — actually re-check: `types.ts:134` is the **low-level** `ChangeSchema`, not the high-level schema. Do NOT touch it. The high-level schema is `HighLevelChangeSchema` in `high-level-changes.ts:155-172`.

- [ ] **Step 1: Remove `SetEnvelopeSchema` definition**

In `src/sketch/high-level-changes.ts`, delete lines 138-141:

```typescript
const SetEnvelopeSchema = z.object({
  type: z.literal('set_envelope'),
  polygon: z.array(PointSchema).min(3),
});
```

- [ ] **Step 2: Remove `SetEnvelopeSchema` from the union**

In `src/sketch/high-level-changes.ts`, in the `HighLevelChangeSchema` union (line 169), remove `SetEnvelopeSchema,`

- [ ] **Step 3: Remove `compileSetEnvelope` function**

In `src/sketch/high-level-changes.ts`, delete lines 727-732:

```typescript
function compileSetEnvelope(_plan: FloorPlan, change: z.infer<typeof SetEnvelopeSchema>): Change[] {
  return [{
    type: 'set_envelope',
    polygon: change.polygon,
  }];
}
```

- [ ] **Step 4: Remove switch case**

In `src/sketch/high-level-changes.ts`, in `compileHighLevelChange` (line 753), remove:

```typescript
    case 'set_envelope': return compileSetEnvelope(plan, change);
```

- [ ] **Step 5: Remove from tool description in index.ts**

In `src/index.ts`:
- Line 531: keep as-is (the "15 types" count refers to low-level changes, and `set_envelope` remains as a low-level type)
- Lines 557-558: remove these two lines from the HIGH-LEVEL operations section:
```
Envelope:
- set_envelope: {polygon: [{x,y},...]} — set building outline
```

- [ ] **Step 6: Remove high-level `set_envelope` test**

In `src/sketch/high-level-changes.test.ts`, delete the entire `describe('set_envelope', ...)` block (lines 629-641).

- [ ] **Step 7: Verify tests pass**

Run: `npx vitest run src/sketch/high-level-changes.test.ts`
Expected: All remaining tests pass

- [ ] **Step 8: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/sketch/high-level-changes.ts src/index.ts src/sketch/high-level-changes.test.ts
git commit -m "refactor: remove set_envelope from high-level changes"
```

---

### Task 3: Auto-recompute envelope in `processChanges`

**Files:**
- Modify: `src/sketch/high-level-changes.ts:759-789` — add envelope recompute after geometry changes
- Test: `src/sketch/high-level-changes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/sketch/high-level-changes.test.ts`, inside the existing `describe('processChanges', ...)` block:

```typescript
it('recomputes envelope after resize_room', () => {
  const plan = makeTestPlan();
  // Give the plan an initial envelope
  plan.envelope = [
    { x: -10, y: -10 }, { x: 810, y: -10 },
    { x: 810, y: 310 }, { x: -10, y: 310 },
  ];
  // Resize Kitchen eastward by 200cm
  const result = processChanges(plan, [
    { type: 'resize_room', room: 'Kitchen', side: 'east', delta_cm: 200 },
  ]);
  // Envelope should be a valid polygon that differs from the original
  expect(result.envelope).toBeDefined();
  expect(result.envelope!.length).toBeGreaterThanOrEqual(3);
  expect(result.envelope!.every(p => typeof p.x === 'number' && typeof p.y === 'number')).toBe(true);
  expect(result.envelope).not.toEqual(plan.envelope);
  // The envelope should be wider now (max X should be larger)
  const maxX = Math.max(...result.envelope!.map(p => p.x));
  const origMaxX = Math.max(...plan.envelope.map(p => p.x));
  expect(maxX).toBeGreaterThan(origMaxX);
});

it('does not recompute envelope for non-geometry changes', () => {
  const plan = makeTestPlan();
  plan.envelope = [
    { x: -10, y: -10 }, { x: 810, y: -10 },
    { x: 810, y: 310 }, { x: -10, y: 310 },
  ];
  const originalEnvelope = [...plan.envelope];
  const result = processChanges(plan, [
    { type: 'rename_room', room: 'Kitchen', new_label: 'Main Kitchen' },
  ]);
  expect(result.envelope).toEqual(originalEnvelope);
});

it('skips envelope recompute when plan has no envelope', () => {
  const plan = makeTestPlan();
  // No envelope on this plan
  expect(plan.envelope).toBeUndefined();
  const result = processChanges(plan, [
    { type: 'resize_room', room: 'Kitchen', side: 'east', delta_cm: 200 },
  ]);
  // Should remain undefined — don't create an envelope from nothing
  expect(result.envelope).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/high-level-changes.test.ts -t "recomputes envelope"`
Expected: FAIL — envelope unchanged after resize

- [ ] **Step 3: Implement envelope recompute in `processChanges`**

In `src/sketch/high-level-changes.ts`:

Add import at top (near existing imports from `compile-layout`):

```typescript
import { computeEnvelope } from './compile-layout';
```

Then in `processChanges`, after the low-level changes are applied (after line 774) and before the canvas bounds recompute (line 777), add:

```typescript
  // Recompute envelope if geometry changed
  const geometryChangingTypes = new Set([
    'resize_room', 'move_room', 'add_room', 'remove_room', 'split_room', 'merge_rooms',
  ]);
  const hasGeometryChange = highLevelChanges.some(c => geometryChangingTypes.has(c.type));
  if (hasGeometryChange && current.envelope) {
    const extThickness = current.walls.find(w => w.type === 'exterior')?.thickness ?? 20;
    const newEnvelope = computeEnvelope(current.rooms, extThickness);
    if (newEnvelope) {
      current = { ...current, envelope: newEnvelope };
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/high-level-changes.test.ts`
Expected: All tests pass including the three new ones

- [ ] **Step 5: Commit**

```bash
git add src/sketch/high-level-changes.ts src/sketch/high-level-changes.test.ts
git commit -m "feat: auto-recompute envelope in processChanges after geometry changes"
```

---

### Task 4: Port envelope computation to browser JS

**Files:**
- Modify: `src/sketcher/html.ts` — add ~200 lines of vanilla JS envelope functions

This is the largest task. Port these functions from `src/sketch/geometry.ts` and `src/sketch/compile-layout.ts` into the `html.ts` sketcher blob as ES5-compatible vanilla JS. The functions are pure math with no external dependencies.

- [ ] **Step 1: Identify insertion point**

In `src/sketcher/html.ts`, find the `computeArea` function (used by the sketcher for room area calculation). The envelope functions should go right after it since they're in the same "geometry utilities" category. Search for `function computeArea` to find the exact location.

- [ ] **Step 2: Port `pointInPolygon`**

Add after `computeArea`:

```javascript
  function pointInPolygon(point, polygon) {
    if (polygon.length < 3) return false;
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i].x, yi = polygon[i].y;
      var xj = polygon[j].x, yj = polygon[j].y;
      var intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
```

- [ ] **Step 3: Port `rasterizeToGrid`**

```javascript
  function rasterizeToGrid(polygons, gridSize) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var pi = 0; pi < polygons.length; pi++) {
      for (var vi = 0; vi < polygons[pi].length; vi++) {
        var p = polygons[pi][vi];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    var originX = Math.floor(minX / gridSize) * gridSize;
    var originY = Math.floor(minY / gridSize) * gridSize;
    var cols = Math.ceil((maxX - originX) / gridSize);
    var rows = Math.ceil((maxY - originY) / gridSize);
    var grid = [];
    for (var r = 0; r < rows; r++) {
      grid[r] = [];
      for (var c = 0; c < cols; c++) {
        var cx = originX + c * gridSize + gridSize / 2;
        var cy = originY + r * gridSize + gridSize / 2;
        grid[r][c] = false;
        for (var pj = 0; pj < polygons.length; pj++) {
          if (pointInPolygon({ x: cx, y: cy }, polygons[pj])) {
            grid[r][c] = true;
            break;
          }
        }
      }
    }
    return { grid: grid, originX: originX, originY: originY, cols: cols, rows: rows };
  }
```

- [ ] **Step 4: Port `dilateGrid` and `erodeGrid`**

```javascript
  function dilateGrid(grid, rows, cols) {
    var result = [];
    for (var r = 0; r < rows; r++) {
      result[r] = [];
      for (var c = 0; c < cols; c++) result[r][c] = grid[r][c];
    }
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (grid[r][c]) continue;
        if ((r > 0 && grid[r-1][c]) || (r < rows-1 && grid[r+1][c]) ||
            (c > 0 && grid[r][c-1]) || (c < cols-1 && grid[r][c+1])) {
          result[r][c] = true;
        }
      }
    }
    return result;
  }

  function erodeGrid(grid, rows, cols) {
    var result = [];
    for (var r = 0; r < rows; r++) {
      result[r] = [];
      for (var c = 0; c < cols; c++) result[r][c] = grid[r][c];
    }
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (!grid[r][c]) continue;
        if (r === 0 || !grid[r-1][c] || r === rows-1 || !grid[r+1][c] ||
            c === 0 || !grid[r][c-1] || c === cols-1 || !grid[r][c+1]) {
          result[r][c] = false;
        }
      }
    }
    return result;
  }
```

- [ ] **Step 5: Port `traceContour`**

```javascript
  function traceContour(grid, gridSize, originX, originY) {
    var rows = grid.length;
    var cols = rows > 0 ? grid[0].length : 0;
    if (rows === 0 || cols === 0) return [];
    var filled = function(r, c) {
      return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c];
    };
    var edges = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (!grid[r][c]) continue;
        var x = originX + c * gridSize;
        var y = originY + r * gridSize;
        var s = gridSize;
        if (!filled(r-1, c)) edges.push({ x1: x, y1: y, x2: x+s, y2: y });
        if (!filled(r+1, c)) edges.push({ x1: x+s, y1: y+s, x2: x, y2: y+s });
        if (!filled(r, c-1)) edges.push({ x1: x, y1: y+s, x2: x, y2: y });
        if (!filled(r, c+1)) edges.push({ x1: x+s, y1: y, x2: x+s, y2: y+s });
      }
    }
    if (edges.length === 0) return [];
    var edgeMap = {};
    for (var ei = 0; ei < edges.length; ei++) {
      var key = edges[ei].x1 + ',' + edges[ei].y1;
      if (!edgeMap[key]) edgeMap[key] = [];
      edgeMap[key].push(ei);
    }
    var used = {};
    var polygon = [];
    var current = edges[0];
    used[0] = true;
    polygon.push({ x: current.x1, y: current.y1 });
    for (var i = 0; i < edges.length - 1; i++) {
      var nextKey = current.x2 + ',' + current.y2;
      var candidates = edgeMap[nextKey];
      if (!candidates) break;
      var next = null;
      var nextIdx = -1;
      for (var ci = 0; ci < candidates.length; ci++) {
        if (!used[candidates[ci]]) { next = edges[candidates[ci]]; nextIdx = candidates[ci]; break; }
      }
      if (!next) break;
      used[nextIdx] = true;
      var prev = polygon[polygon.length - 1];
      var mid = { x: current.x2, y: current.y2 };
      var nxt = { x: next.x2, y: next.y2 };
      var sameLine = (prev.x === mid.x && mid.x === nxt.x) ||
                     (prev.y === mid.y && mid.y === nxt.y);
      if (!sameLine) polygon.push(mid);
      current = next;
    }
    return polygon;
  }
```

- [ ] **Step 6: Port `offsetAxisAlignedPolygon`**

```javascript
  function offsetAxisAlignedPolygon(polygon, distance) {
    var n = polygon.length;
    if (n < 3) return polygon.slice();
    var normals = [];
    for (var i = 0; i < n; i++) {
      var a = polygon[i];
      var b = polygon[(i + 1) % n];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) { normals.push({ x: 0, y: 0 }); continue; }
      normals.push({ x: dy / len, y: -dx / len });
    }
    var result = [];
    for (var i = 0; i < n; i++) {
      var prevIdx = (i - 1 + n) % n;
      var prevNormal = normals[prevIdx];
      var currNormal = normals[i];
      var p = polygon[i];
      var cross = prevNormal.x * currNormal.y - prevNormal.y * currNormal.x;
      if (Math.abs(cross) < 0.001) {
        result.push({ x: p.x + currNormal.x * distance, y: p.y + currNormal.y * distance });
      } else if (cross > 0) {
        result.push({
          x: p.x + (prevNormal.x + currNormal.x) * distance,
          y: p.y + (prevNormal.y + currNormal.y) * distance,
        });
      } else {
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

- [ ] **Step 7: Add `computeEnvelope` coordinator and `getExteriorThickness` helper**

```javascript
  function getExteriorThickness(plan) {
    for (var i = 0; i < plan.walls.length; i++) {
      if (plan.walls[i].type === 'exterior') return plan.walls[i].thickness || 20;
    }
    return 20;
  }

  function recomputeEnvelope(plan) {
    if (!plan || !plan.envelope || plan.rooms.length === 0) return;
    var polygons = plan.rooms.map(function(r) { return r.polygon; });
    var gridSize = 10;
    var gapThreshold = 50;
    var result = rasterizeToGrid(polygons, gridSize);
    var dilateSteps = Math.ceil(gapThreshold / gridSize / 2);
    var pad = dilateSteps;
    var paddedRows = result.rows + pad * 2;
    var paddedCols = result.cols + pad * 2;
    var closed = [];
    for (var r = 0; r < paddedRows; r++) {
      closed[r] = [];
      for (var c = 0; c < paddedCols; c++) {
        var origR = r - pad;
        var origC = c - pad;
        closed[r][c] = origR >= 0 && origR < result.rows && origC >= 0 && origC < result.cols && result.grid[origR][origC];
      }
    }
    for (var step = 0; step < dilateSteps; step++) {
      closed = dilateGrid(closed, paddedRows, paddedCols);
    }
    for (var step = 0; step < dilateSteps; step++) {
      closed = erodeGrid(closed, paddedRows, paddedCols);
    }
    var unpadded = closed.slice(pad, pad + result.rows).map(function(row) { return row.slice(pad, pad + result.cols); });
    var contour = traceContour(unpadded, gridSize, result.originX, result.originY);
    if (contour.length < 3) return;
    var extThickness = getExteriorThickness(plan);
    plan.envelope = offsetAxisAlignedPolygon(contour, extThickness / 2);
  }
```

Note: `recomputeEnvelope` mutates `plan.envelope` in place (consistent with how all other sketcher code mutates plan). It's a no-op if `plan.envelope` is falsy (no envelope to update) or rooms is empty.

- [ ] **Step 8: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors (html.ts is a string template, so TypeScript won't check the JS inside, but the outer template literal must be valid)

- [ ] **Step 9: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: port computeEnvelope pipeline to browser-side JS"
```

---

### Task 5: Add room polygon propagation during mousemove

**Files:**
- Modify: `src/sketcher/html.ts` — extract shared propagation helper, add to `updateWallDrag` and `updateEndpointDrag`

Currently room polygons only update in commit functions (mouseup). For real-time envelope rendering, they must also update during mousemove. We use absolute deltas from original positions (stored at drag-start) to avoid floating-point drift.

- [ ] **Step 1: Add `propagateRoomPolygons` helper**

Add near the other geometry helpers (after `recomputeEnvelope`):

```javascript
  // Propagate room polygon vertices that are near reference points.
  // Uses absolute delta from original positions to avoid floating-point drift.
  // refPoints: array of {orig: {x,y}, delta: {x,y}} — each reference point and its displacement
  function propagateRoomPolygons(plan, refPoints) {
    var maxThick = 0;
    for (var ti = 0; ti < plan.walls.length; ti++) {
      if ((plan.walls[ti].thickness || 10) > maxThick) maxThick = plan.walls[ti].thickness || 10;
    }
    var roomThreshold = maxThick + 5;
    for (var rpi = 0; rpi < plan.rooms.length; rpi++) {
      var room = plan.rooms[rpi];
      // Use original polygon if available, otherwise current
      var srcPolygon = room._origPolygon || room.polygon;
      var changed = false;
      var newPolygon = srcPolygon.map(function(v) {
        for (var ri = 0; ri < refPoints.length; ri++) {
          var ref = refPoints[ri];
          if (Math.abs(v.x - ref.orig.x) <= roomThreshold && Math.abs(v.y - ref.orig.y) <= roomThreshold) {
            changed = true;
            return { x: v.x + ref.delta.x, y: v.y + ref.delta.y };
          }
        }
        return { x: v.x, y: v.y };
      });
      if (changed) {
        room.polygon = newPolygon;
        room.area = computeArea(newPolygon);
      }
    }
  }
```

- [ ] **Step 2: Store original room polygons at drag-start for wall drag**

In the wall drag initiation code (search for where `wallDragState` is first created/assigned — this is in the mousedown handler). After `wallDragState` is set up, add:

```javascript
    // Snapshot original room polygons for drift-free propagation during drag
    for (var ri = 0; ri < plan.rooms.length; ri++) {
      plan.rooms[ri]._origPolygon = plan.rooms[ri].polygon.map(function(v) { return { x: v.x, y: v.y }; });
    }
```

Do the same for endpoint drag initiation (where `dragState` is created).

- [ ] **Step 3: Hook propagation into `updateWallDrag`**

At the end of `updateWallDrag` (before the `sendWsThrottled` call at line 2114), add:

```javascript
    // Propagate room polygons during drag (absolute delta from originals)
    propagateRoomPolygons(plan, [
      { orig: wallDragState.origStart, delta: { x: dx, y: dy } },
      { orig: wallDragState.origEnd, delta: { x: dx, y: dy } },
    ]);
```

Note: `dx` and `dy` are already the absolute delta from original positions (computed at line 2046-2070 as the full perpendicular projection from grab point).

- [ ] **Step 4: Hook propagation into `updateEndpointDrag`**

At the end of `updateEndpointDrag` (before the `sendWsThrottled` call at line 1790), add:

```javascript
    // Propagate room polygons during drag (absolute delta from originals)
    var epDx = pt.x - dragState.startPoint.x;
    var epDy = pt.y - dragState.startPoint.y;
    if (epDx !== 0 || epDy !== 0) {
      // For endpoint drag, the dragged point and all connected wall endpoints
      // share the same delta (they all move to the same point)
      var epRefs = [{ orig: dragState.startPoint, delta: { x: epDx, y: epDy } }];
      // Connected walls also have endpoints at the same original position
      // (they share an endpoint with the dragged wall), so the single ref point covers them
      propagateRoomPolygons(plan, epRefs);
    }
```

- [ ] **Step 5: Clean up original polygons on commit**

In both `commitWallDrag` and `commitEndpointDrag`, after the undo push and before `render()`, add:

```javascript
    // Clean up drag-start snapshots
    for (var ri = 0; ri < plan.rooms.length; ri++) {
      delete plan.rooms[ri]._origPolygon;
    }
```

- [ ] **Step 6: Refactor commit functions — record undo without re-propagating**

Since rooms are now propagated during mousemove, the commit functions must NOT re-propagate (that would double-apply). Instead, they just record undo/redo entries by comparing `_origPolygon` to current polygon.

**In `commitWallDrag`:** Replace the entire room propagation block (the comment at line 2142 through the closing brace at line 2174 — everything from `// Room polygon propagation` to the end of the `if (dxS !== 0 || dyS !== 0) { ... }` block) with:

```javascript
    // Record room polygon changes for undo (rooms already propagated during drag)
    for (var rpi = 0; rpi < plan.rooms.length; rpi++) {
      var room = plan.rooms[rpi];
      if (room._origPolygon) {
        var origPoly = room._origPolygon;
        var curPoly = room.polygon;
        var polyChanged = false;
        if (origPoly.length === curPoly.length) {
          for (var pci = 0; pci < origPoly.length; pci++) {
            if (origPoly[pci].x !== curPoly[pci].x || origPoly[pci].y !== curPoly[pci].y) {
              polyChanged = true;
              break;
            }
          }
        } else {
          polyChanged = true;
        }
        if (polyChanged) {
          changes.push({ type: 'update_room', room_id: room.id, polygon: curPoly.map(function(v) { return { x: v.x, y: v.y }; }) });
          inverseChanges.push({ type: 'update_room', room_id: room.id, polygon: origPoly.map(function(v) { return { x: v.x, y: v.y }; }) });
        }
      }
    }
```

**In `commitEndpointDrag`:** Apply the exact same replacement to lines 1889-1920 (the room propagation block that starts with `var origPt = dragState.startPoint;`). Replace that entire block with the same `_origPolygon`-based undo recording code above (substituting `room` variable names as appropriate — they use the same pattern).

**Key points:**
- The old code computed deltas and applied them to room polygons. The new code just records what changed.
- `_origPolygon` was set at drag-start (Step 2). It's the ground truth for undo.
- If `_origPolygon` doesn't exist (shouldn't happen but defensive), no undo entry is recorded for that room.

- [ ] **Step 7: Clean up `_origPolygon` on drag cancel/revert**

Search `html.ts` for any paths where a drag is cancelled without going through the commit functions — for example, the degenerate wall revert in `commitEndpointDrag` (lines 1849-1865 where `wlen < 5` causes revert). After any such revert, also clean up `_origPolygon` and restore original room polygons:

```javascript
    // Revert room polygons to originals and clean up
    for (var ri = 0; ri < plan.rooms.length; ri++) {
      if (plan.rooms[ri]._origPolygon) {
        plan.rooms[ri].polygon = plan.rooms[ri]._origPolygon;
        plan.rooms[ri].area = computeArea(plan.rooms[ri]._origPolygon);
        delete plan.rooms[ri]._origPolygon;
      }
    }
```

Also check if there's an Escape key handler that cancels drags — if so, add the same cleanup there.

- [ ] **Step 8: Verify by manual testing**

Open the sketcher (`open_sketcher` tool or direct URL), load a floor plan with envelope, drag a wall. Rooms should visually follow the wall during drag.

- [ ] **Step 9: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: propagate room polygons during wall drag for real-time feedback"
```

---

### Task 6: Hook envelope recompute into drag handlers (with escape hatch)

**Files:**
- Modify: `src/sketcher/html.ts` — add `recomputeEnvelope` calls in drag, commit, undo, redo, and applyChangeLocal

- [ ] **Step 1: Add `envelopeDegraded` flag**

Near the top of the sketcher IIFE (where other state variables like `isDragging`, `dragState` are declared), add:

```javascript
  var envelopeDegraded = false;
```

- [ ] **Step 2: Hook into `updateWallDrag` and `updateEndpointDrag`**

At the end of both functions (after the room propagation added in Task 5, before `sendWsThrottled`), add:

```javascript
    // Recompute envelope in real-time (with performance escape hatch)
    if (!envelopeDegraded && plan.envelope) {
      var t0 = performance.now();
      recomputeEnvelope(plan);
      if (performance.now() - t0 > 16) envelopeDegraded = true;
    }
```

Since the drag handlers use direct DOM updates (not `render()`), we also need to update the envelope SVG element directly. After `recomputeEnvelope`, add:

```javascript
    // Update envelope polygon in DOM
    if (plan.envelope) {
      var envEl = svg.querySelector('#structure polygon:first-child');
      if (envEl) {
        envEl.setAttribute('points', plan.envelope.map(function(p) { return p.x + ',' + p.y; }).join(' '));
      }
    }
```

Also update the room cutout polygons (since rooms moved):

```javascript
    // Update room cutout polygons in DOM
    for (var rci = 0; rci < plan.rooms.length; rci++) {
      var rcRoom = plan.rooms[rci];
      var rcEl = svg.querySelector('#structure [data-type="room"][data-id="' + rcRoom.id + '"]');
      if (rcEl) {
        rcEl.setAttribute('points', rcRoom.polygon.map(function(p) { return p.x + ',' + p.y; }).join(' '));
      }
    }
```

**IMPORTANT:** If `plan.envelope` is falsy (legacy mode, no envelope), skip all envelope DOM updates. The room polygon DOM update is also only needed in envelope mode since in legacy mode room polygons are in a different SVG group. Guard with `if (plan.envelope) { ... }` for the room cutout updates too.

- [ ] **Step 3: Hook into commit functions**

In both `commitWallDrag` and `commitEndpointDrag`, after room polygon cleanup and before `render()`:

```javascript
    // Always recompute envelope on commit (catch-up for degraded mode)
    recomputeEnvelope(plan);
    envelopeDegraded = false;
```

- [ ] **Step 4: Hook into undo/redo**

In `performUndo` (line 1811), after the loop that applies inverse changes and before `render()` (line 1822):

```javascript
    recomputeEnvelope(plan);
```

Same in `performRedo` (line 1826), after the forward changes loop and before `render()` (line 1837):

```javascript
    recomputeEnvelope(plan);
```

- [ ] **Step 5: Hook into `applyChangeLocal` for server-pushed changes**

At the end of `applyChangeLocal` (after the switch statement), add:

```javascript
    // Recompute envelope when room geometry changes externally
    if (change.type === 'update_room' || change.type === 'add_room' || change.type === 'remove_room') {
      recomputeEnvelope(plan);
    }
```

- [ ] **Step 6: Verify by manual testing**

Open the sketcher, load a plan with an envelope:
1. Drag a wall — envelope should follow in real-time
2. Undo the drag — envelope should revert
3. Redo — envelope should re-apply

- [ ] **Step 7: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: real-time envelope recompute during drag with 16ms escape hatch"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (272+ tests)

- [ ] **Step 2: Build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Deploy and smoke test**

Run: `bash deploy.sh`

Then test via MCP tools:
1. Generate a floor plan (`generate_floor_plan`)
2. Preview it (`preview_sketch`) — verify envelope renders
3. Apply a surgical resize (`update_sketch` with `resize_room`)
4. Preview again — verify envelope updated to match new room size
5. Open in sketcher (`open_sketcher`)
6. Drag a wall — verify envelope follows in real-time

- [ ] **Step 4: Commit any fixes**

If smoke testing reveals issues, fix and commit.
