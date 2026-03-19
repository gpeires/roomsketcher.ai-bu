# Full Floor Plan Editor — Phase 1: Structural Editing

## Context

The RoomSketcher AI Sketcher currently has basic editing: click-click wall drawing, door/window insertion, element selection with properties panel, pan/zoom, and mobile bottom sheet. But it lacks direct manipulation — users can't drag wall endpoints to resize rooms, can't reposition furniture by dragging, and the filter tabs don't work. The primary audience is **humans** (standalone editor, not just an AI preview tool), which sets a high bar for interaction quality and responsiveness. Phase 1 focuses on the structural foundation: wall/room editing with full CAD-style interaction.

## Scope — Phase 1

### In Scope
- Wall endpoint dragging with connected wall auto-follow
- Full CAD snapping (grid, endpoint, alignment, midpoint, perpendicular)
- Unified toolbar (tools + filters merged into one row)
- Undo/redo system
- Full numeric input in properties panel (length, angle, coordinates)
- Filter/highlight behavior per tool mode
- Furniture rotation handle (lollipop) + properties
- Mobile: tap-to-select then drag handles, numeric input fallback
- Full CRUD for walls and openings (doors/windows)
- Remove Save button (auto-save via WebSocket is sufficient)

### Out of Scope (Phase 2+)
- Furniture drag-to-reposition
- Furniture catalog/picker UI
- Room polygon auto-computation from walls
- Two-finger wall rotation gesture
- Push notifications from browser edits to MCP agent
- Multi-select / group operations
- Copy/paste

## Two-Way Sync (existing)

The architecture already supports real-time sync:
- **MCP → Browser**: `update_sketch` broadcasts via SketchSync Durable Object → WebSocket to all browser clients ✓
- **Browser → Browser**: WebSocket broadcast to all connected clients ✓
- **Browser → MCP**: Agent calls `get_sketch` to read latest state (pull, not push) ✓

No sync changes needed for Phase 1.

---

## 1. Unified Toolbar

### Layout

```
Desktop:
[Select] [Wall] [Door] [Window] [Room] [Furniture] ··· spacer ··· [↶] [↷] | [↓ SVG]

Mobile bottom sheet (collapsed — scrollable row):
[Select] [Wall] [Door] [Window] [Room] [Furniture] | [↶] [↷] [↓ SVG]
```

### Button Behavior

Each button sets **both** the active tool and the visual filter:

| Button    | Tool Mode                    | Visual Filter                          | Key |
|-----------|------------------------------|----------------------------------------|-----|
| Select    | Select & drag any element    | All elements full opacity              | S   |
| Wall      | Click-click to draw walls    | Walls highlighted, rest dimmed (20%)   | W   |
| Door      | Click wall to place door     | Doors + parent walls highlighted       | D   |
| Window    | Click wall to place window   | Windows + parent walls highlighted     |     |
| Room      | Click to label room          | Rooms highlighted, rest dimmed         | R   |
| Furniture | Select mode (furniture only) | Furniture highlighted, rest dimmed     | F   |

Dimmed elements get `opacity: 0.2` and `pointer-events: none`. Grid and dimensions always render normally.

### Removed
- **Save button** — removed. All changes auto-save via WebSocket.
- **Separate filter tab row** — merged into tool buttons.

---

## 2. Interaction State Machine

Replace ad-hoc `tool` + `isPanning` with a proper state machine.

### States

```
idle                → waiting for input
selecting           → mousedown on element, <3px movement (click vs drag detection)
dragging_endpoint   → actively dragging a wall endpoint
drawing_wall        → click-click wall drawing mode
panning             → canvas pan in progress
placing_opening     → click-on-wall to place door/window
```

### State Variables

```js
let interactionMode = 'idle';
let dragState = null;       // { wallId, endpoint, originPoint, connectedWalls, originalPositions }
let snapResult = null;      // { point, guides[] }
let undoStack = [];         // { changes[], inverseChanges[] }
let redoStack = [];
```

### Mouse Flow (Desktop)

```
mousedown:
  on endpoint handle  → mode = 'selecting', record start position
  on wall/room/furn   → select element, show properties
  on empty canvas     → mode = 'panning'

mousemove (while selecting, >3px):
  → mode = 'dragging_endpoint'
  → compute snap, move endpoint + connected walls
  → direct DOM updates (setAttribute) for performance
  → render snap guides

mouseup:
  if dragging → commit changes, push to undo stack, full render()
  if selecting (<3px) → was a click, select the wall
  if panning → stop pan
```

### Touch Flow (Mobile)

```
tap on wall       → select wall, show handles + expand sheet
tap on handle     → begin endpoint drag (sheet collapses for canvas space)
touchmove         → update endpoint with snap, direct DOM updates
touchend          → commit changes, sheet re-expands with updated values
tap on empty      → deselect, collapse sheet
```

---

## 3. Wall Endpoint Dragging

### Drag Handles

When a wall is selected, render teal circles at both endpoints:

