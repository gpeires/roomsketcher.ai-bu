# AI-Assisted Room Sketcher — Design Spec

**Date:** 2026-03-18
**Status:** Approved
**Approach:** Hybrid (Durable Object for live sessions, D1 for persistence)

## Overview

Extend the existing RoomSketcher Help MCP server into an AI-assisted room sketching platform. Users describe rooms in natural language to Claude, Claude generates floor plans (JSON + SVG), and users can refine layouts in a lightweight browser-based sketcher with real-time sync. The sketcher serves as a funnel to the full RoomSketcher product.

### User Flow

```
User describes room in chat
  → Claude generates floor plan (SVG shown inline in chat)
  → "Want to tweak it?" → opens browser sketcher
  → User edits in browser, Claude reads changes back
  → Claude suggests improvements + upsells
  → "Want 3D? Furniture? Pro floor plans?" → RoomSketcher signup
```

### Interaction Model

**Hybrid: AI + Manual.** Claude generates an initial layout from a natural language description, then the user can open a web-based sketcher pre-loaded with that layout to manually tweak it. Claude can read changes back and push further modifications.

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────┐
│                  Cloudflare Worker                   │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  MCP Tools  │  │  REST API    │  │  Static   │  │
│  │  (6 help +  │  │  /api/sketch │  │  Sketcher │  │
│  │   6 sketch) │  │              │  │  SPA      │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  │
│         │                │                │         │
│         ▼                ▼                ▼         │
│  ┌──────────────────────────────────────────────┐   │
│  │          Durable Object (McpAgent)           │   │
│  │  - Live floor plan state (in-memory)         │   │
│  │  - WebSocket connections (browser sketcher)  │   │
│  │  - Broadcasts changes to sketch's WS clients │   │
│  │  - Reads/writes D1 via this.env.DB           │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                               │
│         ┌───────────┴───────────┐                   │
│         ▼                       ▼                   │
│  ┌─────────────┐         ┌───────────┐              │
│  │     D1      │         │ D1        │              │
│  │  (help      │         │ (sketches │              │
│  │   articles) │         │  table)   │              │
│  └─────────────┘         └───────────┘              │
└─────────────────────────────────────────────────────┘
```

### Data Flow & Storage Clarification

The system has two storage layers with distinct roles:

- **DO internal SQLite** (`this.ctx.storage.sql`, from `new_sqlite_classes`): Used exclusively by the McpAgent framework for MCP session management. **Not used for sketch data.**
- **D1** (`this.env.DB`): Shared database accessible from both the Worker fetch handler and the DO. Stores help articles (existing) and sketches (new). The DO accesses D1 through its `env` binding.
- **DO in-memory state** (`setState`/`state`): Holds the live FloorPlan during active editing sessions. This is the "hot" layer — fast reads/writes, but evicted when the DO is idle (~30s).

**Data path for sketches:**

1. DO holds live state in memory (via McpAgent `setState`)
2. DO flushes to D1 `sketches` table via `this.env.DB` (durable persistence)
3. REST API routes (`/api/sketches/:id`) read from D1 directly (Worker fetch handler)
4. When DO is evicted and reactivated, it loads from D1 into memory

**Why not DO-internal SQLite for sketches?** The REST API (used for SPA initial load) runs in the Worker's fetch handler, which cannot access a DO's internal SQLite. D1 is the shared data layer both can reach.

### Existing Infrastructure (unchanged)

- Cloudflare Worker at `roomsketcher-help-mcp`
- D1 database with categories, sections, articles (FTS5 search)
- McpAgent Durable Object with WebSocket + state management
- 6 MCP tools: search_articles, get_article, get_article_by_url, list_categories, list_sections, list_articles
- Cron trigger every 6 hours for Zendesk sync

### New Components

1. **6 new MCP tools** for floor plan generation, editing, and export
2. **Server-side SVG renderer** (`floorPlanToSvg()`)
3. **D1 `sketches` table** for persistent storage
4. **REST API** (`/api/sketches/:id`) for the browser sketcher to load/save
5. **Browser sketcher SPA** served at `/sketcher/:id`
6. **WebSocket bridge** between DO and browser for real-time sync

## Data Model

### FloorPlan JSON Schema

Organized in capability layers that mirror RoomSketcher's feature hierarchy. V1 implements layers 1-3. Everything else is a typed extension point for future versions.

```typescript
interface FloorPlan {
  version: 1;
  id: string; // nanoid
  name: string;
  units: "metric" | "imperial";
  canvas: {
    width: number; // cm
    height: number; // cm
    gridSize: number; // default 10cm, snap target
  };

