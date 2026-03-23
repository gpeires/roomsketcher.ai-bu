# Surgical Iteration Design — Vision-First with CV Advisory

> Design spec for replacing the current generate-from-scratch Copy Mode workflow with a vision-driven, surgically iterative approach where Claude drives room layout from what it sees, CV data is advisory, and edits are label-based single-room fixes.

## Problem Statement

The current Copy Mode workflow has three fundamental issues:

1. **Claude regenerates from scratch when something is wrong.** The existing `update_sketch` supports 14 low-level change types (by ID), but the prompting and tooling don't guide Claude toward surgical fixes. When a room is 30cm too wide, Claude rebuilds the entire layout.

2. **Claude can't compare effectively.** `preview_sketch` returns only the rendered PNG. Claude must compare against the source image from memory across separate tool calls, degrading comparison accuracy.

3. **CV data is treated as gospel.** The prompts say "CV is your source of truth" but CV detects 5 of 9 rooms on Unit 2C. Claude can read printed labels and dimensions directly from the source image — "Primary Bedroom 10'2" x 15'8"" — which is often more accurate than CV room detection.

## Design: A/B Hybrid — Vision-First with CV Advisory

### Core Principle

Claude drives room layout from its own visual understanding of the source image. CV data is advisory — like expert input that Claude evaluates, follows when it makes sense, and overrides when it can see something different.

**CV is authoritative for:**
- Scale calibration (cm/px ratio) — hard to eyeball
- Wall thickness measurements — requires pixel-level analysis
- Building outline polygon — extracted via morphological operations

