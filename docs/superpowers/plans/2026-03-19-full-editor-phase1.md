# Full Floor Plan Editor — Phase 1: Structural Editing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the AI Sketcher from a preview tool into a real floor plan editor with wall endpoint dragging, CAD snapping, undo/redo, unified toolbar, and full numeric properties — for both desktop and mobile.

**Architecture:** All client-side code lives in a single inline `<script>` inside `src/sketcher/html.ts` (vanilla JS, no framework). Server-side change handling is in `src/sketch/types.ts` + `src/sketch/changes.ts`. Real-time sync via WebSocket through SketchSync Durable Object already works — no sync changes needed.

**Tech Stack:** Vanilla JS (ES5-compatible in template string), SVG for rendering, Zod schemas (server), Vitest (tests), Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-19-full-editor-phase1-design.md`

---

## CRITICAL: Read Before Implementing

### Template String Constraints

`src/sketcher/html.ts` exports a function `sketcherHtml(sketchId: string)` that returns a **TypeScript template literal** (backtick string). The entire HTML document including `<style>` and `<script>` is inside this template literal. This means:

1. **Use `var` not `let`/`const`** — the existing JS uses `var` throughout and `function` declarations (ES5 style inside an IIFE `(function() { 'use strict'; ... })();`). Follow this pattern.
2. **No backticks** in the JS code — they'd terminate the template literal. Use single or double quotes only.
3. **Escape `${`** — any literal `${` in the JS would be interpreted as a template expression. The existing code avoids this naturally by using string concatenation (`'...' + variable + '...'`).
4. **Unicode escapes** — the existing code uses `\\u00B2` for ² (square meter symbol). Use HTML entities (`&deg;`, `&times;`) or `\\u00B0` for special characters.
5. **The only template expression** is `${sketchId}` (line ~234) and `${JSON.stringify(furnitureDefsBlock())}` (line ~206). Everything else is raw strings.

### Codebase Conventions

- **`var` everywhere** in the inline JS. No `let`, `const`, or arrow functions.
- **`function` declarations**, not function expressions: `function foo() {}` not `var foo = function() {}`
- **String concatenation** for HTML building: `'<div>' + value + '</div>'`
- **Helper function** `escHtml(s)` exists for HTML escaping (search for `function escHtml`)
- **`isMobile()`** function exists and returns true for `max-width: 768px`

### How to Find Code Locations

Line numbers WILL drift after each task. Always locate code by searching for unique strings:

| What | Search For |
|------|-----------|
| State variables block | `// --- State ---` |
| render() function | `function render()` |
| Properties rendering | `function renderPropertiesHtml()` |
| Properties event handlers | `function attachPropertiesHandlers()` |
| Show properties | `function showProperties()` |
| Apply change locally | `function applyChangeLocal(change)` |
| Send change to server/WS | `function sendChange(change)` |
| SVG coordinate conversion | `function svgPoint(e)` |
| Endpoint snap (wall drawing) | `function snapToEndpoint(pt)` |
| Wall click drawing | `svg.addEventListener('click', function(e)` + `if (tool !== 'wall')` |
| Guide line rendering | `function removeGuide()` |
| Desktop pan mousedown | `svg.addEventListener('mousedown', function(e)` + `if (tool === 'select'` |
| Desktop pan mousemove | `if (isPanning)` |
| Touch handlers IIFE | `(function initTouchHandlers()` |
| Tool buttons setup | `var toolButtons = {` |
| Save button handler | `document.getElementById('btn-save')` |
| Mobile save handler | `document.getElementById('mobile-save')` |
| Keyboard shortcuts | `document.addEventListener('keydown'` |
| Mobile tools update | `function updateMobileTools()` |
| Opening placement | `function addOpeningToWall(` |
| Compute area (client) | `function computeArea(polygon)` |
| Desktop toolbar HTML | `<div class="toolbar">` |
| Mobile bottom sheet HTML | `<div class="bottom-sheet` |
| Sheet actions HTML | `<div class="sheet-actions">` |

### Area Calculation: Server vs Client

**Server** (`src/sketch/geometry.ts`): `shoelaceArea()` returns m² (divides cm² by 10000).
**Client** (`html.ts`): `computeArea()` also returns m² (divides by 10000 — see `Math.abs(sum) / 2 / 10000`).

Both return m². When updating room area on the client, use `computeArea(polygon)` directly.

### sendChange Behavior Shift

`sendChange()` is the main function for applying + broadcasting changes. Before Task 9, it does NOT push to the undo stack. After Task 9, it does. This means:
- Tasks 2-8: changes made via property panel edits won't be undoable (expected — undo isn't wired up yet)
- Task 4: drag operations use `pushUndo()` directly (bypassing `sendChange`)
- Task 9: `sendChange` is updated to compute inverse + push undo for all future calls

### Data Attribute ↔ JS Dataset Mapping

HTML attributes with dashes map to camelCase in JS:
- `data-wall-id="w1"` → `element.dataset.wallId` → `"w1"`
- `data-endpoint="start"` → `element.dataset.endpoint` → `"start"`
- `data-furniture-id="f1"` → `element.dataset.furnitureId` → `"f1"`
- `data-remove-opening="d1"` → `element.dataset.removeOpening` → `"d1"`

### WebSocket Protocol

`ClientMessage` type in `src/sketch/types.ts` is a union of `Change | { type: 'save' } | { type: 'load' }`. Since `Change` is the `ChangeSchema` discriminated union, adding `update_room` to `ChangeSchema` automatically makes it a valid WebSocket message. No separate WebSocket type change needed.

---

## File Structure

| File | Responsibility | Change Type |
|------|---------------|-------------|
| `src/sketch/types.ts` | Zod schemas for FloorPlan data model + Change types | Add `update_room` to ChangeSchema |
| `src/sketch/changes.ts` | Server-side `applyChanges()` | Handle `update_room` change |
| `src/sketch/changes.test.ts` | Tests for applyChanges | Add `update_room` tests |
| `src/sketcher/html.ts` | All client-side HTML/CSS/JS (inline template string, ~991 lines) | Major: toolbar, state machine, drag, snap, undo, properties, filters, mobile |

---

## Phase 1a: Foundation

### Task 1: Add `update_room` change type (server-side)

**Files:**
- Modify: `src/sketch/types.ts` — find `ChangeSchema = z.discriminatedUnion('type', [`
- Modify: `src/sketch/changes.ts` — find `switch (change.type) {`
- Modify: `src/sketch/changes.test.ts` — add after existing tests

- [ ] **Step 1: Write failing test for `update_room` polygon change**

In `src/sketch/changes.test.ts`, add after the `it('removes a room', ...)` test:

```ts
it('updates a room polygon', () => {
  const plan = makePlan();
  const newPolygon = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 400 }, { x: 0, y: 400 }];
  const changes: Change[] = [
    { type: 'update_room', room_id: 'r1', polygon: newPolygon },
  ];
  const result = applyChanges(plan, changes);
  expect(result.rooms[0].polygon).toEqual(newPolygon);
  expect(result.rooms[0].area).toBeCloseTo(32, 0); // 800*400 cm² / 10000 = 32 m²
});

it('updates a room area only', () => {
  const plan = makePlan();
  const changes: Change[] = [
    { type: 'update_room', room_id: 'r1', area: 25.5 },
  ];
  const result = applyChanges(plan, changes);
  expect(result.rooms[0].area).toBe(25.5);
});

it('ignores update_room for nonexistent ID', () => {
  const plan = makePlan();
  const changes: Change[] = [
    { type: 'update_room', room_id: 'nonexistent', polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] },
  ];
  const result = applyChanges(plan, changes);
  expect(result.rooms).toHaveLength(1);
  expect(result.rooms[0].polygon).toHaveLength(4); // unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/changes.test.ts`
Expected: FAIL — TypeScript error, `update_room` not in ChangeSchema

- [ ] **Step 3: Add `update_room` to ChangeSchema in types.ts**

Find the `ChangeSchema` discriminated union array. Add before the closing `]);`:

```ts
z.object({ type: z.literal('update_room'), room_id: z.string(), polygon: z.array(PointSchema).optional(), area: z.number().optional() }),
```

- [ ] **Step 4: Handle `update_room` in changes.ts**

In `src/sketch/changes.ts`, find the `switch (change.type) {` block. Add a case before `case 'add_furniture':`:

```ts
case 'update_room': {
  const room = result.rooms.find(r => r.id === change.room_id);
  if (!room) break;
  if (change.polygon) {
    room.polygon = change.polygon;
    room.area = shoelaceArea(change.polygon);
  }
  if (change.area !== undefined) room.area = change.area;
  break;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sketch/changes.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/sketch/types.ts src/sketch/changes.ts src/sketch/changes.test.ts
git commit -m "feat: add update_room change type for polygon/area updates"
```

---

### Task 2: Unified toolbar — remove Save, add undo/redo buttons, add Furniture

**Files:**
- Modify: `src/sketcher/html.ts`

This task modifies HTML and CSS only. No JS logic changes (except removing dead event handler references).

**What changes:**
1. Desktop toolbar: remove Save button, add Furniture button, add undo/redo + separator before SVG export
2. Mobile bottom sheet: remove `<div class="sheet-actions">` (had Save + SVG), move SVG/undo/redo into tools row
3. CSS: remove `.btn-save` and `.sheet-actions` rules, add `.btn-icon` and `.toolbar-sep` rules
4. JS: remove `btn-save` and `mobile-save` click handlers, add `furniture` to `toolButtons` map, update `updateMobileTools()`

- [ ] **Step 1: Update desktop toolbar HTML**

Find `<div class="toolbar">` and replace the entire toolbar div through its closing `</div>` with:

```html
<div class="toolbar">
  <button id="btn-select" class="active" title="Select &amp; move (S)">Select</button>
  <button id="btn-wall" title="Draw walls (W)">Wall</button>
  <button id="btn-door" title="Add door to wall (D)">Door</button>
  <button id="btn-window" title="Add window to wall">Window</button>
  <button id="btn-room" title="Label rooms (R)">Room</button>
  <button id="btn-furniture" title="Select furniture (F)">Furniture</button>
  <div class="spacer"></div>
  <button id="btn-undo" class="btn-icon" title="Undo (&#8984;Z)" disabled>&#8630;</button>
  <button id="btn-redo" class="btn-icon" title="Redo (&#8984;&#8679;Z)" disabled>&#8631;</button>
  <div class="toolbar-sep"></div>
  <button id="btn-download" class="btn-download" title="Download SVG"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>SVG</button>
</div>
```

- [ ] **Step 2: Add CSS for new toolbar elements**

Find `.toolbar .btn-download:hover` rule. Add after it:

```css
.toolbar .btn-icon { padding: 6px 8px; font-size: 16px; color: var(--rs-gray); }
.toolbar .btn-icon:disabled { opacity: 0.3; cursor: default; }
.toolbar .btn-icon:disabled:hover { background: #fff; border-color: var(--rs-gray-light); }
.toolbar-sep { width: 1px; height: 24px; background: var(--rs-gray-light); margin: 0 4px; }
```

- [ ] **Step 3: Remove Save-related CSS**

Delete these CSS rules (search for the selectors):
- `.toolbar .btn-save { ... }` and `.toolbar .btn-save:hover { ... }`
- The entire `.sheet-actions { ... }` block
- `.sheet-actions .btn-save { ... }` and `.sheet-actions .btn-download { ... }`

- [ ] **Step 4: Update mobile bottom sheet HTML**

Find `<div class="sheet-actions">`. Remove the entire `<div class="sheet-actions">...</div>` block (contains mobile Save + SVG buttons). The `<div class="sheet-tools" id="sheet-tools"></div>` and `<div class="sheet-props" id="sheet-props"></div>` should remain — they're already there.

- [ ] **Step 5: Remove Save button JS handlers**

Find and delete:
- `document.getElementById('mobile-save').addEventListener('click', function() { save(); });`
- `document.getElementById('btn-save').addEventListener('click', save);`

- [ ] **Step 6: Update `toolButtons` map to include furniture**

Find `var toolButtons = {` and replace with:

```js
var toolButtons = { select: 'btn-select', wall: 'btn-wall', door: 'btn-door', window: 'btn-window', room: 'btn-room', furniture: 'btn-furniture' };
```

- [ ] **Step 7: Update `updateMobileTools()` function**

Find `function updateMobileTools()` and replace the entire function with:

```js
function updateMobileTools() {
  var tools = [
    { id: 'select', label: 'Select' },
    { id: 'wall', label: 'Wall' },
    { id: 'door', label: 'Door' },
    { id: 'window', label: 'Window' },
    { id: 'room', label: 'Room' },
    { id: 'furniture', label: 'Furniture' },
  ];
  var html = tools.map(function(t) {
    return '<button data-tool="' + t.id + '"' + (t.id === tool ? ' class="active"' : '') + '>' + t.label + '</button>';
  }).join('');
  html += '<div style="width:1px;height:20px;background:var(--rs-gray-light);margin:0 3px;flex-shrink:0"></div>';
  html += '<button id="mobile-undo" style="flex-shrink:0;font-size:14px;padding:4px 7px;border:1px solid var(--rs-gray-light);border-radius:6px;background:#fff;color:var(--rs-gray)" disabled>&#8630;</button>';
  html += '<button id="mobile-redo" style="flex-shrink:0;font-size:14px;padding:4px 7px;border:1px solid var(--rs-gray-light);border-radius:6px;background:#fff;color:var(--rs-gray)" disabled>&#8631;</button>';
  html += '<button id="mobile-download" style="flex-shrink:0;padding:4px 12px;font-size:11px;border:1px solid var(--rs-gold);border-radius:6px;background:var(--rs-gold);color:var(--rs-dark);font-weight:700">&#8595; SVG</button>';
  sheetToolsEl.innerHTML = html;
  sheetToolsEl.querySelectorAll('[data-tool]').forEach(function(btn) {
    btn.addEventListener('click', function() { setTool(btn.dataset.tool); });
  });
  var dlBtn = document.getElementById('mobile-download');
  if (dlBtn) dlBtn.addEventListener('click', function() { downloadPdf(); });
}
```

- [ ] **Step 8: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds, no errors

- [ ] **Step 9: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: unified toolbar — remove Save, add undo/redo buttons, add Furniture"
```

---

### Task 3: Interaction state machine

**Files:**
- Modify: `src/sketcher/html.ts` (JS section)

Replace the ad-hoc `tool` + `isPanning` + `drawStart` state with a proper state machine. Panning is intentionally enabled in ALL tool modes (changed from current `select`-only behavior).

- [ ] **Step 1: Replace state variables block**

Find `// --- State ---` and replace the block through `var ws = null;` with:

```js
// --- State ---
var plan = null;
var tool = 'select';          // active tool: select|wall|door|window|room|furniture
var interactionMode = 'idle';  // idle|selecting|dragging_endpoint|drawing_wall|panning|placing_opening|rotating_furniture
var selected = null;           // { type, id }
var drawStart = null;          // wall drawing start point
var dragState = null;          // { wallId, endpoint, startPoint, connectedWalls, originalPositions, detached }
var snapResult = null;         // { point, guides[] }
var undoStack = [];            // [{ changes[], inverseChanges[] }]
var redoStack = [];
var MAX_UNDO = 50;
var isDragging = false;        // true during endpoint drag (skips full render)
var viewBox = { x: 0, y: 0, w: 1000, h: 800 };
var userViewBox = false;
var ws = null;
```

Note: the old `isPanning` and `panStart` variables are removed here — `panStart` moves into the state machine section (Step 2).

- [ ] **Step 2: Add new state machine mouse handlers**

Find `function attachInteraction()` and replace the entire function with:

```js
function attachInteraction() {
  // Interaction now handled by state machine mousedown/mousemove/mouseup on svg
}
```

Then, add the following AFTER the `attachInteraction` function. This replaces the old separate mousedown/mousemove/mouseup handlers for panning (find and delete the old ones — search for `if (isPanning)` and `isPanning = true` and `isPanning = false`):

```js
// --- Desktop mouse interaction (state machine) ---
var panStart = { x: 0, y: 0 };
var mouseDownTarget = null;
var mouseDownPoint = null;

svg.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  mouseDownPoint = { x: e.clientX, y: e.clientY };

  if (tool === 'wall') {
    // Wall drawing is click-click, handled in the existing click event
    return;
  }

  // Check if we clicked on a drag handle (added in Task 4)
  var el = e.target;
  if (el.classList && el.classList.contains('drag-handle')) {
    interactionMode = 'selecting';
    mouseDownTarget = { type: 'handle', wallId: el.dataset.wallId, endpoint: el.dataset.endpoint };
    return;
  }

  // Check for rotation handle (added in Task 11)
  if (el.classList && el.classList.contains('rotation-handle')) {
    interactionMode = 'rotating_furniture';
    var furn = plan ? plan.furniture.find(function(f) { return f.id === el.dataset.furnitureId; }) : null;
    mouseDownTarget = { type: 'rotation', furnitureId: el.dataset.furnitureId, originalRotation: furn ? (furn.rotation || 0) : 0 };
    return;
  }

  // Check if we clicked on a data element (wall, room, furniture)
  while (el && !el.dataset.id && el !== svg) el = el.parentElement;
  if (el && el.dataset.id) {
    mouseDownTarget = { type: el.dataset.type, id: el.dataset.id };
    interactionMode = 'selecting';
    return;
  }

  // Empty canvas — start panning (works in ALL tool modes)
  interactionMode = 'panning';
  panStart = { x: e.clientX, y: e.clientY };
});

svg.addEventListener('mousemove', function(e) {
  // Wall drawing guide line
  if (tool === 'wall' && drawStart) {
    removeGuide();
    var pt = snapToEndpoint(svgPoint(e));
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', drawStart.x);
    line.setAttribute('y1', drawStart.y);
    line.setAttribute('x2', pt.x);
    line.setAttribute('y2', pt.y);
    line.classList.add('guide-line');
    line.id = 'guide';
    svg.appendChild(line);
  }

  // Click vs drag detection (3px threshold)
  if (interactionMode === 'selecting' && mouseDownPoint) {
    var dx = e.clientX - mouseDownPoint.x;
    var dy = e.clientY - mouseDownPoint.y;
    if (Math.sqrt(dx * dx + dy * dy) > 3) {
      if (mouseDownTarget && mouseDownTarget.type === 'handle') {
        interactionMode = 'dragging_endpoint';
        beginEndpointDrag(mouseDownTarget.wallId, mouseDownTarget.endpoint);
        // Alt/Option key = detach mode (don't move connected walls)
        if (e.altKey && dragState) dragState.detached = true;
      } else {
        // Not on a handle — fall through to panning
        interactionMode = 'panning';
        panStart = { x: e.clientX, y: e.clientY };
      }
    }
  }

  if (interactionMode === 'dragging_endpoint') {
    updateEndpointDrag(e);
  }

  if (interactionMode === 'rotating_furniture' && mouseDownTarget) {
    updateFurnitureRotation(e);
  }

  if (interactionMode === 'panning') {
    var rect = svg.getBoundingClientRect();
    var ddx = (e.clientX - panStart.x) / rect.width * viewBox.w;
    var ddy = (e.clientY - panStart.y) / rect.height * viewBox.h;
    viewBox.x -= ddx;
    viewBox.y -= ddy;
    panStart = { x: e.clientX, y: e.clientY };
    userViewBox = true;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }
});

svg.addEventListener('mouseup', function(e) {
  if (interactionMode === 'selecting') {
    // Was a click (< 3px movement)
    if (mouseDownTarget && mouseDownTarget.type !== 'handle') {
      if (tool === 'select' || tool === 'furniture') {
        selected = { type: mouseDownTarget.type, id: mouseDownTarget.id };
        render();
        showProperties();
      } else if ((tool === 'door' || tool === 'window') && mouseDownTarget.type === 'wall') {
        addOpeningToWall(mouseDownTarget.id, tool, e);
      }
    }
  }

  if (interactionMode === 'dragging_endpoint') {
    commitEndpointDrag();
  }

  if (interactionMode === 'rotating_furniture' && mouseDownTarget) {
    commitFurnitureRotation();
  }

  // If we were panning but barely moved, treat as deselect click
  if (interactionMode === 'panning' && mouseDownPoint) {
    var pdx = e.clientX - mouseDownPoint.x;
    var pdy = e.clientY - mouseDownPoint.y;
    if (Math.sqrt(pdx * pdx + pdy * pdy) < 3) {
      selected = null;
      render();
      showProperties();
    }
  }

  interactionMode = 'idle';
  mouseDownTarget = null;
  mouseDownPoint = null;
});
```

- [ ] **Step 3: Delete old mouse handlers that are now replaced**

Find and delete these specific handlers (they're replaced by the state machine above):
1. The old panning mousedown: search for `if (tool === 'select' && e.target === svg)` inside a mousedown handler
2. The old panning mousemove: search for `if (isPanning) {`
3. The old panning mouseup: search for `svg.addEventListener('mouseup', function() { isPanning = false; });`
4. The old guide line mousemove: search for `if (tool === 'wall' && drawStart)` inside a mousemove handler (this is now merged into the state machine mousemove)

Keep the wall drawing click handler: `svg.addEventListener('click', function(e) { if (tool !== 'wall') return;` — this stays as-is.

- [ ] **Step 4: Add stub functions for endpoint dragging and rotation**

Add these placeholder functions (implemented in later tasks):

```js
function beginEndpointDrag(wallId, endpoint) {
  // Implemented in Task 4
}

function updateEndpointDrag(e) {
  // Implemented in Task 4
}

function commitEndpointDrag() {
  // Implemented in Task 4
}

function updateFurnitureRotation(e) {
  // Implemented in Task 11
}

function commitFurnitureRotation() {
  // Implemented in Task 11
}
```

- [ ] **Step 5: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: interaction state machine replacing ad-hoc tool+isPanning"
```

---

### Task 4: Drag handles and single-wall endpoint dragging (grid snap only)

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add drag handle CSS**

Find the `svg line.selected` CSS rule. Add nearby:

```css
.drag-handle { cursor: grab; }
.drag-handle:active { cursor: grabbing; }
```

- [ ] **Step 2: Add `svgPointRaw` helper (no grid snap)**

Find `function svgPoint(e)`. Add a companion function after it:

```js
function svgPointRaw(e) {
  var rect = svg.getBoundingClientRect();
  var scaleX = viewBox.w / rect.width;
  var scaleY = viewBox.h / rect.height;
  return {
    x: viewBox.x + (e.clientX - rect.left) * scaleX,
    y: viewBox.y + (e.clientY - rect.top) * scaleY,
  };
}
```

- [ ] **Step 3: Render drag handles and snap guides overlay in render()**

Find `svg.innerHTML = html;` inside `function render()`. Immediately BEFORE that line, add:

```js
// Drag handles for selected wall
html += '<g id="drag-handles">';
if (selected && selected.type === 'wall') {
  var selWall = plan.walls.find(function(w) { return w.id === selected.id; });
  if (selWall) {
    var hr = isMobile() ? 14 : 8;
    html += '<circle class="drag-handle" cx="' + selWall.start.x + '" cy="' + selWall.start.y + '" r="' + hr + '" fill="rgba(0,181,204,0.3)" stroke="#00B5CC" stroke-width="2" data-wall-id="' + selWall.id + '" data-endpoint="start" style="cursor:grab"/>';
    html += '<circle class="drag-handle" cx="' + selWall.end.x + '" cy="' + selWall.end.y + '" r="' + hr + '" fill="rgba(0,181,204,0.3)" stroke="#00B5CC" stroke-width="2" data-wall-id="' + selWall.id + '" data-endpoint="end" style="cursor:grab"/>';
  }
}
html += '</g>';
// Snap guides overlay (populated during drag by renderSnapGuides)
html += '<g id="snap-guides"></g>';
```

Note: `isMobile()` already exists. Drag handle radius: 8 SVG units desktop (comfortable mouse target), 14 SVG units mobile (~28px touch target).

- [ ] **Step 4: Skip full render during drag**

At the very top of `function render()`, after `if (!plan) return;`, add:

```js
if (isDragging) return;
```

- [ ] **Step 5: Implement `beginEndpointDrag`**

Replace the stub with:

```js
function beginEndpointDrag(wallId, endpoint) {
  var wall = plan.walls.find(function(w) { return w.id === wallId; });
  if (!wall) return;
  var startPoint = endpoint === 'start' ? wall.start : wall.end;
  dragState = {
    wallId: wallId,
    endpoint: endpoint,
    startPoint: { x: startPoint.x, y: startPoint.y },
    connectedWalls: [],
    originalPositions: {},
    detached: false
  };
  dragState.originalPositions[wallId] = {
    start: { x: wall.start.x, y: wall.start.y },
    end: { x: wall.end.x, y: wall.end.y }
  };
  isDragging = true;
}
```

- [ ] **Step 6: Implement `updateEndpointDrag` with grid snap**

Replace the stub with:

```js
function updateEndpointDrag(e) {
  if (!dragState || !plan) return;
  var rawPt = svgPointRaw(e);
  // Grid snap (10cm) — full snap system replaces this in Task 7
  var pt = { x: Math.round(rawPt.x / 10) * 10, y: Math.round(rawPt.y / 10) * 10 };

  var wall = plan.walls.find(function(w) { return w.id === dragState.wallId; });
  if (!wall) return;

  // Update model
  if (dragState.endpoint === 'start') wall.start = pt;
  else wall.end = pt;

  // Direct DOM update (no full render — performance)
  var wallEl = svg.querySelector('line[data-id="' + dragState.wallId + '"]');
  if (wallEl) {
    wallEl.setAttribute('x1', wall.start.x);
    wallEl.setAttribute('y1', wall.start.y);
    wallEl.setAttribute('x2', wall.end.x);
    wallEl.setAttribute('y2', wall.end.y);
  }

  // Update drag handle positions
  svg.querySelectorAll('.drag-handle[data-wall-id="' + dragState.wallId + '"]').forEach(function(h) {
    var ep = h.dataset.endpoint === 'start' ? wall.start : wall.end;
    h.setAttribute('cx', ep.x);
    h.setAttribute('cy', ep.y);
  });
}
```

- [ ] **Step 7: Add `pushUndo` and `updateUndoButtons` functions**

Add these after `sendChange`:

```js
function pushUndo(changes, inverseChanges) {
  undoStack.push({ changes: changes, inverseChanges: inverseChanges });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function updateUndoButtons() {
  var undoBtn = document.getElementById('btn-undo');
  var redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  var mUndo = document.getElementById('mobile-undo');
  var mRedo = document.getElementById('mobile-redo');
  if (mUndo) mUndo.disabled = undoStack.length === 0;
  if (mRedo) mRedo.disabled = redoStack.length === 0;
}
```

- [ ] **Step 8: Implement `commitEndpointDrag`**

Replace the stub with:

```js
function commitEndpointDrag() {
  if (!dragState || !plan) { isDragging = false; return; }
  var wall = plan.walls.find(function(w) { return w.id === dragState.wallId; });
  if (!wall) { isDragging = false; return; }

  // Prevent degenerate walls (less than 5cm)
  var wdx = wall.end.x - wall.start.x, wdy = wall.end.y - wall.start.y;
  var wlen = Math.sqrt(wdx * wdx + wdy * wdy);
  if (wlen < 5) {
    // Revert to original positions
    var revert = dragState.originalPositions[dragState.wallId];
    wall.start = revert.start;
    wall.end = revert.end;
    if (dragState.connectedWalls) {
      for (var ri = 0; ri < dragState.connectedWalls.length; ri++) {
        var rc = dragState.connectedWalls[ri];
        var rw = plan.walls.find(function(w) { return w.id === rc.wallId; });
        var ro = dragState.originalPositions[rc.wallId];
        if (rw && ro) { rw.start = ro.start; rw.end = ro.end; }
      }
    }
    isDragging = false;
    dragState = null;
    render();
    return;
  }

  var changes = [];
  var inverseChanges = [];

  // Main wall
  var orig = dragState.originalPositions[dragState.wallId];
  changes.push({ type: 'move_wall', wall_id: dragState.wallId, start: { x: wall.start.x, y: wall.start.y }, end: { x: wall.end.x, y: wall.end.y } });
  inverseChanges.push({ type: 'move_wall', wall_id: dragState.wallId, start: orig.start, end: orig.end });

  // Connected walls (added in Task 6)
  if (!dragState.detached && dragState.connectedWalls) {
    for (var ci = 0; ci < dragState.connectedWalls.length; ci++) {
      var conn = dragState.connectedWalls[ci];
      var cw = plan.walls.find(function(w) { return w.id === conn.wallId; });
      var corig = dragState.originalPositions[conn.wallId];
      if (cw && corig) {
        changes.push({ type: 'move_wall', wall_id: conn.wallId, start: { x: cw.start.x, y: cw.start.y }, end: { x: cw.end.x, y: cw.end.y } });
        inverseChanges.push({ type: 'move_wall', wall_id: conn.wallId, start: corig.start, end: corig.end });
      }
    }
  }

  // Room polygon propagation (added in Task 8)
  var origPt = dragState.startPoint;
  var newPt = dragState.endpoint === 'start' ? wall.start : wall.end;
  if (origPt.x !== newPt.x || origPt.y !== newPt.y) {
    var roomThreshold = 2; // 2cm
    for (var rpi = 0; rpi < plan.rooms.length; rpi++) {
      var room = plan.rooms[rpi];
      var roomChanged = false;
      var newPolygon = room.polygon.map(function(v) {
        if (Math.abs(v.x - origPt.x) <= roomThreshold && Math.abs(v.y - origPt.y) <= roomThreshold) {
          roomChanged = true;
          return { x: newPt.x, y: newPt.y };
        }
        return { x: v.x, y: v.y };
      });
      if (roomChanged) {
        var oldPolygon = room.polygon.map(function(v) { return { x: v.x, y: v.y }; });
        room.polygon = newPolygon;
        room.area = computeArea(newPolygon);
        changes.push({ type: 'update_room', room_id: room.id, polygon: newPolygon });
        inverseChanges.push({ type: 'update_room', room_id: room.id, polygon: oldPolygon });
      }
    }
  }

  // Clear snap guides
  var sgEl = svg.getElementById('snap-guides');
  if (sgEl) sgEl.innerHTML = '';

  if (changes.length > 0) {
    pushUndo(changes, inverseChanges);
    changes.forEach(function(c) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(c));
      }
    });
  }

  isDragging = false;
  dragState = null;
  render();
  showProperties();
}
```

Note: This includes room polygon propagation and short wall prevention upfront. The `update_room` changes won't fire until rooms actually have matching polygon vertices (Task 8 is pre-integrated here). The `connectedWalls` array starts empty and gets populated in Task 6.

- [ ] **Step 9: Add `update_room` to client-side `applyChangeLocal`**

Find `function applyChangeLocal(change)` and its `switch (change.type) {` block. Add before the `case 'add_furniture':` case:

```js
case 'update_room': {
  var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
  if (r) {
    if (change.polygon) { r.polygon = change.polygon; r.area = computeArea(change.polygon); }
    if (change.area !== undefined) r.area = change.area;
  }
  break;
}
```

- [ ] **Step 10: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 11: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: drag handles, endpoint dragging, undo stack, room propagation"
```

---

### Task 5: Enhanced properties panel with editable length, angle, coordinates

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Replace wall properties rendering**

Find `function renderPropertiesHtml()`. Inside it, find `if (selected.type === 'wall') {` and replace the entire wall block (through its closing `}`) with:

```js
if (selected.type === 'wall') {
  var wall = plan.walls.find(function(w) { return w.id === selected.id; });
  if (!wall) return '';
  var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  var len = Math.sqrt(dx * dx + dy * dy);
  var angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return '<h3>Wall</h3>' +
    '<label>Type</label><select id="prop-wall-type"><option value="exterior"' + (wall.type==='exterior'?' selected':'') + '>Exterior</option><option value="interior"' + (wall.type==='interior'?' selected':'') + '>Interior</option><option value="divider"' + (wall.type==='divider'?' selected':'') + '>Divider</option></select>' +
    '<label>Thickness (cm)</label><input id="prop-wall-thick" type="number" value="' + wall.thickness + '">' +
    '<label>Length (m)</label><input id="prop-wall-length" type="number" step="0.01" value="' + (len / 100).toFixed(2) + '">' +
    '<label>Angle (&deg;)</label><input id="prop-wall-angle" type="number" step="1" value="' + Math.round(angle) + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px">' +
    '<div><label>Start X</label><input id="prop-wall-sx" type="number" value="' + Math.round(wall.start.x) + '"></div>' +
    '<div><label>Start Y</label><input id="prop-wall-sy" type="number" value="' + Math.round(wall.start.y) + '"></div>' +
    '<div><label>End X</label><input id="prop-wall-ex" type="number" value="' + Math.round(wall.end.x) + '"></div>' +
    '<div><label>End Y</label><input id="prop-wall-ey" type="number" value="' + Math.round(wall.end.y) + '"></div>' +
    '</div>' +
    '<label>Openings (' + wall.openings.length + ')</label>' +
    wall.openings.map(function(o) {
      return '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:12px">' +
        '<span>' + o.type + ' (' + o.width + 'cm)</span>' +
        '<button data-remove-opening="' + o.id + '" style="color:#D84200;border:1px solid #D84200;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;padding:1px 6px">&times;</button>' +
        '</div>';
    }).join('') +
    '<br><button id="prop-wall-delete" style="color:#D84200;border:1px solid #D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete Wall</button>';
}
```

- [ ] **Step 2: Replace furniture properties rendering**

In the same function, find `if (selected.type === 'furniture') {` and replace the entire furniture block with:

```js
if (selected.type === 'furniture') {
  var item = plan.furniture.find(function(f) { return f.id === selected.id; });
  if (!item) return '';
  return '<h3>Furniture</h3>' +
    '<label>Type</label><p style="font-size:13px;margin-top:2px">' + escHtml(item.type) + '</p>' +
    '<label>Size</label><p style="font-size:13px;margin-top:2px">' + item.width + ' &times; ' + item.depth + ' cm</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px">' +
    '<div><label>Position X</label><input id="prop-furn-x" type="number" value="' + Math.round(item.position.x) + '"></div>' +
    '<div><label>Position Y</label><input id="prop-furn-y" type="number" value="' + Math.round(item.position.y) + '"></div>' +
    '</div>' +
    '<label>Rotation (&deg;)</label><input id="prop-furn-rot" type="number" step="15" value="' + (item.rotation || 0) + '">' +
    '<br><button id="prop-furn-delete" style="color:#D84200;border:1px solid #D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete</button>';
}
```

- [ ] **Step 3: Replace wall property event handlers**

Find `function attachPropertiesHandlers()`. Replace the entire `if (selected.type === 'wall') {` block inside it with:

```js
if (selected.type === 'wall') {
  var wall = plan.walls.find(function(w) { return w.id === selected.id; });
  if (!wall) return;
  var typeEl = document.getElementById('prop-wall-type');
  var thickEl = document.getElementById('prop-wall-thick');
  var delEl = document.getElementById('prop-wall-delete');
  if (typeEl) typeEl.onchange = function(e) {
    sendChange({ type: 'update_wall', wall_id: wall.id, wall_type: e.target.value });
  };
  if (thickEl) thickEl.onchange = function(e) {
    sendChange({ type: 'update_wall', wall_id: wall.id, thickness: parseInt(e.target.value) });
  };
  if (delEl) delEl.onclick = function() {
    sendChange({ type: 'remove_wall', wall_id: wall.id });
    selected = null;
    showProperties();
  };
  // Length change: preserve start point and angle, adjust end point
  var lenEl = document.getElementById('prop-wall-length');
  if (lenEl) lenEl.onchange = function(e) {
    var newLen = parseFloat(e.target.value) * 100;
    if (isNaN(newLen) || newLen < 1) return;
    var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    var curLen = Math.sqrt(dx * dx + dy * dy);
    if (curLen < 0.01) return;
    var scale = newLen / curLen;
    sendChange({ type: 'move_wall', wall_id: wall.id, end: { x: Math.round(wall.start.x + dx * scale), y: Math.round(wall.start.y + dy * scale) } });
  };
  // Angle change: preserve start point and length, rotate end point
  var angEl = document.getElementById('prop-wall-angle');
  if (angEl) angEl.onchange = function(e) {
    var newAngle = parseFloat(e.target.value) * Math.PI / 180;
    if (isNaN(newAngle)) return;
    var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    sendChange({ type: 'move_wall', wall_id: wall.id, end: { x: Math.round(wall.start.x + Math.cos(newAngle) * len), y: Math.round(wall.start.y + Math.sin(newAngle) * len) } });
  };
  // Coordinate changes (commit on blur/enter via onchange)
  ['prop-wall-sx', 'prop-wall-sy', 'prop-wall-ex', 'prop-wall-ey'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.onchange = function() {
      var sx = parseInt(document.getElementById('prop-wall-sx').value);
      var sy = parseInt(document.getElementById('prop-wall-sy').value);
      var ex = parseInt(document.getElementById('prop-wall-ex').value);
      var ey = parseInt(document.getElementById('prop-wall-ey').value);
      if ([sx, sy, ex, ey].some(isNaN)) return;
      sendChange({ type: 'move_wall', wall_id: wall.id, start: { x: sx, y: sy }, end: { x: ex, y: ey } });
    };
  });
  // Opening delete buttons
  document.querySelectorAll('[data-remove-opening]').forEach(function(btn) {
    btn.onclick = function() {
      sendChange({ type: 'remove_opening', wall_id: wall.id, opening_id: btn.dataset.removeOpening });
    };
  });
}
```

- [ ] **Step 4: Replace furniture property event handlers**

Replace the `if (selected.type === 'furniture') {` block in `attachPropertiesHandlers()` with:

```js
if (selected.type === 'furniture') {
  var item = plan.furniture.find(function(f) { return f.id === selected.id; });
  if (!item) return;
  var delEl = document.getElementById('prop-furn-delete');
  if (delEl) delEl.onclick = function() {
    sendChange({ type: 'remove_furniture', furniture_id: selected.id });
    selected = null;
    showProperties();
  };
  var fxEl = document.getElementById('prop-furn-x');
  var fyEl = document.getElementById('prop-furn-y');
  var frotEl = document.getElementById('prop-furn-rot');
  if (fxEl) fxEl.onchange = function(e) {
    sendChange({ type: 'move_furniture', furniture_id: item.id, position: { x: parseInt(e.target.value), y: item.position.y } });
  };
  if (fyEl) fyEl.onchange = function(e) {
    sendChange({ type: 'move_furniture', furniture_id: item.id, position: { x: item.position.x, y: parseInt(e.target.value) } });
  };
  if (frotEl) frotEl.onchange = function(e) {
    sendChange({ type: 'move_furniture', furniture_id: item.id, rotation: parseInt(e.target.value) });
  };
}
```

- [ ] **Step 5: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: enhanced properties panel — editable length, angle, coordinates, opening delete"
```

---

## Phase 1b: Connected Walls + Full Snap

### Task 6: Connected wall detection and auto-follow during drag

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add `findConnectedEndpoints` function**

Add before `function beginEndpointDrag`:

```js
function findConnectedEndpoints(wallId, endpoint) {
  var wall = plan.walls.find(function(w) { return w.id === wallId; });
  if (!wall) return [];
  var pt = endpoint === 'start' ? wall.start : wall.end;
  var threshold = 1; // 1cm
  var connected = [];
  for (var i = 0; i < plan.walls.length; i++) {
    var w = plan.walls[i];
    if (w.id === wallId) continue;
    if (Math.abs(w.start.x - pt.x) <= threshold && Math.abs(w.start.y - pt.y) <= threshold) {
      connected.push({ wallId: w.id, endpoint: 'start' });
    }
    if (Math.abs(w.end.x - pt.x) <= threshold && Math.abs(w.end.y - pt.y) <= threshold) {
      connected.push({ wallId: w.id, endpoint: 'end' });
    }
  }
  return connected;
}
```

- [ ] **Step 2: Update `beginEndpointDrag` to populate connectedWalls**

In `beginEndpointDrag`, find `connectedWalls: [],` and replace with:

```js
connectedWalls: findConnectedEndpoints(wallId, endpoint),
```

Also add original positions for connected walls. After `dragState.originalPositions[wallId] = {`, add:

```js
var connected = dragState.connectedWalls;
for (var i = 0; i < connected.length; i++) {
  var cw = plan.walls.find(function(w) { return w.id === connected[i].wallId; });
  if (cw) {
    dragState.originalPositions[connected[i].wallId] = {
      start: { x: cw.start.x, y: cw.start.y },
      end: { x: cw.end.x, y: cw.end.y }
    };
  }
}
```

- [ ] **Step 3: Update `updateEndpointDrag` to move connected walls**

After the dragged wall's DOM update in `updateEndpointDrag`, add before the drag handle update:

```js
// Move connected walls (unless Alt/Option = detach mode)
if (!dragState.detached && dragState.connectedWalls) {
  for (var i = 0; i < dragState.connectedWalls.length; i++) {
    var conn = dragState.connectedWalls[i];
    var cw = plan.walls.find(function(w) { return w.id === conn.wallId; });
    if (!cw) continue;
    if (conn.endpoint === 'start') cw.start = { x: pt.x, y: pt.y };
    else cw.end = { x: pt.x, y: pt.y };

    var cwEl = svg.querySelector('line[data-id="' + conn.wallId + '"]');
    if (cwEl) {
      cwEl.setAttribute('x1', cw.start.x);
      cwEl.setAttribute('y1', cw.start.y);
      cwEl.setAttribute('x2', cw.end.x);
      cwEl.setAttribute('y2', cw.end.y);
    }
  }
}
```

- [ ] **Step 4: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: connected wall auto-follow during endpoint drag with Alt-detach"
```

---

### Task 7: Full CAD snap system

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add `computeSnap` and `renderSnapGuides` functions**

Add before `function updateEndpointDrag`:

```js
function computeSnap(rawPoint, excludeWallIds) {
  if (!plan) return { point: rawPoint, guides: [] };
  var svgRect = svg.getBoundingClientRect();
  var pxPerCm = svgRect.width / viewBox.w;

  // Collect all endpoints and midpoints (excluding dragged walls)
  var endpoints = [];
  var midpoints = [];
  for (var i = 0; i < plan.walls.length; i++) {
    var w = plan.walls[i];
    if (excludeWallIds.indexOf(w.id) >= 0) continue;
    endpoints.push(w.start);
    endpoints.push(w.end);
    midpoints.push({ x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 });
  }

  // 1. Endpoint snap (15px threshold) — highest priority
  var epThresh = 15 / pxPerCm;
  for (var i = 0; i < endpoints.length; i++) {
    var ep = endpoints[i];
    var d = Math.sqrt(Math.pow(rawPoint.x - ep.x, 2) + Math.pow(rawPoint.y - ep.y, 2));
    if (d < epThresh) {
      return { point: { x: ep.x, y: ep.y }, guides: [{ type: 'endpoint', x: ep.x, y: ep.y }] };
    }
  }

  // 2. Perpendicular snap (10px threshold) — check if creating 90° with connected wall
  if (dragState && dragState.connectedWalls) {
    for (var i = 0; i < dragState.connectedWalls.length; i++) {
      var conn = dragState.connectedWalls[i];
      var cw = plan.walls.find(function(w) { return w.id === conn.wallId; });
      if (!cw) continue;
      var fixedPt = conn.endpoint === 'start' ? cw.end : cw.start;
      var dragWall = plan.walls.find(function(w) { return w.id === dragState.wallId; });
      if (!dragWall) continue;
      var otherPt = dragState.endpoint === 'start' ? dragWall.end : dragWall.start;
      var cwDx = fixedPt.x - rawPoint.x, cwDy = fixedPt.y - rawPoint.y;
      var dwDx = otherPt.x - rawPoint.x, dwDy = otherPt.y - rawPoint.y;
      var dot = cwDx * dwDx + cwDy * dwDy;
      var cwLen = Math.sqrt(cwDx * cwDx + cwDy * cwDy);
      var dwLen = Math.sqrt(dwDx * dwDx + dwDy * dwDy);
      if (cwLen > 0 && dwLen > 0) {
        var cosAngle = dot / (cwLen * dwLen);
        if (Math.abs(cosAngle) < 0.05) {
          return { point: { x: Math.round(rawPoint.x), y: Math.round(rawPoint.y) }, guides: [{ type: 'perpendicular', x: rawPoint.x, y: rawPoint.y }] };
        }
      }
    }
  }

  // 3. Alignment snap (10px threshold) — X or Y aligns with any endpoint
  var alignThresh = 10 / pxPerCm;
  var snapX = null, snapY = null;
  var guides = [];
  for (var i = 0; i < endpoints.length; i++) {
    var ep = endpoints[i];
    if (snapX === null && Math.abs(rawPoint.x - ep.x) < alignThresh) {
      snapX = ep.x;
      guides.push({ type: 'alignment', axis: 'vertical', x: ep.x });
    }
    if (snapY === null && Math.abs(rawPoint.y - ep.y) < alignThresh) {
      snapY = ep.y;
      guides.push({ type: 'alignment', axis: 'horizontal', y: ep.y });
    }
  }
  if (snapX !== null || snapY !== null) {
    return {
      point: { x: snapX !== null ? snapX : Math.round(rawPoint.x / 10) * 10, y: snapY !== null ? snapY : Math.round(rawPoint.y / 10) * 10 },
      guides: guides
    };
  }

  // 4. Midpoint snap (10px threshold)
  var midThresh = 10 / pxPerCm;
  for (var i = 0; i < midpoints.length; i++) {
    var mp = midpoints[i];
    var d = Math.sqrt(Math.pow(rawPoint.x - mp.x, 2) + Math.pow(rawPoint.y - mp.y, 2));
    if (d < midThresh) {
      return { point: { x: mp.x, y: mp.y }, guides: [{ type: 'midpoint', x: mp.x, y: mp.y }] };
    }
  }

  // 5. Grid snap (fallback — always active)
  return { point: { x: Math.round(rawPoint.x / 10) * 10, y: Math.round(rawPoint.y / 10) * 10 }, guides: [] };
}

function renderSnapGuides(guides) {
  var g = svg.getElementById('snap-guides');
  if (!g) return;
  var html = '';
  for (var i = 0; i < guides.length; i++) {
    var guide = guides[i];
    if (guide.type === 'endpoint') {
      html += '<circle cx="' + guide.x + '" cy="' + guide.y + '" r="6" fill="#D84200" stroke="white" stroke-width="1.5" pointer-events="none"/>';
    } else if (guide.type === 'alignment') {
      if (guide.axis === 'vertical') {
        html += '<line x1="' + guide.x + '" y1="' + viewBox.y + '" x2="' + guide.x + '" y2="' + (viewBox.y + viewBox.h) + '" stroke="#00B5CC" stroke-width="1" stroke-dasharray="6,4" opacity="0.6" pointer-events="none"/>';
      } else {
        html += '<line x1="' + viewBox.x + '" y1="' + guide.y + '" x2="' + (viewBox.x + viewBox.w) + '" y2="' + guide.y + '" stroke="#00B5CC" stroke-width="1" stroke-dasharray="6,4" opacity="0.6" pointer-events="none"/>';
      }
    } else if (guide.type === 'midpoint') {
      html += '<rect x="' + (guide.x - 4) + '" y="' + (guide.y - 4) + '" width="8" height="8" fill="#5C6566" transform="rotate(45,' + guide.x + ',' + guide.y + ')" pointer-events="none"/>';
    } else if (guide.type === 'perpendicular') {
      html += '<path d="M' + (guide.x - 6) + ',' + guide.y + ' L' + (guide.x - 6) + ',' + (guide.y - 6) + ' L' + guide.x + ',' + (guide.y - 6) + '" stroke="#007B8C" stroke-width="1.5" fill="none" pointer-events="none"/>';
    }
  }
  g.innerHTML = html;
}
```

- [ ] **Step 2: Update `updateEndpointDrag` to use `computeSnap`**

In `updateEndpointDrag`, replace the grid snap lines:
```js
// Grid snap (10cm) — full snap system replaces this in Task 7
var pt = { x: Math.round(rawPt.x / 10) * 10, y: Math.round(rawPt.y / 10) * 10 };
```

With:
```js
var excludeIds = [dragState.wallId];
if (dragState.connectedWalls) {
  dragState.connectedWalls.forEach(function(c) { excludeIds.push(c.wallId); });
}
var snap = computeSnap(rawPt, excludeIds);
var pt = snap.point;
renderSnapGuides(snap.guides);
```

- [ ] **Step 3: Update `snapToEndpoint` to use full snap for wall drawing**

Find `function snapToEndpoint(pt)` and replace it with:

```js
function snapToEndpoint(pt) {
  if (!plan) return pt;
  var snap = computeSnap(pt, []);
  return snap.point;
}
```

- [ ] **Step 4: Add WebSocket throttling for drag**

Add near the state variables:

```js
var lastWsSend = 0;
var WS_THROTTLE_MS = 100; // 10fps

function sendWsThrottled(msg) {
  var now = Date.now();
  if (now - lastWsSend >= WS_THROTTLE_MS) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
    lastWsSend = now;
  }
}
```

At the end of `updateEndpointDrag`, add:

```js
// Throttled WebSocket broadcast during drag (10fps)
sendWsThrottled({ type: 'move_wall', wall_id: dragState.wallId, start: { x: wall.start.x, y: wall.start.y }, end: { x: wall.end.x, y: wall.end.y } });
```

- [ ] **Step 5: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: full CAD snap system + WebSocket throttling during drag"
```

---

## Phase 1c: Undo/Redo + Filter Behavior

### Task 8: Undo/redo system with keyboard shortcuts

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add `performUndo` and `performRedo` functions**

Add after `updateUndoButtons`:

```js
function performUndo() {
  if (undoStack.length === 0) return;
  var entry = undoStack.pop();
  for (var i = 0; i < entry.inverseChanges.length; i++) {
    applyChangeLocal(entry.inverseChanges[i]);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(entry.inverseChanges[i]));
    }
  }
  redoStack.push(entry);
  updateUndoButtons();
  render();
  showProperties();
}

