# Envelope-Based Rendering + Polygon Rooms

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Frontend tooling (compile-layout, SVG/HTML renderers, geometry)

## Problem

The current rendering pipeline has fundamental limitations that prevent accurate floor plan output:

1. **Rectangle-only rooms** — Polygon rooms from CV are reduced to bounding boxes via `roomToRect()`. L-shaped living rooms, irregular closets, and stepped building shapes are lost.
2. **Individual wall segments** — Walls are generated per-room-edge and rendered independently. Adjacent thick walls overlap or leave gaps instead of coalescing into structural mass.
3. **No building envelope** — The perimeter is a fat rectangle around all rooms, regardless of actual building shape. No concept of "the building outline."
4. **Missing fixtures** — No kitchen appliances, bathroom fixtures, or utility equipment in the furniture catalog.
5. **No outdoor differentiation** — Balconies render identically to interior rooms.

## Design Decisions

### Envelope-minus-rooms rendering model

**Decision:** Replace individual exterior wall segments with a single structural mass shape computed as: building envelope minus room polygons.

**Rationale:** In professional floor plans, thick black isn't placed as individual wall objects — it's the result of drawing the building outline and cutting rooms out. This naturally produces:
- Correct building perimeter shape (follows room layout, not a bounding rectangle)
- Structural mass between clustered small rooms (bath/closet/W/D zones)
- No wall overlap or coalescence problems — there's only one shape

**Trade-off:** Exterior walls change role from "visual + data" to "data only." They remain in `FloorPlan.walls` as objects carrying opening data and defining room boundaries, but are no longer rendered as individual thick polygons. The envelope handles the visual structural mass. Interior partition walls remain as discrete, draggable objects.

### Exterior openings (windows on the building perimeter)

**Decision:** Exterior walls remain in the data model. The renderer reads their openings to cut visual gaps in the envelope fill.

**Key insight:** The envelope is purely a rendering construct. Exterior walls are purely a data construct. They don't interfere:
- The envelope defines *what the structure looks like* (filled polygon)
- Exterior walls define *where openings go* (data containers with opening arrays)
- The renderer draws the envelope, then reads exterior walls' openings to cut gaps and draw opening symbols

**No change protocol changes needed.** `add_opening`, `remove_opening`, `update_opening` (all keyed by `wall_id`) work unchanged. Users can add, remove, resize, and change type of windows on exterior walls exactly as today. The wall objects are just no longer drawn as individual thick polygons.

**Rendering:** During envelope rendering, the renderer iterates exterior walls with openings. For each opening, it computes the opening's position on the envelope boundary and:
1. Draws a white rectangle over the envelope fill at the gap position
2. Draws the opening symbol (window mullions, door swing arc) in that gap

### Polygon room support (axis-aligned)

**Decision:** Support axis-aligned polygon rooms (all edges horizontal or vertical). No diagonal walls in this phase.

**Rationale:** Covers ~95% of real floor plans. The existing `getPolygonEdges()` function already extracts axis-aligned edges from polygon vertices. The shared edge detection already works on `Edge` structs — it needs collinear segment overlap (general, angle-agnostic) instead of axis-only matching, which costs ~10 lines of math and future-proofs for oblique walls.

**Trade-off:** 5% of floor plans with angled walls won't render perfectly. The data model and edge detection are angle-ready; only rendering polish (miter joins at non-90° corners) is deferred.

### Gap bridging

**Decision:** When computing the building envelope, gaps smaller than 50cm between room polygons are automatically filled.

**Rationale:** CV output often has small gaps between rooms that should be continuous (e.g., hallway ending at x=270, bedroom starting at x=390). These gaps are inside the building but have no room defined. Filling small gaps produces a correct envelope without requiring the CV or AI to define filler rooms.

**Note:** 50cm is a configurable constant (`ENVELOPE_GAP_THRESHOLD`). It's roughly doorway width — large enough to catch CV alignment gaps, small enough to avoid merging separate structures across a breezeway. If real-world testing shows false positives, reduce to 30cm.

### Interior partition tolerance