**Claude is authoritative for:**
- Room identification (reads labels and counts rooms)
- Room dimensions (reads printed measurements like "10'2" x 15'8"")
- Spatial relationships (sees which rooms are adjacent)
- Openings (sees doors and windows in context)
- Furniture placement (sees furniture in context)

**When they disagree:** Claude articulates why it's overriding CV data. "CV detected 5 rooms but I can see 9 rooms labeled in the image. The CV missed the Foyer, Walk-in Closet, Laundry, and second Bathroom."

### Side-by-Side Preview

**Enhancement to `preview_sketch`:** Return the source image alongside the rendered sketch PNG when a source image exists for the sketch.

#### Implementation

Add an optional `source_image_url` field to the sketch metadata. **Data flow:** `analyze_floor_plan_image` stores the image URL in the MCP session state (`SketchSession.sourceImageUrl`). When `generate_floor_plan` creates the sketch, it reads the URL from session state and sets it in `metadata.source_image_url`. This mirrors the existing `SketchSession` pattern used for `sketchId` and `plan`.

When `preview_sketch` is called:

1. Render the sketch as PNG (existing behavior)
2. If the sketch has a `source_image_url`, fetch it and include as a second MCP image content block
3. Return both images with labels: "**Your sketch:**" and "**Source image:**"

This enables direct visual comparison in a single tool call — Claude sees both images together and can spot discrepancies without relying on memory.

#### Schema Change

```typescript
// Add to FloorPlan metadata
metadata: {
  created_at: string,
  updated_at: string,
  source: 'ai' | 'sketcher' | 'mixed',
  source_image_url?: string,  // NEW — set by analyze_floor_plan_image
}
```

#### Tool Change

```typescript
// preview_sketch input — add optional source overlay
inputSchema: {
  sketch_id: z.string(),
  include_source: z.boolean().optional().default(true)
    .describe('Include the source floor plan image for side-by-side comparison (default: true in Copy Mode)')
}
```

### High-Level Surgical Change Operations

New label-based operations that compile down to existing low-level changes. These operate on **room labels** (not IDs) and cascade automatically.

#### Design Principles

1. **Label-based addressing** — Claude thinks in "Kitchen" and "Primary Bedroom", not random IDs. The resolution layer finds the room/wall by label.
2. **Cascade automatically** — Resizing a room updates its polygon, adjusts shared walls, and recomputes affected areas.
3. **Compile to existing changes** — Each high-level op produces an array of existing low-level `Change` types. The `applyChanges()` function and WebSocket broadcast work unchanged.
4. **Additive, not replacement** — The existing 14 low-level change types remain available. High-level ops are a convenience layer on top.
5. **Separate input field** — High-level changes use a separate `high_level_changes` array in the `update_sketch` input, avoiding type name collisions with existing low-level change discriminants. The handler processes high-level changes first (compiling to low-level), then applies all low-level changes together. Only the final state is persisted and broadcast — no intermediate states.

#### Room Operations

##### `resize_room`

Expand or contract one side of a room.

```typescript
{
  type: 'resize_room',
  room: string,        // room label (e.g. "Kitchen")
  side: 'north' | 'south' | 'east' | 'west',
  delta_cm: number,    // positive = expand, negative = contract
}
```

**Compiles to:**
- `update_room` — new polygon with the specified side moved by `delta_cm`
- `move_wall` — move the wall segment on that side
- If the wall is shared with an adjacent room: `update_room` on the adjacent room (shrink/expand to match)

**Resolution logic:**
1. Find room by label → get polygon vertices
2. Identify which polygon edges form the specified side (north = edges with minimum Y, etc.)
3. For non-rectangular rooms (>4 vertices): move only the **longest** edge at the extremum. Other edges at the same extremum are left unchanged. If the room is too complex for side-based resizing, return an error suggesting direct `update_room` with an explicit polygon.
4. Move those edges by `delta_cm`
5. Find walls that overlap those edges (geometric lookup within snap tolerance)
6. Check if any of those walls are shared (another room's polygon also touches them)
7. If shared: adjust the adjacent room's polygon on the opposite side

##### `move_room`

Translate a room's position.

```typescript
{
  type: 'move_room',
  room: string,        // room label
  dx: number,          // cm, positive = right
  dy: number,          // cm, positive = down
}
```

**Compiles to:**
- `update_room` — polygon vertices all shifted by (dx, dy)
- `move_wall` — each wall belonging to this room shifted by (dx, dy)
- `move_furniture` — each furniture item in this room shifted by (dx, dy)

##### `split_room`

Divide one room into two with a new interior wall.

```typescript
{
  type: 'split_room',
  room: string,           // room label to split
  axis: 'horizontal' | 'vertical',  // direction of the dividing wall
  position_cm: number,    // offset from room's north (horizontal) or west (vertical) edge
  labels: [string, string],  // [first half label, second half label]
  types?: [RoomType, RoomType],  // optional room types
}
```

**Compiles to:**
- `remove_room` — remove the original room
- `add_room` × 2 — the two new rooms with computed polygons
- `add_wall` — the dividing interior wall

##### `merge_rooms`

Combine two adjacent rooms into one by removing their shared wall.

```typescript
{
  type: 'merge_rooms',
  rooms: [string, string],  // two room labels
  label: string,            // label for the merged room
  type?: RoomType,
}
```

**Compiles to:**
- `remove_room` × 2
- `remove_wall` — the shared wall between them
- `add_room` — merged polygon computed by combining bounding boxes when rooms share a full edge (axis-aligned merge). For rooms that don't share a full edge, return an error — arbitrary polygon boolean union is out of scope. Claude can manually construct the merged polygon and use low-level `add_room` instead.

##### `remove_room`

Remove a room by label.

```typescript
{
  type: 'remove_room',
  room: string,  // room label
}
```

**Compiles to:**
- `remove_room` — with resolved `room_id`
- `remove_wall` × N — remove walls that only belong to this room (not shared with other rooms)
- `remove_furniture` × N — remove all furniture within this room's polygon

##### `add_room`

Add a new room to the layout.

```typescript
{
  type: 'add_room',
  label: string,
  room_type: RoomType,
  rect?: { x: number, y: number, width: number, depth: number },  // simple rectangle
  polygon?: Point[],  // or explicit polygon for irregular shapes
}
```

**Compiles to:**
- `add_room` — with computed polygon (from rect or explicit polygon)
- `add_wall` × N — generate walls for each edge (classify as exterior/interior via probe)

**Note:** After adding a room, the envelope auto-recomputes on next `generate_floor_plan` or can be explicitly set via `set_envelope`.

#### Opening Operations

##### `add_door`

```typescript
{
  type: 'add_door',
  between?: [string, string],  // two room labels (interior door)
  room?: string,               // room label (exterior door, with wall_side)
  wall_side?: 'north' | 'south' | 'east' | 'west',
  position?: number,           // 0-1 along wall (0.5 = center), default 0.5
  width?: number,              // cm, default 80
  swing?: 'left' | 'right',   // default 'right'
}
```

**Validation:** Exactly one of `between` or (`room` + `wall_side`) must be provided. Use Zod `.refine()` to enforce this — reject when both are present or both are absent.

**Resolution:** Find the shared wall between the two rooms (for `between`) or the exterior wall on the specified side (for `room` + `wall_side`). Convert `position` (0-1) to `offset` (cm along the wall).

**Compiles to:** `add_opening` with the resolved `wall_id` and computed `offset`.

##### `add_window`

```typescript
{
  type: 'add_window',
  room: string,
  wall_side: 'north' | 'south' | 'east' | 'west',
  position?: number,           // 0-1 along wall, default 0.5
  width?: number,              // cm, default 120
  window_type?: 'single' | 'double' | 'sliding' | 'bay',  // default 'single'
}
```

**Compiles to:** `add_opening` with type `'window'` on the resolved wall.

##### `update_opening`

```typescript
{
  type: 'update_opening',
  room: string,
  wall_side: 'north' | 'south' | 'east' | 'west',
  index?: number,      // which opening on that wall (0-based, default 0)
  position?: number,   // new 0-1 position
  width?: number,
  swing?: 'left' | 'right',
  window_type?: 'single' | 'double' | 'sliding' | 'bay',
}
```

**Compiles to:** `update_opening` on the resolved wall and opening.

##### `remove_opening`

```typescript
{
  type: 'remove_opening',
  room: string,
  wall_side: 'north' | 'south' | 'east' | 'west',
  index?: number,  // default 0
}
```

**Compiles to:** `remove_opening` with resolved IDs.

#### Furniture Operations

##### `place_furniture`

```typescript
{
  type: 'place_furniture',
  furniture_type: string,    // catalog type (e.g. "sofa-3seat", "bed-double")
  room: string,              // room label
  position: 'center' | 'north' | 'south' | 'east' | 'west' | 'ne' | 'nw' | 'se' | 'sw' | { x: number, y: number },
  rotation?: number,         // degrees, default 0
  width?: number,            // override catalog default
  depth?: number,            // override catalog default
}
```

**Resolution:** Named positions resolve to coordinates relative to the room's bounding box:
- `center` → room centroid
- `north` → centered on north wall, offset by furniture depth/2 + clearance
- `sw` → southwest corner, offset by clearance on both axes
- `{ x, y }` → explicit coordinates relative to room origin (top-left of room bbox)

Absolute position is computed as `room_origin + relative_position`.

**Compiles to:** `add_furniture` with resolved absolute position and catalog dimensions.

##### `move_furniture`

```typescript
{
  type: 'move_furniture',
  furniture_type: string,    // find by type within room
  room: string,              // room label
  position: 'center' | 'north' | ... | { x: number, y: number },  // same as place_furniture
  rotation?: number,
}
```

**Resolution:** Find the furniture item by matching `type` and checking if its position falls within the room's polygon.

**Compiles to:** `move_furniture` with resolved ID and new absolute position.

##### `remove_furniture`

```typescript
{
  type: 'remove_furniture',
  furniture_type?: string,
  room?: string,
  furniture_id?: string,   // direct ID as fallback
}
```

**Compiles to:** `remove_furniture` with resolved ID.

#### Envelope & Label Operations

##### `set_envelope`

Explicit polygon override — escape hatch when auto-computed envelope is wrong.

```typescript
{
  type: 'set_envelope',
  polygon: Point[],
}
```

**Compiles to:** A new low-level `set_envelope` change type (added to `ChangeSchema`): `z.object({ type: z.literal('set_envelope'), polygon: z.array(PointSchema) })`. Handler in `applyChanges()` simply sets `plan.envelope = polygon`. This keeps all mutations flowing through the same pipeline and ensures WebSocket broadcasts include the change.

##### `rename_room`

Already exists as a low-level change type. Exposed at the high-level with label-based addressing:

```typescript
{
  type: 'rename_room',
  room: string,       // current label
  new_label: string,
  new_type?: RoomType,
}
```

**Compiles to:** `rename_room` with resolved `room_id`.

##### `retype_room`

Change room type without changing label.

```typescript
{
  type: 'retype_room',
  room: string,
  new_type: RoomType,
}
```

**Compiles to:** `rename_room` with the same label but new type (triggers color update).

### Resolution Layer

A new module `src/sketch/resolve.ts` that translates label-based references to IDs and geometric lookups.

#### Core Functions

```typescript
// Find a room by label (case-insensitive match)
// Throws descriptive error listing available labels if not found
findRoomByLabel(plan: FloorPlan, label: string): Room

// Find walls belonging to a room (geometric lookup)
findRoomWalls(plan: FloorPlan, room: Room): Wall[]

// Find the wall on a specific side of a room
findRoomWallOnSide(plan: FloorPlan, room: Room, side: 'north'|'south'|'east'|'west'): Wall | null

// Find the shared wall between two rooms
findSharedWall(plan: FloorPlan, roomA: Room, roomB: Room): Wall | null

// Find furniture items within a room's polygon
findFurnitureInRoom(plan: FloorPlan, room: Room, type?: string): FurnitureItem[]

// Convert a relative position name to absolute coordinates
resolvePosition(room: Room, position: string | {x: number, y: number}, itemWidth: number, itemDepth: number): Point
```

#### Wall-to-Room Association

Since `room.wall_ids` is never populated, the resolution layer uses geometric lookup:

1. For each wall, compute the wall segment (start→end)
2. For each room polygon edge, check if the wall segment overlaps (within `SNAP_TOLERANCE` of 20cm and ≥10cm overlap along the parallel axis)
3. Cache the associations per high-level change — invalidate after each change since wall positions may have shifted

This mirrors the logic already in `findSharedEdges()` in `compile-layout.ts`.

### High-Level Change Processor

A new module `src/sketch/high-level-changes.ts`:

```typescript
import { FloorPlan, Change } from './types';

type HighLevelChange = ResizeRoom | MoveRoom | SplitRoom | MergeRooms | RemoveRoomHL | AddRoomHL
  | AddDoor | AddWindow | UpdateOpeningHL | RemoveOpeningHL
  | PlaceFurniture | MoveFurnitureHL | RemoveFurnitureHL
  | SetEnvelope | RenameRoomHL | RetypeRoom;

// Compile a high-level change into low-level changes — throws on resolution failure
function compileHighLevelChange(plan: FloorPlan, change: HighLevelChange): Change[]

// Process high-level + low-level changes into a final FloorPlan
function processChanges(
  plan: FloorPlan,
  highLevelChanges: HighLevelChange[],
  lowLevelChanges: Change[]
): FloorPlan
```

`processChanges`:
1. Iterates through `highLevelChanges` sequentially, compiling each against the current plan state (each sees the result of previous changes)
2. Concatenates the compiled low-level changes with the explicit `lowLevelChanges`
3. Applies all via `applyChanges`
4. Returns the final plan

**Error handling:** If `compileHighLevelChange` throws (e.g., room label not found), the entire batch fails and returns a descriptive error message listing available room labels. No partial application — changes are atomic.

### Updated `update_sketch` Tool

The tool uses **separate arrays** for low-level and high-level changes, avoiding type name collisions in the discriminated union:

```typescript
inputSchema: {
  sketch_id: z.string(),
  changes: z.array(ChangeSchema).optional()
    .describe('Low-level changes (by ID) — existing 14 change types'),
  high_level_changes: z.array(HighLevelChangeSchema).optional()
    .describe('High-level changes (by label) — surgical room/opening/furniture operations'),
}
// .refine(): at least one of changes or high_level_changes must be provided
```

The handler calls `processChanges` which:
1. Compiles `high_level_changes` to low-level changes (sequentially, each seeing the result of the previous)
2. Concatenates with any explicit `changes`
3. Applies all via `applyChanges`
4. Recomputes `canvas.width` / `canvas.height` from bounding box + padding (rooms may have moved beyond current canvas bounds)
5. Persists and broadcasts the final state only — no intermediate states

---

## Prompting Philosophy

The tooling enables surgical iteration, but the **prompting is what makes Claude actually do it**. This section defines the prompting changes needed across tool descriptions and the Copy Mode workflow.

### Structured Visual Comparison Protocol

When Claude calls `preview_sketch` and receives the side-by-side images, it must follow a structured comparison — not a vague "looks good" or "looks different."

**The protocol (embedded in `preview_sketch` description):**

```
COMPARISON PROTOCOL — follow this EVERY time you see the preview alongside the source:

1. COUNT ROOMS: How many rooms are in the source? How many in your sketch? List any missing or extra rooms.

2. ROOM-BY-ROOM CHECK (for each room visible in the source):
   - Is it present in the sketch? Same label?
   - Is it roughly the right SIZE? (compare width/height proportions)
   - Is it in the right POSITION relative to its neighbors?
   - Is the SHAPE correct? (rectangular vs L-shaped vs irregular)

3. OPENINGS CHECK: Are doors between the right rooms? Are windows on the right walls?

4. OVERALL SHAPE: Does the building outline match the source perimeter?

5. DECISION: List specific fixes needed. Each fix should be a single surgical change
   (e.g., "Kitchen is ~30cm too narrow on the east side" → resize_room).
   Do NOT regenerate — fix one thing at a time.
```

### Surgical Iteration Guidance

Embedded in `update_sketch` description:

```
ITERATION PHILOSOPHY: Fix ONE thing at a time. After each fix, preview to verify it worked
and didn't break adjacent rooms. Never regenerate the entire layout to fix a single room.

GOOD: "The Kitchen is 30cm too narrow on the east side" → resize_room Kitchen east +30
BAD: "The layout doesn't look right" → regenerate everything from scratch

Each iteration should be:
1. Identify the SINGLE biggest discrepancy between sketch and source
2. Apply the MINIMAL change to fix it (resize, move, split, or add one room)
3. Preview to verify
4. Repeat until the sketch matches the source
```

### CV-as-Advisory Framing

Embedded in `analyze_floor_plan_image` description:

```
CV DATA IS ADVISORY: The CV pipeline provides measured geometry (scale, wall thickness,
room coordinates) extracted by computer vision. Use it as expert input, but YOU are the
authority on what rooms exist and how they're arranged.

TRUST CV FOR: scale (cm/px), wall thickness, building outline polygon
TRUST YOUR EYES FOR: room count, room labels, printed dimensions, spatial relationships

When CV and your visual understanding disagree:
- State what CV says vs. what you see
- Explain why you're following your interpretation
- Example: "CV detected 5 rooms but I can see 9 labeled rooms in the image.
  I'll use the CV scale factor but place all 9 rooms based on the printed dimensions."
```

### Architectural Irregularity Respect

Embedded in `generate_floor_plan` Copy Mode instructions:

```
PRESERVE ARCHITECTURAL DETAILS: Real apartments have:
- Walls that jut out slightly to accentuate windows
- Structural setbacks and columns
- Non-rectangular foyers and hallways
- Rooms that aren't perfect rectangles

A slightly irregular room polygon that matches the source is BETTER than a clean
rectangle that doesn't. Do NOT simplify room shapes to make them "cleaner."
Use polygon input (not just rect) when rooms aren't rectangular.
```

### Updated Copy Mode Workflow

The complete revised workflow for `generate_floor_plan` Copy Mode:

```
═══ COPY MODE (user provided a reference floor plan image) ═══
Your job is REPLICATION. Use the ROOM-FIRST INPUT FORMAT.

PHASE 1 — ANALYZE AND BUILD SKELETON:

Step 1: ANALYZE — Call analyze_floor_plan_image with the image URL.
  - Read the CV output but also look at the source image yourself
  - Count every room you can see (labels, dimensions, spatial position)
  - Note any rooms the CV missed — you'll add those manually
  - Trust CV for: scale, wall thickness, building outline
  - Trust your eyes for: room count, labels, printed dimensions

Step 1b: EVALUATE OUTLINE — Check outline vertex count vs building shape.
  If over-detailed, re-call with higher outline_epsilon.

Step 2: BUILD ALL ROOMS — Call generate_floor_plan with ALL rooms you can identify.
  - Start with CV-detected rooms (use their coordinates and sizes)
  - ADD rooms the CV missed — read their labels and dimensions from the image
  - Convert imperial dimensions to cm (1' = 30.48cm)
  - Position rooms relative to each other based on what you see
  - Add basic exterior doors/windows. No furniture yet.

Step 3: PREVIEW AND COMPARE — Call preview_sketch immediately.
  Follow the COMPARISON PROTOCOL (see preview_sketch description).
  List every discrepancy you find.

PHASE 2 — SURGICAL ITERATION:

Step 4: FIX ONE THING AT A TIME — For each discrepancy from Step 3:
  - Use the high-level surgical operations (resize_room, move_room, split_room, etc.)
  - Apply ONE fix, then preview again
  - Verify the fix worked and nothing else broke
  - Repeat until the sketch matches the source

Step 5: ADD OPENINGS — Use add_door and add_window with room labels.
  Interior doors: {type: "add_door", between: ["Kitchen", "Living Room"]}
  Exterior windows: {type: "add_window", room: "Bedroom", wall_side: "south"}
  Preview to verify placement.

Step 6: ADD FURNITURE — Use place_furniture with room-relative positions.
  {type: "place_furniture", furniture_type: "bed-double", room: "Primary Bedroom", position: "north"}
  Preview to verify.

COORDINATE SYSTEM: Origin (0,0) top-left. X right, Y down. All values in cm. 10cm grid.
```

---

## Implementation Areas

### New Files
- `src/sketch/resolve.ts` — Label→ID resolution, wall-to-room geometric lookup, position resolution
- `src/sketch/high-level-changes.ts` — High-level change types, Zod schemas (`HighLevelChangeSchema`), compiler to low-level changes, `processChanges`

### Modified Files
- `src/sketch/types.ts` — Add `source_image_url` to metadata schema, add `set_envelope` to `ChangeSchema`
- `src/index.ts` — Update tool descriptions (generate_floor_plan, analyze_floor_plan_image, update_sketch, preview_sketch), add `high_level_changes` input to `update_sketch`, update `preview_sketch` to accept `include_source`
- `src/sketch/tools.ts` — Update `handlePreviewSketch` to fetch and return source image, update `handleAnalyzeImage` to store `source_image_url` in session state, update `handleUpdateSketch` to use `processChanges`, update `handleGenerateFloorPlan` to read `source_image_url` from session state
- `src/sketch/changes.ts` — Add `set_envelope` handler to `applyChanges()`
- `src/sketch/compile-layout.ts` — No changes (used by generate_floor_plan, not by surgical edits)
- `src/types.ts` — Add `sourceImageUrl?: string` to `SketchSession`

### Unchanged Infrastructure
- `applyChanges()` — The immutable change applicator works as-is
- `compile-layout.ts` — Used by `generate_floor_plan` for initial sketch creation, not by surgical edits
- WebSocket protocol — `processChanges` produces the same `FloorPlan` object, broadcast works unchanged
- Browser SPA — Receives the same `state_update` messages
- CV service — No changes needed
- D1 schema — `source_image_url` stored in the sketch JSON blob (metadata field), no schema migration needed

### Test Strategy

1. **Unit tests for `resolve.ts`** — Label lookup, wall-to-room association, position resolution
2. **Unit tests for `high-level-changes.ts`** — Each high-level op compiles correctly to low-level changes
3. **Integration tests** — Apply high-level changes to template sketches, verify resulting FloorPlan
4. **Visual validation** — Run the full Copy Mode workflow on all 4 test images:
   - Unit 2C (primary — 9 rooms, hardest)
   - Shore Drive (L-shaped)
   - Res 507 (luxury)
   - Apt 6C (known scale issue)

   Each must be visually verified by previewing the result against the source.

---

## Sequence Diagram — Copy Mode with Surgical Iteration

```
User: "Copy this floor plan" + image URL
  │
  ▼
Claude: analyze_floor_plan_image(image_url)
  │  Returns: source image + CV JSON (rooms, scale, outline, spatial grid)
  │
  ▼
Claude: [reads CV output, counts rooms in source image, notes discrepancies]
  │  "CV found 5 rooms, I can see 9. I'll use CV scale but add 4 missing rooms."
  │
  ▼
Claude: generate_floor_plan(all 9 rooms + openings)
  │  Returns: sketch_id + initial render
  │
  ▼
Claude: preview_sketch(sketch_id)  ← returns sketch + source side-by-side
  │
  ▼
Claude: [COMPARISON PROTOCOL]
  │  "Room count: 9/9 ✓
  │   Kitchen: too narrow by ~40cm on east side
  │   Foyer: missing, needs to be added between Entry and Living Room
  │   Primary Bedroom: position OK, size OK"
  │
  ▼
Claude: update_sketch(sketch_id, high_level_changes: [{type: "resize_room", room: "Kitchen", side: "east", delta_cm: 40}])
  │
  ▼
Claude: preview_sketch(sketch_id)  ← verify Kitchen fix
  │  "Kitchen: ✓ fixed. Foyer still missing."
  │
  ▼
Claude: update_sketch(sketch_id, high_level_changes: [{type: "add_room", label: "Foyer", room_type: "hallway", rect: {...}}])
  │
  ▼
Claude: preview_sketch(sketch_id)  ← verify Foyer addition
  │  "Foyer: ✓ added. All rooms present and sized correctly."
  │
  ▼
Claude: update_sketch(sketch_id, high_level_changes: [
  │  {type: "add_door", between: ["Foyer", "Living Room"]},
  │  {type: "add_window", room: "Primary Bedroom", wall_side: "south"},
  │  ...
  │])
  │
  ▼
Claude: preview_sketch(sketch_id)  ← verify openings
  │
  ▼
Claude: update_sketch(sketch_id, high_level_changes: [
  │  {type: "place_furniture", furniture_type: "bed-double", room: "Primary Bedroom", position: "north"},
  │  ...
  │])
  │
  ▼
Claude: preview_sketch(sketch_id)  ← final verification
  │  "All rooms match source. Openings correct. Furniture placed."
  │
  ▼
Claude: "Here's your floor plan! [link to sketcher]"
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Label ambiguity (two rooms with same label) | Resolution fails | `findRoomByLabel` returns error with available labels; Claude disambiguates |
| Wall-to-room geometric lookup misses walls | Resize/move cascades incorrectly | Use generous snap tolerance (20cm, matching existing `SNAP_TOLERANCE`); fall back to bounding box edges |
| High-level ops produce inconsistent state | Broken sketch | Each op is atomic — if compilation fails, no changes applied; unit tests cover edge cases |
| Side-by-side preview doubles image data | Slower tool responses | Source image is fetched once and cached in sketch metadata; skip if `include_source: false` |
| Agent reasoning time increases with protocol | Slower iteration cycles | Protocol is structured to minimize reasoning — enumerate rooms, check each one, decide. No open-ended analysis |
| Prompt length increases | Tool description token budget | Prompts are precise and actionable, not verbose. Each section serves a specific purpose |

---

## Success Criteria

1. **Unit 2C reproduces all 9 rooms** — labeled correctly, positioned within ~50cm of source, correct relative sizes
2. **Iteration is surgical** — Claude uses resize/move/add operations, not regeneration, after initial generate
3. **Side-by-side comparison works** — Claude follows the comparison protocol and identifies specific discrepancies
4. **CV overrides are reasoned** — When Claude adds rooms CV missed, it states why
5. **Shore Drive L-shape is preserved** — Envelope matches the irregular perimeter, not a bounding rectangle
6. **All 4 test images produce acceptable sketches** — Visual verification by human review