function performRedo() {
  if (redoStack.length === 0) return;
  var entry = redoStack.pop();
  for (var i = 0; i < entry.changes.length; i++) {
    applyChangeLocal(entry.changes[i]);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(entry.changes[i]));
    }
  }
  undoStack.push(entry);
  updateUndoButtons();
  render();
  showProperties();
}
```

- [ ] **Step 2: Wire up undo/redo buttons**

After the `toolButtons` forEach handler setup, add:

```js
document.getElementById('btn-undo').addEventListener('click', performUndo);
document.getElementById('btn-redo').addEventListener('click', performRedo);
```

- [ ] **Step 3: Add `computeInverse` and update `sendChange` for undo support**

Add before `function sendChange`:

```js
function computeInverse(change) {
  switch (change.type) {
    case 'add_wall': return { type: 'remove_wall', wall_id: change.wall.id };
    case 'remove_wall': {
      var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
      return w ? { type: 'add_wall', wall: JSON.parse(JSON.stringify(w)) } : null;
    }
    case 'move_wall': {
      var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
      return w ? { type: 'move_wall', wall_id: change.wall_id, start: { x: w.start.x, y: w.start.y }, end: { x: w.end.x, y: w.end.y } } : null;
    }
    case 'update_wall': {
      var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
      return w ? { type: 'update_wall', wall_id: change.wall_id, thickness: w.thickness, wall_type: w.type } : null;
    }
    case 'add_opening': return { type: 'remove_opening', wall_id: change.wall_id, opening_id: change.opening.id };
    case 'remove_opening': {
      var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
      if (!w) return null;
      var o = w.openings.find(function(o) { return o.id === change.opening_id; });
      return o ? { type: 'add_opening', wall_id: change.wall_id, opening: JSON.parse(JSON.stringify(o)) } : null;
    }
    case 'add_room': return { type: 'remove_room', room_id: change.room.id };
    case 'remove_room': {
      var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
      return r ? { type: 'add_room', room: JSON.parse(JSON.stringify(r)) } : null;
    }
    case 'rename_room': {
      var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
      return r ? { type: 'rename_room', room_id: change.room_id, label: r.label, room_type: r.type } : null;
    }
    case 'update_room': {
      var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
      return r ? { type: 'update_room', room_id: change.room_id, polygon: r.polygon.map(function(p) { return { x: p.x, y: p.y }; }) } : null;
    }
    case 'add_furniture': return { type: 'remove_furniture', furniture_id: change.furniture.id };
    case 'remove_furniture': {
      var f = plan.furniture.find(function(f) { return f.id === change.furniture_id; });
      return f ? { type: 'add_furniture', furniture: JSON.parse(JSON.stringify(f)) } : null;
    }
    case 'move_furniture': {
      var f = plan.furniture.find(function(f) { return f.id === change.furniture_id; });
      return f ? { type: 'move_furniture', furniture_id: change.furniture_id, position: { x: f.position.x, y: f.position.y }, rotation: f.rotation } : null;
    }
    default: return null;
  }
}
```

**IMPORTANT:** `computeInverse` must be called BEFORE `applyChangeLocal` — it captures the current state to build the inverse.

Replace `function sendChange(change)` with:

```js
function sendChange(change) {
  if (!plan) return;
  var inverse = computeInverse(change);
  applyChangeLocal(change);
  if (inverse) pushUndo([change], [inverse]);
  userViewBox = false;
  render();
  showProperties();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(change));
  }
}
```

- [ ] **Step 4: Replace keyboard handler**

Find `document.addEventListener('keydown'` and replace the entire handler with:

```js
document.addEventListener('keydown', function(e) {
  // Skip shortcuts when typing in form fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') { setTool('select'); selected = null; render(); showProperties(); }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected) {
      if (selected.type === 'wall') sendChange({ type: 'remove_wall', wall_id: selected.id });
      else if (selected.type === 'room') sendChange({ type: 'remove_room', room_id: selected.id });
      else if (selected.type === 'furniture') sendChange({ type: 'remove_furniture', furniture_id: selected.id });
      selected = null;
      showProperties();
    }
  }
  if (!e.ctrlKey && !e.metaKey) {
    if (e.key === 'w') setTool('wall');
    if (e.key === 's') setTool('select');
    if (e.key === 'd') setTool('door');
    if (e.key === 'r') setTool('room');
    if (e.key === 'f') setTool('furniture');
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); performUndo(); }
    if (e.key === 'z' && e.shiftKey) { e.preventDefault(); performRedo(); }
    if (e.key === 'Z') { e.preventDefault(); performRedo(); }
  }
});
```

Note: Cmd+S for save is intentionally removed (auto-save via WebSocket). The `save()` function remains for internal use but is no longer keyboard-triggered.

- [ ] **Step 5: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: undo/redo system with Cmd+Z/Cmd+Shift+Z shortcuts"
```