```
Desktop: r=8 SVG units
Mobile:  r=14 SVG units (≈28px+ touch target)
```

Rendered in a `<g id="drag-handles">` group on top of all other elements.

### Connected Wall Detection

```js
function findConnectedEndpoints(wallId, endpoint) {
  // Find all walls sharing this exact point (within 1cm threshold)
  // Returns: [{ wallId, endpoint: 'start'|'end' }]
}
```

Built on each drag start. Linear scan is fine for typical floor plans (< 100 walls).

### During Drag

- Move the dragged endpoint to snapped position
- Move all connected wall endpoints to the same position
- **Alt/Option held**: skip connected walls (detach mode)
- Update room polygons: any polygon vertex within 2cm of the old point moves to the new point
- Direct DOM updates via `setAttribute` on `<line>` and `<circle>` elements (no full innerHTML rebuild)
- WebSocket broadcasts throttled to 10fps during drag

### On Release

- Commit `move_wall` changes for all affected walls (batched as single undo step)
- Commit `update_room` changes for affected room polygons
- Full `render()` to reconcile all visual elements
- Send final state over WebSocket

### New Change Type

Add `update_room` to `src/sketch/types.ts` ChangeSchema:

```ts
z.object({
  type: z.literal('update_room'),
  room_id: z.string(),
  polygon: z.array(PointSchema).optional(),
  area: z.number().optional()
})
```

Handle in `src/sketch/changes.ts` and client-side `applyChangeLocal`.

---

## 4. CAD Snap System

### Priority (highest wins)

| # | Snap Type      | Threshold | Visual Feedback                        |
|---|----------------|-----------|----------------------------------------|
| 1 | Endpoint       | 15px      | Filled red circle at snap target       |
| 2 | Perpendicular  | 10px      | Right-angle symbol (⊾)                 |
| 3 | Alignment      | 10px      | Dashed teal guide lines (H/V)         |
| 4 | Midpoint       | 10px      | Diamond marker at wall midpoint        |
| 5 | Grid           | always    | None (grid itself is the guide)        |

### Algorithm

```js
function computeSnap(rawPoint, excludeWallIds) → { point, guides[] }
```

1. Check all wall endpoints (excluding dragged walls) — if within 15px, snap to it
2. Check if position creates 90° with any connected wall — if within 10px of perpendicular foot, snap
3. Check X/Y alignment with all endpoints — if within 10px, align on that axis
4. Check midpoints of all walls — if within 10px, snap to midpoint
5. Fallback: round to nearest 10cm grid

### Snap Guides Rendering

Rendered as SVG overlay in `<g id="snap-guides">`, cleared and redrawn each mousemove frame during drag. Not part of the main `render()` cycle — appended/removed directly.

---

## 5. Properties Panel

### Wall Properties (enhanced)

```
Type:        [select: Exterior / Interior / Divider]
Thickness:   [number input, cm]
Length:       [number input, meters]  ← NEW (editable)
Angle:       [number input, degrees] ← NEW (editable)
Start X/Y:   [number inputs, cm]     ← NEW (editable)
End X/Y:     [number inputs, cm]     ← NEW (editable)
Openings:    [list with individual ✕ delete buttons] ← NEW
[Delete Wall]
```

### Editing Behavior

- **Length change**: preserves start point and angle, adjusts end point
- **Angle change**: preserves start point and length, rotates end point
- **Coordinate change**: moves endpoint, updates connected walls and room polygons (same code path as dragging)
- All inputs commit on Enter or blur (not every keystroke)
- Two-way: drag updates fields, field edits update SVG

### Furniture Properties (enhanced for rotation)

```
Type:        [read-only]
Size:        [read-only, W × D cm]
Position:    [X, Y number inputs]    ← NEW (editable)
Rotation:    [number input, degrees] ← NEW (editable)
[Delete]
```

---

## 6. Furniture Rotation Handle

When furniture is selected, render a "lollipop" rotation handle:
- Small circle (r=6 desktop, r=12 mobile) offset above the selection bounding box
- Connected to the item center by a thin line
- Drag the handle in an arc to rotate
- Snap to 0°/45°/90°/135°/180° etc. (15° increments) unless free-drag

This is render-only in Phase 1 — full furniture drag-to-reposition is Phase 2.

---

## 7. Undo/Redo System

### Architecture

```js
let undoStack = [];  // [{ changes[], inverseChanges[] }, ...]
let redoStack = [];
const MAX_UNDO = 50;
```

Every user action (single change or batched drag) pushes one entry. Each entry contains the original changes AND their inverses.

### Inverse Change Map