**Decision:** Two parallel edges within 20cm (existing `SNAP_TOLERANCE`) that overlap are treated as one shared edge. The partition line is drawn at their average position.

**Rationale:** CV output produces slight misalignments (room A edge at x=300, room B edge at x=302). Without tolerance, both edges generate separate walls that overlap. The existing tolerance constant is already tuned for this.

### Polygon vertex snapping

**Decision:** All polygon vertices from CV input are snapped to the snap grid (10cm) before storage. This ensures room polygon fills align with interior wall positions (which are also snapped).

**Implementation:** In `compileLayout()`, after parsing polygon rooms, snap each vertex: `{ x: snap(p.x), y: snap(p.y) }`. This happens before edge extraction, envelope computation, and room polygon storage.

## Architecture

### Phase 1: Polygon Rooms + Envelope Rendering

#### compile-layout.ts changes

1. **Snap polygon vertices** — Before any computation, snap all polygon room vertices to the grid. Rect rooms are already snapped via `roomToRect()`.

2. **Remove bounding-box reduction for polygon rooms** — `roomToRect()` still computes a bounding box (needed for furniture placement, label positioning), but `generateRoom()` uses the actual polygon for the room shape. Wall edges come from `getPolygonEdges()` for polygon rooms (already implemented).

3. **Keep exterior walls as data, stop rendering them as thick polygons** — The `generateWalls()` function continues to emit both interior and exterior walls. Exterior walls remain in `FloorPlan.walls` as data containers for openings. The *renderer* changes to not draw them as thick polygons — the envelope handles the visual.

4. **Compute building envelope** — New function `computeEnvelope(rooms: Room[], exteriorThickness: number): Point[]`:
   - Take all room polygons
   - Snap to grid, rasterize rooms onto a 10cm grid, fill cells
   - Bridge gaps < `ENVELOPE_GAP_THRESHOLD` (morphological close on the grid)
   - Trace the outer boundary contour
   - Offset outward by exterior wall thickness
   - Return the envelope polygon

5. **Add envelope to FloorPlan** — Store the computed envelope polygon so renderers can use it.

6. **Opening placement unchanged** — `placeOpenings()` continues to work as today. Exterior openings attach to exterior wall objects via `wall_id`. The renderer reads these openings to cut gaps in the envelope visual.

#### types.ts changes

- Add `envelope?: Point[]` to `FloorPlanSchema` — the building outline polygon
- Add `envelope?: Point[]` to `FloorPlanInputSchema` — allow manual override

#### geometry.ts changes

New functions:
- `rasterizeToGrid(polygons: Point[][], gridSize: number): boolean[][]` — rasterize axis-aligned polygons onto a grid. Used for union computation.
- `traceContour(grid: boolean[][], gridSize: number, offset: Point): Point[]` — march around the boundary of filled cells, output axis-aligned polygon vertices.
- `offsetAxisAlignedPolygon(polygon: Point[], distance: number): Point[]` — expand an axis-aligned polygon outward. Each edge shifts outward by `distance`. At convex corners, edges simply meet. At concave corners (L-shape inner corner), insert an extra vertex to resolve the notch.
- `collinearOverlap(seg1: {start: Point, end: Point}, seg2: {start: Point, end: Point}, tolerance: number): {start: Point, end: Point} | null` — general segment overlap detection (angle-agnostic, ready for oblique walls).

#### Bounding box computation

The current `boundingBox()` in geometry.ts computes the SVG viewBox from wall endpoints. After this refactor, exterior walls are removed from `FloorPlan.walls`. Update `boundingBox()` to accept an optional `envelope: Point[]` parameter and include envelope vertices in the bounding box calculation. This ensures the viewBox encompasses the full structural mass.

#### svg.ts changes

New rendering approach (z-order is critical — SVG painters model, later elements occlude earlier):
```
1. Draw envelope polygon as filled #333 (structural mass) — bottommost layer
2. Draw each room polygon as filled with room color (cutouts) — occludes envelope
3. Draw exterior opening gaps (white rectangles over envelope at opening positions)
4. Draw exterior opening symbols (window mullions, door arcs)
5. Draw interior partition walls as thin lines on top
6. Draw interior openings (doors/windows) on partition walls
7. Draw furniture, labels, dimensions on top — topmost layer
```