---

### Task 9: Visual filter dimming per active tool

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add dimmed CSS class**

Add to the CSS section (near the SVG interactive styles):

```css
.dimmed { opacity: 0.2; pointer-events: none; }
```

- [ ] **Step 2: Apply dimming in render() based on active tool**

In `function render()`, find where rooms/walls/openings/furniture groups are created. Before the rooms group, add:

```js
// Visual filter: dim non-relevant layers based on active tool
var dimRooms = (tool === 'wall' || tool === 'door' || tool === 'window' || tool === 'furniture');
var dimWalls = (tool === 'room' || tool === 'furniture');
var dimOpenings = (tool === 'wall' || tool === 'room' || tool === 'furniture');
var dimFurniture = (tool === 'wall' || tool === 'door' || tool === 'window' || tool === 'room');
```

Then modify each group's opening tag:
- Find `html += '<g id="rooms">';` → `html += '<g id="rooms"' + (dimRooms ? ' class="dimmed"' : '') + '>';`
- Find `html += '<g id="walls">';` → `html += '<g id="walls"' + (dimWalls ? ' class="dimmed"' : '') + '>';`
- Find `html += '<g id="openings">';` → `html += '<g id="openings"' + (dimOpenings ? ' class="dimmed"' : '') + '>';`
- Find `html += '<g id="furniture">';` → `html += '<g id="furniture"' + (dimFurniture ? ' class="dimmed"' : '') + '>';`