| Change          | Inverse                              |
|-----------------|--------------------------------------|
| add_wall        | remove_wall                          |
| remove_wall     | add_wall (with saved wall data)      |
| move_wall       | move_wall (with original positions)  |
| update_wall     | update_wall (with original values)   |
| add_opening     | remove_opening                       |
| remove_opening  | add_opening (with saved data)        |
| add_room        | remove_room                          |
| remove_room     | add_room (with saved room data)      |
| rename_room     | rename_room (with original values)   |
| update_room     | update_room (with original polygon)  |
| add_furniture   | remove_furniture                     |
| move_furniture  | move_furniture (original pos/rot)    |
| remove_furniture| add_furniture (with saved data)      |

### Batch Undo

A single drag operation that moves 3 connected walls + 2 room polygons = **1 undo step** (not 5). The undo stack groups all changes from a single user gesture.

### Keyboard Shortcuts

- **⌘Z / Ctrl+Z**: Undo
- **⌘⇧Z / Ctrl+⇧Z**: Redo

### Toolbar Buttons

- Undo button grayed out when stack empty
- Redo button grayed out when stack empty
- New change clears redo stack

---

## 8. Drag Performance Optimization

Full `render()` rebuilds SVG innerHTML — fine for clicks but too slow for 60fps drag.

### During Drag

1. Set `isDragging = true` — `render()` returns early
2. Direct DOM updates via `setAttribute()` on:
   - Dragged wall `<line>` x1/y1/x2/y2
   - Connected wall `<line>` endpoints
   - Drag handle `<circle>` cx/cy
   - Snap guide `<line>` elements in overlay group
3. Throttle WebSocket sends to 10fps

### On Drag End

1. Set `isDragging = false`
2. Full `render()` to reconcile everything (rooms, furniture, dimensions, etc.)
3. Send final definitive state over WebSocket

---

## 9. Mobile-Specific Design

### Bottom Sheet Layout (revised)

```
[handle bar]
[Select] [Wall] [Door] [Window] [Room] [Furniture] | [↶] [↷] [↓ SVG]  ← scrollable row
[properties panel when element selected]                                  ← shown when expanded
```

- No separate Save/Download row — unified into tool row
- Filter pills removed — tool buttons serve as filters
- Properties panel uses compact two-column layout for coordinates

### Touch Drag Handles

- 28px+ touch targets (r=14 in SVG units)
- Teal fill with slight transparency + teal stroke
- Only shown when a wall is selected (not in draw mode)
- Sheet collapses during drag to maximize canvas; re-expands on release

### Properties as Precision Fallback

The bottom sheet properties panel is the primary editing interface for mobile when fingers are too imprecise. Users can type exact values for wall length, angle, and coordinates.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/sketcher/html.ts` | All UI changes: interaction state machine, drag system, snap system, toolbar, properties, undo/redo, filter rendering, mobile updates |
| `src/sketch/types.ts` | Add `update_room` change type to ChangeSchema |
| `src/sketch/changes.ts` | Handle `update_room` in `applyChanges()` |

---

## Sub-Phases

### Phase 1a: Foundation
- Refactor JS into sectioned architecture (state machine, separated render functions)
- Unified toolbar (remove Save, merge tools+filters, add undo/redo buttons)
- Drag handles rendering for selected walls
- Desktop endpoint dragging (single wall, grid snap only)
- Properties panel with editable length, angle, coordinates

### Phase 1b: Connected Walls + Full Snap
- Connected wall auto-follow during drag
- Alt/Option detach modifier
- Full snap system (endpoint, alignment, perpendicular, midpoint, grid)
- Snap guide line rendering
- Room polygon propagation on endpoint move
- Add `update_room` change type
- Batch change support for multi-wall updates

### Phase 1c: Undo/Redo + Filter Behavior
- Undo/redo stack with inverse changes
- Batch undo for grouped operations
- ⌘Z / ⌘⇧Z keyboard shortcuts
- Visual filter dimming per active tool
- Furniture rotation handle

### Phase 1d: Mobile + Polish
- Mobile drag handles (enlarged touch targets)
- Mobile touch drag flow (handle detection, drag, commit)
- Sheet collapse during drag, re-expand on release
- Opening CRUD polish (full properties editing)
- Edge cases: drag beyond canvas, very short walls, overlapping endpoints

---

## Verification

1. **Build**: `npx wrangler deploy --dry-run` — confirm bundle builds, check size < 3MB
2. **Desktop drag test**: Select wall → drag endpoint → verify connected walls follow → verify room polygon updates → verify snap guides appear → verify undo reverses
3. **Mobile drag test**: Tap wall → verify handles appear → drag handle → verify movement → verify properties update → verify numeric input works as fallback
4. **Filter test**: Click each tool button → verify correct elements highlight/dim → verify dimmed elements are not clickable
5. **Undo test**: Make several changes → undo each → verify state reverts correctly → redo → verify state re-applies
6. **WebSocket test**: Open two browser tabs → edit in one → verify other updates in real-time
7. **MCP test**: Generate a floor plan via MCP → open in browser → edit walls → call `get_sketch` from MCP → verify changes visible
8. **Properties test**: Select wall → type new length → verify wall resizes → type new angle → verify wall rotates → type coordinates → verify endpoint moves