Replace `renderWalls()` for exterior walls with `renderStructure()` that draws the envelope. Keep `renderWalls()` for interior/divider walls only.

#### src/sketcher/html.ts changes

Mirror the svg.ts rendering changes in the browser renderer's template string. Note: the browser renderer lives at `src/sketcher/html.ts` (not `src/sketch/html.ts`).

### Backward Compatibility

**Existing sketches without envelope:** When loading a sketch that has no `envelope` field (pre-refactor), fall back to the current wall-based rendering. The renderer checks `if (plan.envelope)` and uses the new structural mass approach; otherwise renders walls as individual segments (current behavior). No migration needed — old sketches continue to render, new sketches get the improved rendering.

**Change protocol:** All existing change types work unchanged. `move_wall`/`update_wall`/`remove_wall` work for both interior and exterior walls. `add_opening`/`remove_opening`/`update_opening` work for openings on any wall. Exterior walls still exist as data objects — they're just not rendered as thick polygons. No new change types needed.

### Phase 2: Fixture Catalog + Fill Patterns

#### furniture-symbols.ts changes

Add SVG symbol cases for:
- Kitchen: `refrigerator`, `range`, `dishwasher`, `kitchen-sink`
- Bathroom: `toilet`, `bathtub`, `shower`, `bathroom-sink`
- Utility: `washer-dryer`

Each is a self-contained SVG snippet scaled to the item's width/depth.

#### Room fill differentiation

- `balcony` / `terrace` rooms: diagonal hatch SVG pattern or distinct outdoor tint
- Refined `ROOM_COLORS` palette for stronger visual identity

### CV Fix List (accumulated during testing)

A separate document will be maintained at `docs/superpowers/specs/2026-03-22-cv-fixes-needed.md` tracking every CV issue discovered during rendering work. This becomes the spec for the CV improvement phase.

## Verification Strategy

Each phase uses a generate → preview → compare loop:
1. Regenerate Shore Drive sketch from CV data
2. Preview as SVG (rasterized PNG via `preview_sketch`)
3. Compare side-by-side with source image (rasterized)
4. Fix issues, repeat until the needle has visibly moved
5. Spot-check 1-2 other test images (Unit 2C, Apt 6C) for regressions

Unit tests for new geometry functions (`rasterizeToGrid`, `traceContour`, `offsetAxisAlignedPolygon`, `collinearOverlap`) — these are pure functions with well-defined inputs/outputs.

Context transfer between phases to maintain reasoning quality.

## Test Images

- Shore Drive (primary): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`
- Unit 2C: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`
- Apt 6C: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/53c1822d-3e22-429b-8476-b8066e409534`
- Res 507: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785`

## Files Affected

| File | Phase | Change Type |
|------|-------|-------------|
| `src/sketch/compile-layout.ts` | 1 | Major refactor — envelope computation, remove exterior wall gen |
| `src/sketch/types.ts` | 1 | Add envelope field |
| `src/sketch/geometry.ts` | 1 | Add polygon union (grid-based), offset, collinear overlap |
| `src/sketch/svg.ts` | 1 | New renderStructure(), modify rendering pipeline |
| `src/sketcher/html.ts` | 1 | Mirror svg.ts envelope rendering |
| `src/sketch/compile-layout.test.ts` | 1 | Update tests for envelope, add geometry unit tests |
| `src/sketch/furniture-symbols.ts` | 2 | Add fixture SVG symbols |
| `src/sketch/defaults.ts` | 2 | Refine ROOM_COLORS |

## Non-Goals

- Diagonal/oblique wall rendering polish (miter joins) — data model ready, rendering deferred
- CV pipeline changes — separate phase, separate spec
- Full polygon boolean operations (Weiler-Atherton etc.) — grid-based rasterization is sufficient
- 3D or perspective rendering
- Undo/redo for room edge editing
- New change protocol types for room edge editing (existing `update_room` suffices)