- [ ] **Step 3: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: visual filter dimming per active tool mode"
```

---

### Task 10: Furniture rotation handle (lollipop)

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add rotation handle rendering in render()**

In `function render()`, after the drag handles group (after `html += '<g id="drag-handles">'; ... html += '</g>';`), add:

```js
// Rotation handle for selected furniture (lollipop style)
if (selected && selected.type === 'furniture') {
  var selFurn = plan.furniture.find(function(f) { return f.id === selected.id; });
  if (selFurn) {
    var fcx = selFurn.position.x + selFurn.width / 2;
    var fcy = selFurn.position.y + selFurn.depth / 2;
    var handleR = isMobile() ? 12 : 6;
    var handleDist = Math.max(selFurn.width, selFurn.depth) / 2 + 20;
    var rot = (selFurn.rotation || 0) * Math.PI / 180;
    // Handle sits above the furniture center, rotated with the item
    var hx = fcx - Math.sin(rot) * handleDist;
    var hy = fcy - Math.cos(rot) * handleDist;
    html += '<g id="rotation-handle">';
    html += '<line x1="' + fcx + '" y1="' + fcy + '" x2="' + hx + '" y2="' + hy + '" stroke="#00B5CC" stroke-width="1.5" pointer-events="none"/>';
    html += '<circle cx="' + hx + '" cy="' + hy + '" r="' + handleR + '" fill="rgba(0,181,204,0.3)" stroke="#00B5CC" stroke-width="2" class="rotation-handle" data-furniture-id="' + selFurn.id + '" style="cursor:grab"/>';
    html += '</g>';
  }
}
```

- [ ] **Step 2: Implement `updateFurnitureRotation`**

Replace the stub with:

```js
function updateFurnitureRotation(e) {
  if (!mouseDownTarget || !plan) return;
  var item = plan.furniture.find(function(f) { return f.id === mouseDownTarget.furnitureId; });
  if (!item) return;
  var pt = svgPointRaw(e);
  var cx = item.position.x + item.width / 2;
  var cy = item.position.y + item.depth / 2;
  var angle = Math.atan2(pt.x - cx, -(pt.y - cy)) * 180 / Math.PI;
  // Snap to 15-degree increments
  angle = Math.round(angle / 15) * 15;
  item.rotation = ((angle % 360) + 360) % 360;
  render();
}
```

- [ ] **Step 3: Implement `commitFurnitureRotation`**

Replace the stub with (uses direct pushUndo + WebSocket since rotation was mutated during mousemove):

```js
function commitFurnitureRotation() {
  if (!mouseDownTarget || !plan) return;
  var item = plan.furniture.find(function(f) { return f.id === mouseDownTarget.furnitureId; });
  if (!item) return;
  var change = { type: 'move_furniture', furniture_id: item.id, rotation: item.rotation };
  var inverse = { type: 'move_furniture', furniture_id: item.id, rotation: mouseDownTarget.originalRotation };
  pushUndo([change], [inverse]);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(change));
  render();
  showProperties();
}
```

- [ ] **Step 4: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: furniture rotation handle (lollipop) with 15-degree snap"
```

