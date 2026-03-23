# Client-Side Envelope Recomputation

## Problem

The building envelope (the thick dark perimeter outline) is computed once during `generate_floor_plan` and never updated. When rooms are modified — via surgical operations (resize_room, move_room) or direct wall dragging in the sketcher UI — the envelope becomes stale. The room geometry changes but the perimeter stays frozen, creating a visual mismatch.

The `set_envelope` high-level operation was added as a workaround but makes things worse: it replaces the envelope polygon without updating walls, creating a topological mismatch between the perimeter rendering and actual wall positions.

Claude Desktop confirmed this during testing: resizing a room pushed it past the envelope, and attempting `set_envelope` to fix it broke the existing exterior walls.

## Solution

Make the envelope a derived property that always reflects current room geometry. Recompute it automatically in both the browser (sketcher UI) and the server (surgical operations). Remove `set_envelope` as a user-facing operation.

## Design

### 1. Port envelope computation to the browser

Five pure functions are ported as vanilla JS into `src/sketcher/html.ts`:

- `pointInPolygon(point, polygon)` — ray-casting point-in-polygon test
- `rasterizeToGrid(polygons, gridSize)` — rasterize room polygons onto a boolean grid
- `dilateGrid(grid, rows, cols)` / `erodeGrid(grid, rows, cols)` — morphological close to bridge small gaps
- `traceContour(grid, gridSize, originX, originY)` — trace outer boundary of filled cells into a polygon
- `offsetAxisAlignedPolygon(polygon, distance)` — offset polygon outward by wall thickness

Note: `rasterizeToGrid` calls `pointInPolygon` internally — these form a dependency chain.

Plus a coordinator:

```javascript
function computeEnvelope(rooms, exteriorThickness) {
  if (rooms.length === 0) return undefined;
  var polygons = rooms.map(function(r) { return r.polygon; });
  var gridSize = 10; // SNAP_GRID
  var result = rasterizeToGrid(polygons, gridSize);
  var gapThreshold = 50; // ENVELOPE_GAP_THRESHOLD
  var dilateSteps = Math.ceil(gapThreshold / gridSize / 2);
  // Pad, dilate, erode, unpad (morphological close)
  // ... same algorithm as compile-layout.ts lines 534-554
  var contour = traceContour(unpadded, gridSize, result.originX, result.originY);
  if (contour.length < 3) return undefined;
  return offsetAxisAlignedPolygon(contour, exteriorThickness / 2);
}
```

Return type is `undefined` (not `null`) to match the Zod schema (`z.array(PointSchema).optional()`).

These are direct ports of the existing TypeScript in `src/sketch/geometry.ts` and `src/sketch/compile-layout.ts`, converted to ES5-compatible vanilla JS to match `html.ts` conventions.

Constants inlined: `SNAP_GRID = 10`, `ENVELOPE_GAP_THRESHOLD = 50`.

### 2. Propagate room polygons during mousemove (new)

Currently, room polygon vertices only propagate in the commit functions (`commitWallDrag` at line 2142, `commitEndpointDrag` at line 1889). The mousemove handlers (`updateWallDrag` at line 2039, `updateEndpointDrag` at line 1723) only move wall positions — they don't update room polygons.

For real-time envelope updates, room polygons must also propagate during mousemove. Extract the room propagation logic from the commit functions into a shared helper:

```javascript
function propagateRoomPolygons(plan, origStart, origEnd, dx, dy) {
  if (dx === 0 && dy === 0) return;
  var maxThick = 0;
  for (var ti = 0; ti < plan.walls.length; ti++) {
    if ((plan.walls[ti].thickness || 10) > maxThick) maxThick = plan.walls[ti].thickness || 10;
  }
  var roomThreshold = maxThick + 5;
  for (var rpi = 0; rpi < plan.rooms.length; rpi++) {
    var room = plan.rooms[rpi];
    var changed = false;
    var newPolygon = room.polygon.map(function(v) {
      var nearStart = Math.abs(v.x - origStart.x) <= roomThreshold && Math.abs(v.y - origStart.y) <= roomThreshold;
      var nearEnd = Math.abs(v.x - origEnd.x) <= roomThreshold && Math.abs(v.y - origEnd.y) <= roomThreshold;
      if (nearStart || nearEnd) { changed = true; return { x: v.x + dx, y: v.y + dy }; }
      return { x: v.x, y: v.y };
    });
    if (changed) {
      room.polygon = newPolygon;
      room.area = computeArea(newPolygon);
    }
  }
}
```

Call this in both `updateWallDrag` and `updateEndpointDrag` (during mousemove), and refactor the commit functions to use it too.

**Important:** The commit functions currently compute the delta from the original saved positions. During mousemove, we need to compute incremental deltas (frame-to-frame) since room polygons are now being updated continuously. Store previous frame positions in the drag state to compute incremental deltas.

### 3. Real-time envelope recomputation with performance escape hatch

**During drag (mousemove handler):**

After room polygon propagation (section 2 above), recompute the envelope. Wrap in timing:

```javascript
var envelopeDegraded = false;

// In updateWallDrag / updateEndpointDrag, after propagateRoomPolygons:
if (!envelopeDegraded && plan.envelope) {
  var t0 = performance.now();
  var extThickness = getExteriorThickness(plan);
  var newEnv = computeEnvelope(plan.rooms, extThickness);
  if (newEnv) plan.envelope = newEnv;
  if (performance.now() - t0 > 16) {
    envelopeDegraded = true;
  }
}
```