  // LAYER 1: Walls (V1)
  walls: Wall[];

  // LAYER 2: Openings (V1) — nested inside walls as Wall.openings[]
  // Not a top-level array. Openings are children of the wall they sit on.

  // LAYER 3: Rooms (V1)
  rooms: Room[];

  // LAYER 4: Furniture (V2)
  furniture: FurnitureItem[];

  // LAYER 5: Annotations (V2)
  annotations: Annotation[];

  // LAYER 6: Multi-floor (future)
  // When implemented, walls/rooms/furniture move under floors[]
  // and the top-level arrays represent floor 0 (ground)

  metadata: {
    created_at: string; // ISO 8601
    updated_at: string;
    source: "ai" | "sketcher" | "mixed";
  };
}

// LAYER 1: Walls
interface Wall {
  id: string;
  start: Point; // coordinates in cm
  end: Point;
  thickness: number; // default 15cm (exterior), 10cm (interior)
  height: number; // default 250cm
  type: "exterior" | "interior" | "divider";

  // LAYER 2: Openings on this wall (V1)
  openings: Opening[];
}

interface Point {
  x: number;
  y: number;
}

interface Opening {
  id: string;
  type: "door" | "window" | "opening";
  offset: number; // distance from wall start point, in cm
  width: number; // cm
  properties: {
    // Door-specific
    swingDirection?: "left" | "right";
    swingAngle?: number; // degrees, default 90

    // Window-specific
    sillHeight?: number; // cm from floor
    windowType?: "single" | "double" | "sliding" | "bay";
  };
}

// LAYER 3: Rooms
// Rooms store polygon for rendering AND optional wall references for extensibility
// (shared walls, per-side materials, wall-room relationships).
interface Room {
  id: string;
  label: string; // "Living Room", "Kitchen"
  type: RoomType;
  polygon: Point[]; // ordered vertices forming a closed polygon (clockwise)
  wall_ids?: string[]; // optional: bounding wall IDs (for relationships, extensibility)
  color: string; // fill color (hex)
  area?: number; // auto-calculated from polygon, m2 or ft2
  floor_material?: string; // extension point for materials
}

type RoomType =
  | "living"
  | "bedroom"
  | "kitchen"
  | "bathroom"
  | "hallway"
  | "closet"
  | "laundry"
  | "office"
  | "dining"
  | "garage"
  | "balcony"
  | "terrace"
  | "storage"
  | "utility"
  | "other";

// LAYER 4: Furniture (V2)
interface FurnitureItem {
  id: string;
  type: string; // "sofa", "bed", "table", "toilet"
  catalog_id?: string; // future link to RoomSketcher catalog
  position: Point;
  rotation: number; // degrees
  width: number; // cm
  depth: number; // cm
  label?: string;
  material?: string;
}