---

## Phase 1d: Mobile + Polish

### Task 11: Mobile touch drag for wall endpoints

**Files:**
- Modify: `src/sketcher/html.ts`

- [ ] **Step 1: Add touchDragHandle variable and update touchstart**

Find `(function initTouchHandlers()`. Inside the closure, add a new variable after the existing ones:

```js
var touchDragHandle = null;
```

Replace the touchstart handler (find `svg.addEventListener('touchstart'` inside `initTouchHandlers`). Change `{ passive: true }` to `{ passive: false }` and update the body:

```js
svg.addEventListener('touchstart', function(e) {
  if (e.touches.length === 1) {
    var t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    touchStartVB = { x: viewBox.x, y: viewBox.y };
    isTouchPanning = false;
    tapStart = { x: t.clientX, y: t.clientY, time: Date.now() };

    // Check if touch hit a drag handle
    var el = document.elementFromPoint(t.clientX, t.clientY);
    if (el && el.classList && el.classList.contains('drag-handle')) {
      touchDragHandle = { wallId: el.dataset.wallId, endpoint: el.dataset.endpoint };
      beginEndpointDrag(el.dataset.wallId, el.dataset.endpoint);
      if (isMobile()) setSheetState('collapsed');
      e.preventDefault();
      return;
    }
    touchDragHandle = null;
  } else if (e.touches.length === 2) {
    tapStart = null;
    touchDragHandle = null;
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    lastPinchDist = Math.sqrt(dx * dx + dy * dy);
  }
}, { passive: false });
```