If a single `computeEnvelope` call exceeds 16ms (one frame budget), set `envelopeDegraded = true` and stop calling during that drag session. The room cutouts still update in real-time; only the perimeter outline freezes.

**On mouseup (commit functions):**

Always recompute regardless of degraded flag, then reset:

```javascript
// At end of commitWallDrag / commitEndpointDrag, after room propagation:
if (plan.envelope) {
  var extThickness = getExteriorThickness(plan);
  var newEnv = computeEnvelope(plan.rooms, extThickness);
  if (newEnv) plan.envelope = newEnv;
}
envelopeDegraded = false;
```

**Helper for exterior thickness:**

```javascript
function getExteriorThickness(plan) {
  for (var i = 0; i < plan.walls.length; i++) {
    if (plan.walls[i].type === 'exterior') return plan.walls[i].thickness || 20;
  }
  return 20;
}
```

### 4. Integration points in html.ts

The envelope recomputation hooks into five locations:

1. **`updateWallDrag()`** (line 2039) — mousemove handler for wall segment drag. Add room polygon propagation + envelope recompute after wall position update.

2. **`updateEndpointDrag()`** (line 1723) — mousemove handler for endpoint drag handles. Add room polygon propagation + envelope recompute after endpoint position update.

3. **`commitWallDrag()`** (line 2117) and **`commitEndpointDrag()`** (line 1841) — mouseup handlers. Refactor to use shared `propagateRoomPolygons` helper. Add envelope recompute after room propagation, before `render()`. Reset `envelopeDegraded`.

4. **`performUndo()`** (line 1811) and **`performRedo()`** (line 1826) — after applying inverse/forward changes, recompute envelope before `render()`. Undo of a wall drag restores wall and room positions but would leave the envelope stale without this.

5. **`applyChangeLocal()`** (around line 640) — when `update_room` changes arrive from the server or undo pipeline, recompute envelope. Guard with a flag to avoid redundant recomputation when multiple `update_room` changes arrive in a batch — defer to after all changes in the batch are applied.

The `render()` function (envelope rendering at line 831) already handles `plan.envelope` correctly — no changes needed there.

### 5. Server-side: auto-recompute in processChanges

In `src/sketch/high-level-changes.ts`, at the end of `processChanges`, after all high-level changes are applied:

```typescript
const geometryChangingTypes = new Set([
  'resize_room', 'move_room', 'add_room', 'remove_room', 'split_room', 'merge_rooms'
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

This requires importing `computeEnvelope` from `compile-layout.ts`, which means exporting it (currently it's a module-private function).

Note: any new geometry-changing high-level operations added in the future must be added to this set.

### 6. Remove set_envelope from user-facing operations

**Remove from high-level change schema** (`src/sketch/types.ts`):
- Remove the `set_envelope` variant from the `HighLevelChange` Zod union

**Remove from compiler** (`src/sketch/high-level-changes.ts`):
- Remove `compileSetEnvelope` function
- Remove `set_envelope` case from `compileHighLevelChange` switch

**Remove from tool description** (`src/index.ts`):
- Remove `set_envelope` from the `high_level_changes` parameter documentation

**Keep the low-level `set_envelope` change type** (`src/sketch/changes.ts`):
- The low-level `set_envelope` in `applyChanges` stays. It's used internally for canvas bounds and could be useful for programmatic override. It's just not exposed as a high-level user operation anymore.

### 7. Update tests

- Remove `set_envelope` high-level change tests from `high-level-changes.test.ts`
- Add test in `high-level-changes.test.ts` verifying that `processChanges` recomputes envelope after `resize_room`
- The low-level `set_envelope` tests in `changes.test.ts` stay

## Performance Analysis

Typical floor plan: ~10 rooms, each 4-6 vertices.

- Grid: rooms span ~2000x1500cm at gridSize=10 → 200x150 = 30,000 cells
- Rasterization: 30,000 cells × 10 polygons × ~5 edge tests = 1.5M comparisons
- Morphological close: 2-3 dilate/erode passes × 30,000 cells = ~180,000 ops
- Contour trace: O(boundary edges), typically ~700 edges
- Offset: O(contour vertices), typically ~50 vertices

Total: well under 1ms on modern hardware. The 16ms escape hatch triggers only for extreme plans (50+ rooms or very large floor areas).

## Files Modified

| File | Change |
|------|--------|
| `src/sketcher/html.ts` | Add ~200 lines of ported envelope functions, add `propagateRoomPolygons` helper, recompute in drag/commit/undo/redo/applyChangeLocal |
| `src/sketch/high-level-changes.ts` | Auto-recompute in `processChanges`, remove `compileSetEnvelope` |
| `src/sketch/compile-layout.ts` | Export `computeEnvelope` |
| `src/sketch/types.ts` | Remove `set_envelope` from `HighLevelChange` union |
| `src/sketch/changes.ts` | No change (low-level `set_envelope` stays) |
| `src/index.ts` | Remove `set_envelope` from tool description |
| `src/sketch/high-level-changes.test.ts` | Remove `set_envelope` tests, add envelope recompute test |

## Out of Scope

- Optimizing the rasterization algorithm (not needed given performance analysis)
- Making envelope editable as a direct-manipulation object (envelope is derived, not a first-class entity)
- Changing how `generate_floor_plan` computes the initial envelope (already correct)