// LAYER 5: Annotations (V2)
interface Annotation {
  id: string;
  type: "label" | "dimension" | "symbol" | "arrow";
  position: Point;
  content: string; // text, or measurement value
  rotation?: number;
  style?: {
    fontSize?: number;
    color?: string;
  };
}
```

### Room Polygon Computation

Rooms use a **dual representation**: `polygon: Point[]` for rendering, `wall_ids?: string[]` for relationships.

- **`polygon`** is the primary data for rendering and area calculation. Claude generates it directly. The browser sketcher recomputes it from wall geometry on every wall edit (planar face detection).
- **`wall_ids`** is optional metadata maintained by the sketcher. It enables future features: shared walls between rooms, per-side wall materials, "which rooms does this wall border?" queries. V1 can leave it empty — it's populated when the sketcher auto-detects rooms from closed wall loops.
- **Area calculation:** Shoelace formula on the polygon vertices. Trivial and exact.
- **Why both?** Polygon-only is simple but loses wall-room relationships. Wall-ids-only requires complex graph algorithms for rendering. Both together give us simplicity now and extensibility later.

### Design Decisions

- **All coordinates in centimeters** internally. Converted to feet/inches for display when `units === "imperial"`.
- **Walls are line segments**, not rectangles. Simpler for Claude to generate and reason about.
- **Openings live on walls** (via `offset` from start point). Matches real-world construction and RoomSketcher's model.
- **Rooms have dual representation:** `polygon` for rendering (simple, fast) + optional `wall_ids` for relationships (extensible). Neither is derived from the other at runtime — both are stored.
- **`RoomType` enum** enables smart defaults (e.g., bathroom gets default fixtures in V2).
- **`catalog_id`** on furniture is a future bridge to RoomSketcher's 7000+ item library.
- **Everything has a string `id`** (nanoid). Enables targeted updates: "move wall w3", "resize door d1".
- **Grid snapping at 10cm** default. All coordinates snap to grid for clean layouts.
- **Validated with Zod** on the server before storage. Claude's generated JSON must pass validation.
- **D1 row size limit:** D1 has a 1MB row limit. A typical residential floor plan (50 walls, 10 rooms) is ~10-20KB JSON. This is well within limits. Plans with 500+ furniture items in V2 could approach 100KB — still safe.

### D1 Schema Addition

```sql
CREATE TABLE sketches (
  id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  svg_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX idx_sketches_expires ON sketches(expires_at);
```

## MCP Tools

### New Tools (6)

#### `generate_floor_plan`

Claude generates a FloorPlan JSON from the user's description and sends it to this tool.

- **Input:** `{ plan: FloorPlan }` (the full JSON)
- **Validation:** Zod schema validation. Rejects invalid plans with helpful error messages.
- **Storage:** Saves to DO state (via `setState`) + D1 `sketches` table (via `this.env.DB`).
- **SVG:** Server-side render via `floorPlanToSvg()`.
- **Returns:** `[TextContent, ImageContent]`
  - Text: Summary (room count, total area, dimensions) + sketcher URL
  - Image: Base64-encoded SVG (`image/svg+xml`)

#### `get_sketch`

Read the current sketch state. Used after the user edits in the browser.

- **Input:** `{ sketch_id: string }`
- **Source:** DO in-memory state first. If DO was evicted, loads from D1 via `this.env.DB`.
- **Returns:** `[TextContent, ImageContent]`
  - Text: JSON summary of current layout
  - Image: Current SVG render

#### `update_sketch`

Claude pushes modifications to an existing sketch.

- **Input:** `{ sketch_id: string, changes: Change[] }` where `Change` is a union type:
  - `{ type: "add_wall", wall: Wall }`
  - `{ type: "move_wall", wall_id: string, start?: Point, end?: Point }`
  - `{ type: "remove_wall", wall_id: string }`
  - `{ type: "update_wall", wall_id: string, thickness?: number, wall_type?: WallType }`
  - `{ type: "add_opening", wall_id: string, opening: Opening }`
  - `{ type: "remove_opening", wall_id: string, opening_id: string }`
  - `{ type: "add_room", room: Room }`
  - `{ type: "rename_room", room_id: string, label: string, room_type?: RoomType }`
  - `{ type: "remove_room", room_id: string }`
- **Behavior:** Applies changes to DO state, recomputes affected room polygons, re-renders SVG, broadcasts via WebSocket to connected sketcher.
- **Returns:** `[TextContent, ImageContent]` — confirmation + updated SVG.

#### `open_sketcher`

Returns the URL for the browser-based sketcher. Also included in `generate_floor_plan` response, but available separately for returning to an existing sketch.

- **Input:** `{ sketch_id: string }`
- **Returns:** `[TextContent]` — URL: `https://<worker>/sketcher/<sketch_id>`

#### `suggest_improvements`

Returns the current floor plan as structured data along with analysis prompts. The actual analysis is done by Claude in its context window — the tool provides the data and framing, not server-side heuristics. This keeps the tool simple and leverages Claude's reasoning.

- **Input:** `{ sketch_id: string }`
- **Returns:** `[TextContent]` — Floor plan summary with dimensions, room list, and analysis prompts (room proportions, traffic flow, missing rooms, door placement). Includes natural RoomSketcher upsells woven into the analysis context.

#### `export_sketch`

Final export with download link and conversion CTA.

- **Input:** `{ sketch_id: string, format?: "svg" | "pdf" | "summary" }`
- **Formats:**
  - `svg`: Returns inline SVG image via MCP ImageContent
  - `pdf`: Generates PDF server-side (via `jspdf` + `svg2pdf.js`), returns a download URL: `https://<worker>/api/sketches/:id/export.pdf`
  - `summary`: Text-only floor plan summary
- **Returns:** `[TextContent, ImageContent?]`
  - Text: Floor plan summary + download link (if pdf) + "For 3D visualization, HD renders, and professional floor plans, try RoomSketcher: [signup link with UTM params]"
  - Image: Final SVG render (if svg format)

## Real-time Sync

### Architecture

The Durable Object serves as the real-time hub between Claude (MCP) and the browser sketcher (WebSocket).

```
Claude (MCP)                    Browser Sketcher (WebSocket)
     │                                    │
     │  update_sketch({changes})          │
     ├──────────────► DO ─────────────────┤ broadcast
     │                │                   │ (wall moved)
     │                │                   │
     │  get_sketch()  │     user drags    │
     │◄───────────────┤◄─────────────────┤ wall
     │  (reads state) │  (updates state)  │
```

### Claude → Browser (MCP tool triggers browser update)

1. Claude calls `update_sketch` with changes
2. DO applies changes to in-memory FloorPlan state
3. DO recomputes affected room polygons and areas
4. DO renders new SVG
5. DO broadcasts `{ type: "state_update", plan: FloorPlan }` to all WebSocket clients
6. Browser sketcher receives message, updates its local state, re-renders
7. Tool returns updated SVG to Claude

### Browser → Claude (user edits, Claude reads)

1. User drags a wall in the browser sketcher
2. SPA sends `{ type: "move_wall", wall_id: "w3", end: {x: 500, y: 200} }` via WebSocket
3. DO updates in-memory state, recomputes room polygons and areas
4. DO debounce-flushes to D1 (every 30 seconds during active editing)
5. User returns to Claude: "what do you think?"
6. Claude calls `get_sketch()` → reads current state from DO (includes user's edits)

### Conflict Resolution

The DO is single-threaded, so there are no data races. For logical conflicts (Claude and user editing the same wall simultaneously):

**V1: Last-write-wins.** The DO applies changes in the order they arrive. If Claude moves wall w3 via `update_sketch` while the user is dragging w3 in the browser, Claude's change arrives first (MCP tool call), the DO applies it and broadcasts to the browser, then the user's drag event arrives and overwrites it. This is acceptable for V1 because:

- Simultaneous editing of the same element is rare in practice
- The user sees the conflict immediately (their wall jumps) and can re-drag
- The flow is conversational, not collaborative — users typically alternate between chat and sketcher

**Future consideration:** If multi-user editing is added, implement operational transform or CRDT-based merging.

### WebSocket Protocol

All messages use the same `Change` type as MCP tools for consistency.

Messages from browser to DO:

```typescript
type ClientMessage =
  | Change // same union type as update_sketch
  | { type: "save" } // explicit save to D1
  | { type: "load" }; // request full state
```

Messages from DO to browser:

```typescript
type ServerMessage =
  | { type: "state_update"; plan: FloorPlan } // full state sync
  | { type: "state_delta"; changes: Change[] } // incremental (optimization)
  | { type: "saved"; updated_at: string } // D1 save confirmed
  | { type: "error"; message: string };
```

## SVG Generation

### `floorPlanToSvg(plan: FloorPlan): string`

Server-side pure function. No external dependencies. Runs in the Worker.

**Renders:**

1. **Room fills** — colored polygons from `room.polygon` with semi-transparent fills
2. **Walls** — thick strokes (exterior: 4px, interior: 2px, divider: 1px dashed)
3. **Openings** — door arcs (quarter circle indicating swing), window marks (parallel lines on wall)
4. **Dimension labels** — wall lengths as rotated text along each wall segment
5. **Room labels** — room name + area at polygon centroid (calculated from vertices)
6. **Grid** — subtle lines at `gridSize` intervals (toggleable)
7. **Watermark** — "Powered by RoomSketcher" (bottom-right, subtle)

**viewBox computation:**
The `viewBox` is calculated from the bounding box of all wall coordinates + 50cm padding on each side. It is NOT the canvas width/height — the canvas dimensions define the logical space, but the viewBox crops to actual content.

```xml
<svg viewBox="{minX-50} {minY-50} {rangeX+100} {rangeY+100}"
     xmlns="http://www.w3.org/2000/svg">
  <defs><!-- room fill patterns, fonts --></defs>
  <g id="grid"><!-- grid lines --></g>
  <g id="rooms"><!-- room fill polygons --></g>
  <g id="walls"><!-- wall line segments --></g>
  <g id="openings"><!-- door arcs, window marks --></g>
  <g id="dimensions"><!-- measurement labels --></g>
  <g id="labels"><!-- room names + areas --></g>
  <g id="watermark"><!-- branding --></g>
</svg>
```

**Dual purpose:**

1. **MCP ImageContent** — base64-encoded, returned to Claude, shown inline in chat
2. **Sketcher initial render** — browser SPA uses the same SVG structure, then attaches event handlers for interactivity

## Browser Sketcher SPA

### Technology

- **V1:** Single HTML file with inline **JavaScript** and CSS. Served by the Worker at `/sketcher/:id`. No build step required.
- **V2:** If the codebase grows beyond a single file, move to a bundled SPA using `[site]` asset binding in wrangler.toml with an esbuild/TypeScript build step.
- **Rendering:** SVG-based (not Canvas). SVG elements are DOM-selectable, CSS-stylable, and zoomable via `viewBox`.
- **No framework** in V1. Vanilla JavaScript with a simple event system.

### Capabilities (V1)

- **Pan/zoom** — mouse wheel + drag on background (transform matrix on SVG)
- **Draw walls** — click start point, click end point. Snap to grid and existing wall endpoints.
- **Select/move walls** — click wall to select, drag endpoints to reposition
- **Auto-detect rooms** — planar face detection from closed wall loops, recomputed on wall changes
- **Label rooms** — click room, type name, select type from dropdown
- **Show dimensions** — wall lengths displayed along each wall segment
- **Openings** — click a wall, add door/window at a position. Set type and width.

### Capabilities (V2)

- **Undo/redo** — browser-local history stack (array of FloorPlan snapshots). Not stored in the DO. Applies only to the current browser session. If Claude makes a change via MCP, the browser receives it as a new state and pushes it onto the undo stack.
- **Furniture palette** — small library (~20 common items: bed, sofa, table, toilet, sink, stove)
- **Drag-and-drop furniture** — from palette onto rooms
- **Rotate/resize furniture** — handles on selection
- **Labels on furniture** — optional text labels
- **Room materials** — floor color/pattern selection

### UI Layout

```
┌─────────────────────────────────────────────┐
│ [Walls] [Openings] [Rooms]  ...  [Undo][Redo]│  ← Toolbar
├───────────────────────────────────────┬─────┤
│                                       │Props│
│                                       │     │
│          SVG Canvas                   │Wall │
│          (pan/zoom)                   │thick│
│                                       │ness │
│                                       │     │
│                                       │Room │
│                                       │label│
│                                       │     │
├───────────────────────────────────────┴─────┤
│  Powered by RoomSketcher — Upgrade for 3D   │  ← Funnel CTA
└─────────────────────────────────────────────┘
```

## Persistence & State

### State Layers

| Layer         | What                                | Lifetime                             | Access Pattern              |
| ------------- | ----------------------------------- | ------------------------------------ | --------------------------- |
| DO memory     | Live floor plan (`setState`)        | While DO is active (~30s inactivity) | MCP tools + WebSocket       |
| D1 `sketches` | Durable persistence (`this.env.DB`) | 30 days (configurable TTL)           | REST API + DO fallback load |

### Load Strategy

1. DO checks in-memory state (via `this.state`)
2. If empty (DO was evicted), loads from D1 via `this.env.DB.prepare("SELECT plan_json FROM sketches WHERE id = ?").bind(sketchId)`
3. If not in D1, returns null (sketch expired or doesn't exist)

### Save Strategy

- **Explicit save:** User clicks save in sketcher, or sends `{ type: "save" }` WebSocket message
- **On disconnect:** DO flushes to D1 when last WebSocket client disconnects
- **Debounced auto-save:** Every 30 seconds during active editing
- **On MCP tool call:** `generate_floor_plan` and `update_sketch` always persist to D1

### Cleanup

The existing 6-hour cron job (Zendesk sync) also runs:

```sql
DELETE FROM sketches WHERE expires_at < datetime('now');
```

Default TTL: 30 days from last update.

## Security

### V1: Security Through Obscurity

Sketch IDs are 21-character nanoid strings (URL-safe, ~126 bits of entropy). This makes brute-force guessing infeasible. For V1, **the sketch ID serves as a bearer token** — knowing the ID grants full read/write access.

This is acceptable because:

- Sketches contain floor plan geometry, not sensitive personal data
- The URL is only shared between Claude (MCP) and the user's browser
- nanoid's entropy (21 chars, 64-char alphabet) gives ~126 bits — comparable to UUID v4

### Rate Limiting

- **Sketch creation:** No explicit rate limit in V1. The 30-day TTL + cron cleanup provides a natural ceiling on total storage. If abuse is observed, add a per-IP limit (e.g., 50 sketches/day) using Cloudflare's rate limiting.
- **WebSocket connections:** Workers have built-in connection limits per DO. No additional limiting needed in V1.
- **D1 writes:** The debounced auto-save (30s interval) naturally limits write frequency.

### Future Considerations

- **V2:** Optional authentication via Cloudflare Access or simple token-based auth for sketch persistence beyond 30 days.
- **V2:** Per-user sketch galleries require user identity — defer until there is demand.

## Funnel Strategy

### Touchpoints

1. **`generate_floor_plan` response:** "This is a 2D preview. For 3D walkthroughs and 7000+ furniture items, try RoomSketcher."
2. **`suggest_improvements` response:** Feature-specific upsells ("RoomSketcher's bay window tool would work perfectly here").
3. **`export_sketch` response:** "Download your 2D layout. For HD renders and PDF export, upgrade to RoomSketcher."
4. **Sketcher SPA:** Persistent banner at bottom: "Powered by RoomSketcher — Upgrade for 3D, furniture, and more."
5. **V2 furniture palette:** Show limited set with "500+ items in RoomSketcher Pro" teaser.

### UTM Parameters

All RoomSketcher links include tracking:

```
https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content={touchpoint}
```

Where `{touchpoint}` is one of: `generate`, `suggest`, `export`, `sketcher-banner`, `furniture-teaser`.

## HTTP Routes

### New Routes

| Method | Path                | Purpose                                                  |
| ------ | ------------------- | -------------------------------------------------------- |
| GET    | `/sketcher/:id`     | Serve the sketcher SPA                                   |
| GET    | `/api/sketches/:id` | Load sketch JSON from D1 (SPA initial load)              |
| PUT    | `/api/sketches/:id` | Save sketch JSON to D1 (REST fallback for non-WebSocket) |
| GET    | `/ws/:id`           | WebSocket upgrade for real-time sync (routes to DO)      |
| GET    | `/api/sketches/:id/export.pdf` | Download floor plan as PDF                    |

### Existing Routes (unchanged)

| Method | Path          | Purpose                  |
| ------ | ------------- | ------------------------ |
| \*     | `/mcp`        | MCP transport (McpAgent) |
| POST   | `/admin/sync` | Trigger Zendesk sync     |
| GET    | `/health`     | Health check             |

## Build Milestones

### Milestone 1: Floor Plan Generation (no sketcher)

- FloorPlan Zod schema + types
- `floorPlanToSvg()` server-side renderer
- `generate_floor_plan` MCP tool
- `get_sketch` MCP tool
- D1 `sketches` table migration
- DO state expansion (`McpAgent<Env, SketchSession, {}>`)

**Result:** Claude can generate floor plans from natural language and show them as SVG images inline in chat. No browser sketcher yet.

### Milestone 2: Browser Sketcher

- SPA served at `/sketcher/:id` (single HTML file, vanilla JS)
- REST API for load/save (`/api/sketches/:id`)
- Wall drawing tool (click-to-place, snap to grid)
- Room auto-detection (planar face detection) and labeling
- Dimension display
- `open_sketcher` MCP tool

**Result:** Users can open a URL and manually edit the AI-generated floor plan. Changes saved to D1 via REST.

### Milestone 3: Real-time Sync

- WebSocket connection between SPA and DO
- Bidirectional state broadcasting (unified Change type)
- `update_sketch` MCP tool (Claude pushes changes to browser)
- Debounced D1 flush during active editing
- `suggest_improvements` tool
- `export_sketch` tool with funnel CTAs
- Conflict resolution: last-write-wins

**Result:** Full hybrid experience. Claude and browser are in sync. The browser is a live canvas for the conversation.

### Milestone 4: Furniture & Polish (V2)

- Furniture data model and SVG rendering
- Drag-and-drop furniture palette in SPA
- Opening (door/window) placement UI in SPA
- Browser-local undo/redo (snapshot-based history stack)
- Funnel refinement (A/B test CTA copy)

## Claude Floor Plan Generation Guide

For `generate_floor_plan` to work, Claude must produce valid FloorPlan JSON. The tool description includes these rules:

### Coordinate System

- Origin (0, 0) is the top-left corner of the floor plan
- X increases rightward, Y increases downward
- All values in centimeters
- Snap to 10cm grid (all coordinates should be multiples of 10)

### Wall Construction Rules

- Build exterior walls first, forming a closed perimeter (clockwise)
- Walls connect when their endpoints share the same coordinates
- T-junctions: an interior wall's endpoint matches a point on an exterior wall
- Typical wall thicknesses: exterior 20cm, interior 10cm, divider 0cm

### Room Polygon Rules

- Polygon vertices listed clockwise
- Must form a closed shape (last vertex connects back to first)
- Polygon edges should align with wall centerlines
- Area is auto-calculated using the shoelace formula

### Example: Simple Studio Apartment (~30 sqm)

```json
{
  "version": 1,
  "id": "auto-generated",
  "name": "Studio Apartment",
  "units": "metric",
  "canvas": { "width": 1000, "height": 800, "gridSize": 10 },
  "walls": [
    {
      "id": "w1",
      "start": { "x": 0, "y": 0 },
      "end": { "x": 600, "y": 0 },
      "thickness": 20,
      "height": 250,
      "type": "exterior",
      "openings": []
    },
    {
      "id": "w2",
      "start": { "x": 600, "y": 0 },
      "end": { "x": 600, "y": 500 },
      "thickness": 20,
      "height": 250,
      "type": "exterior",
      "openings": [
        {
          "id": "d1",
          "type": "window",
          "offset": 100,
          "width": 120,
          "properties": { "sillHeight": 90, "windowType": "double" }
        }
      ]
    },
    {
      "id": "w3",
      "start": { "x": 600, "y": 500 },
      "end": { "x": 0, "y": 500 },
      "thickness": 20,
      "height": 250,
      "type": "exterior",
      "openings": [
        {
          "id": "d2",
          "type": "door",
          "offset": 200,
          "width": 90,
          "properties": { "swingDirection": "left" }
        }
      ]
    },
    {
      "id": "w4",
      "start": { "x": 0, "y": 500 },
      "end": { "x": 0, "y": 0 },
      "thickness": 20,
      "height": 250,
      "type": "exterior",
      "openings": []
    },
    {
      "id": "w5",
      "start": { "x": 400, "y": 0 },
      "end": { "x": 400, "y": 250 },
      "thickness": 10,
      "height": 250,
      "type": "interior",
      "openings": [
        {
          "id": "d3",
          "type": "door",
          "offset": 50,
          "width": 80,
          "properties": { "swingDirection": "right" }
        }
      ]
    }
  ],
  "rooms": [
    {
      "id": "r1",
      "label": "Living Area",
      "type": "living",
      "polygon": [
        { "x": 0, "y": 0 },
        { "x": 400, "y": 0 },
        { "x": 400, "y": 500 },
        { "x": 0, "y": 500 }
      ],
      "color": "#E8F5E9"
    },
    {
      "id": "r2",
      "label": "Bathroom",
      "type": "bathroom",
      "polygon": [
        { "x": 400, "y": 0 },
        { "x": 600, "y": 0 },
        { "x": 600, "y": 250 },
        { "x": 400, "y": 250 }
      ],
      "color": "#E3F2FD"
    }
  ],
  "furniture": [],
  "annotations": [],
  "metadata": {
    "created_at": "auto",
    "updated_at": "auto",
    "source": "ai"
  }
}
```

This example is included in the `generate_floor_plan` tool description so Claude has a concrete reference.

## Technology Summary

| Component          | Technology                             | Rationale                                               |
| ------------------ | -------------------------------------- | ------------------------------------------------------- |
| Runtime            | Cloudflare Workers                     | Already deployed, free tier sufficient                  |
| Live state         | Durable Object (McpAgent)              | Built-in WebSocket + state management                   |
| Persistence        | D1 (SQLite) via `this.env.DB`          | Shared access from Worker + DO, already in use          |
| DO internal SQLite | McpAgent framework only                | Not used for sketch data                                |
| MCP transport      | `agents` + `@modelcontextprotocol/sdk` | Already integrated                                      |
| SVG rendering      | Server-side pure function              | No dependencies, fast, same format as MCP ImageContent  |
| Sketcher SPA       | Vanilla JS + SVG DOM (V1)              | No build step, no framework overhead                    |
| Validation         | Zod                                    | Already a dependency, runtime + type safety             |
| IDs                | nanoid                                 | Short, URL-safe, collision-resistant, ~126 bits entropy |
| Real-time sync     | WebSocket via DO                       | Sub-millisecond latency, built into Agent framework     |
| PDF export         | `jspdf` + `svg2pdf.js`                 | Vector PDF from SVG, runs in Workers, no external APIs  |

---

## Appendix: Existing System (Complete Reference)

This appendix captures the full state of the existing codebase so this spec can be executed in a fresh context without reading the source files.

### Project Structure

```
roomsketcher-help-mcp/
├── .env.example              # Cloudflare credentials template
├── .gitignore
├── deploy.sh                 # Full deployment script (creates D1, migrates, deploys, syncs)
├── package.json
├── package-lock.json
├── tsconfig.json
├── wrangler.toml             # Cloudflare Workers config
├── docs/
│   └── superpowers/specs/    # This spec
└── src/
    ├── index.ts              # Worker entry point: McpAgent + fetch/scheduled handlers
    ├── types.ts              # Zendesk API types, D1 row types, Env interface
    ├── db/
    │   └── schema.sql        # D1 schema: categories, sections, articles, FTS5, sync_meta
    ├── sync/
    │   ├── zendesk.ts        # Zendesk API client with pagination
    │   ├── html-to-text.ts   # HTML-to-plaintext converter (no DOM, Workers-safe)
    │   └── ingest.ts         # Sync orchestration: fetch → clear → batch insert
    └── tools/
        ├── search.ts         # FTS5 search with bm25 ranking
        ├── browse.ts         # listCategories, listSections
        └── articles.ts       # listArticles, getArticle, getArticleByUrl
```

### Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "agents": "^0.7.6",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260317.1",
    "typescript": "^5.9.3",
    "wrangler": "^4.75.0"
  }
}
```

**Important version constraints:**
- `@modelcontextprotocol/sdk` must be `1.26.0` (not newer) — the `agents` package bundles SDK 1.26.0 internally, and mismatched versions cause TypeScript errors about incompatible private `_serverInfo` property.
- `agents` requires `nodejs_compat` compatibility flag in wrangler.toml for `node:async_hooks`, `node:os`, `node:diagnostics_channel` imports.

### wrangler.toml

```toml
name = "roomsketcher-help-mcp"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["0 */6 * * *"]

[[d1_databases]]
binding = "DB"
database_name = "roomsketcher-help"
database_id = "8e3843be-f977-420a-87ef-10c03e4b78e1"

[durable_objects]
bindings = [
  { name = "MCP_OBJECT", class_name = "RoomSketcherHelpMCP" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomSketcherHelpMCP"]
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

### D1 Schema (src/db/schema.sql)

```sql
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  html_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  html_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  title TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  html_url TEXT,
  position INTEGER DEFAULT 0,
  vote_sum INTEGER DEFAULT 0,
  vote_count INTEGER DEFAULT 0,
  promoted INTEGER DEFAULT 0,
  draft INTEGER DEFAULT 0,
  label_names TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  body_text,
  content='articles',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, body_text) VALUES (new.id, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body_text) VALUES ('delete', old.id, old.title, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body_text) VALUES ('delete', old.id, old.title, old.body_text);
  INSERT INTO articles_fts(rowid, title, body_text) VALUES (new.id, new.title, new.body_text);
END;

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### Env Interface (src/types.ts)

```typescript
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
}
```

### Entry Point Pattern (src/index.ts)

The McpAgent class extends `McpAgent<Env, {}, {}>` from `agents/mcp`. The three generics are:
1. `Env` — Worker environment bindings (DB, MCP_OBJECT)
2. `State` — Durable Object state (currently `{}`, will become `SketchSession`)
3. `Props` — Initialization props (currently `{}`)

Tools are registered in the `init()` method via `this.server.registerTool()`. Each tool accesses D1 via `this.env.DB`.

The Worker default export has:
- `fetch` handler: routes `/mcp` to McpAgent, `/admin/sync` to sync, `/health` to health check
- `scheduled` handler: calls `syncFromZendesk(env.DB)` on cron trigger

MCP is served via `RoomSketcherHelpMCP.serve('/mcp', { binding: 'MCP_OBJECT' })`.

### Key Implementation Patterns

**Tool registration:**
```typescript
this.server.registerTool(
  'tool_name',
  {
    description: '...',
    inputSchema: { param: z.string().describe('...') },
  },
  async ({ param }) => {
    // Access D1: this.env.DB
    // Access DO state: this.state (via setState)
    return {
      content: [{ type: 'text' as const, text: 'result' }],
    };
  },
);
```

**D1 queries:**
```typescript
// Single row
const row = await db.prepare('SELECT ... WHERE id = ?').bind(id).first<Type>();

// Multiple rows
const { results } = await db.prepare('SELECT ...').bind(param).all<Type>();

// Batch write (single transaction)
await db.batch([stmt1, stmt2, stmt3]);
```

**HTML fetch handler routing:**
```typescript
const url = new URL(request.url);
if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
  return mcpHandler.fetch(request, env, ctx);
}
```

### Deployment

The project is deployed at `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev`. The `deploy.sh` script handles:
1. Loading `.env` for `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
2. Creating/finding workers.dev subdomain via Cloudflare API
3. Creating D1 database if it doesn't exist
4. Patching `wrangler.toml` with the real `database_id`
5. Running schema migration (`wrangler d1 execute --remote`)
6. Deploying the Worker (`wrangler deploy`)
7. Triggering initial sync (`POST /admin/sync`)
8. Health check

### Known Issues & Learnings

- **MCP SDK version:** Must pin to `1.26.0` to match `agents` package's bundled version. Newer versions cause TS errors.
- **Zendesk API:** Requires explicit `Accept: application/json` header or returns 415.
- **D1 variable limits:** Cannot use `NOT IN (?)` with >100 bind params. Use delete-all + batch insert instead.
- **DO migrations:** Must use `new_sqlite_classes` (not `new_classes`) in wrangler.toml for McpAgent.
- **Workers compatibility:** `nodejs_compat` flag is required for the `agents` package's Node.js imports.