- [ ] **Step 2: Update touchmove for endpoint drag**

Find the single-finger touchmove section (inside `if (e.touches.length === 1 && touchStart)`). Replace it with:

```js
if (e.touches.length === 1 && touchStart) {
  if (touchDragHandle && isDragging) {
    // Endpoint drag via touch
    var fakeEvent = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    updateEndpointDrag(fakeEvent);
  } else {
    // Pan
    isTouchPanning = true;
    var t = e.touches[0];
    var rect = svg.getBoundingClientRect();
    var dx = (t.clientX - touchStart.x) / rect.width * viewBox.w;
    var dy = (t.clientY - touchStart.y) / rect.height * viewBox.h;
    viewBox.x = touchStartVB.x - dx;
    viewBox.y = touchStartVB.y - dy;
    userViewBox = true;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }
}
```

- [ ] **Step 3: Update touchend for endpoint drag commit**

In the touchend handler, inside `if (e.touches.length === 0)`, add at the very top (before the tap detection):

```js
if (touchDragHandle && isDragging) {
  commitEndpointDrag();
  touchDragHandle = null;
  if (isMobile() && selected) {
    setTimeout(function() { setSheetState('expanded'); showProperties(); }, 100);
  }
  touchStart = null;
  touchStartVB = null;
  lastPinchDist = 0;
  isTouchPanning = false;
  tapStart = null;
  return;
}
```

- [ ] **Step 4: Build verification**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/sketcher/html.ts
git commit -m "feat: mobile touch drag for wall endpoints with sheet collapse"
```

---

## Final Verification

### Task 12: End-to-end verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build check**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds, bundle < 3MB

- [ ] **Step 3: Manual testing checklist**

Open the sketcher in a browser and verify:
1. Desktop: select wall → drag endpoint → connected walls follow → snap guides appear
2. Desktop: undo/redo via Cmd+Z / Cmd+Shift+Z and toolbar buttons
3. Desktop: each tool button highlights its type, dims the rest
4. Desktop: properties panel shows editable length, angle, coordinates
5. Desktop: type new length → wall resizes; type new angle → wall rotates
6. Desktop: furniture rotation handle appears and works with 15° snap
7. Mobile: tap wall → handles appear → drag handle → movement works
8. Mobile: sheet collapses during drag, re-expands on release
9. Mobile: numeric input works as precision fallback
10. Two-tab test: edit in one, verify other updates in real-time
