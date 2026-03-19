# RoomSketcher Help MCP — Architecture

> Living architecture document for the core system. New major features get their own `docs/arch/<feature>/ARCH.md`.

## Overview

A **hybrid AI + manual floor plan sketcher** on Cloudflare Workers. It combines:

1. **Help documentation MCP** — Zendesk articles synced to D1, searchable via MCP tools
2. **AI floor plan sketcher** — Claude generates floor plans from natural language, users edit in a browser SPA, changes sync in real-time via WebSocket
3. **Design knowledge system** — Articles chunked, tagged, and indexed for AI-driven design recommendations

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                          │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  MCP Tools   │   │  REST API    │   │  Browser Sketcher   │  │
│  │  (17 tools)  │   │  /api/...    │   │  SPA /sketcher/:id  │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬────────────┘  │
│         │                  │                     │               │
│  ┌──────▼──────────────────▼─────────────────────▼───────────┐  │
│  │              Durable Objects (2)                           │  │
│  │                                                           │  │
│  │  RoomSketcherHelpMCP (McpAgent)                           │  │
│  │   ├─ MCP protocol (/mcp)                                 │  │
│  │   ├─ 17 registered tools (6 help + 9 sketch + 2 knowledge)│  │
│  │   └─ Routes sketch ops to SketchSync DO                  │  │
│  │                                                           │  │
│  │  SketchSync (Agent)                                       │  │
│  │   ├─ WebSocket connections for live editing               │  │
│  │   ├─ In-memory plan state during sessions                 │  │
│  │   ├─ Broadcasts changes to all connected browsers         │  │
│  │   └─ shouldSendProtocolMessages() → false (custom proto)  │  │
│  └──────────────┬────────────────────────────────────────────┘  │
│                 │                                               │
│       ┌─────────▼──────────┬───────────┐                       │
│       │   D1 Database      │  Cron     │                       │
│       │   ├─ articles      │  (6h)     │                       │
│       │   ├─ articles_fts  │  sync +   │                       │
│       │   ├─ categories    │  chunk +  │                       │
│       │   ├─ sections      │  tag +    │                       │
│       │   ├─ sketches      │  cleanup  │                       │
│       │   ├─ design_knowledge          │                       │
│       │   ├─ design_knowledge_fts      │                       │
│       │   ├─ agent_insights            │                       │
│       │   └─ agent_insights_fts        │                       │
│       └────────────────────┴───────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
├── index.ts                    # Worker entry + both DOs + HTTP router
├── types.ts                    # Env bindings, Zendesk types, SketchSession
├── sketch/
│   ├── types.ts                # FloorPlan schema (Zod) + Change union
│   ├── geometry.ts             # shoelaceArea, centroid, boundingBox, pointInPolygon
│   ├── changes.ts              # applyChanges() — immutable state machine
│   ├── persistence.ts          # D1 load/save/cleanup for sketches
│   ├── svg.ts                  # floorPlanToSvg() — server-side SVG renderer
│   ├── tools.ts                # 6 MCP tool handlers for sketch ops
│   ├── furniture-catalog.ts    # Furniture item catalog with standard dimensions
│   ├── furniture-symbols.ts    # Architectural top-down SVG symbol generators (~40 types)
│   ├── rasterize.ts            # svgToPng() via @cf-wasm/resvg (WASM) for preview_sketch
│   ├── defaults.ts             # applyDefaults() + DEFAULTS config + ROOM_COLORS map
│   ├── cta-config.ts           # CTA message templates, trigger config, A/B settings
│   ├── templates/
│   │   ├── studio.json         # v3 quality, fully furnished
│   │   ├── 1br-apartment.json
│   │   ├── 2br-apartment.json
│   │   ├── 3br-house.json
│   │   ├── open-plan-loft.json
│   │   └── l-shaped-home.json
│   └── *.test.ts               # Unit tests (vitest)
├── sketcher/
│   └── html.ts                 # Browser SPA (single-file HTML+CSS+JS)
├── setup/
│   ├── home.ts                 # Home/landing page HTML (feature overview, platform logos)
│   └── html.ts                 # Setup/onboarding page HTML (per-platform MCP install guides)
├── tools/
│   ├── search.ts               # FTS5 full-text search (articles)
│   ├── browse.ts               # Category/section navigation
│   ├── articles.ts             # Article retrieval by ID or URL
│   ├── knowledge.ts            # searchDesignKnowledge + logInsight handlers
│   ├── knowledge.test.ts       # Knowledge tool tests
│   └── fts.ts                  # Shared sanitizeFtsQuery() utility
├── sync/
│   ├── zendesk.ts              # Zendesk API client (paginated)
│   ├── html-to-text.ts         # HTML → plain text converter
│   ├── ingest.ts               # Sync orchestrator (chunk + tag + batch insert)
│   ├── chunker.ts              # Split articles by H2/H3 headers, deterministic IDs
│   ├── chunker.test.ts
│   ├── tagger.ts               # Keyword-based room type + design aspect tagging
│   └── tagger.test.ts
└── db/
    └── schema.sql              # D1 schema (articles, FTS, sketches, knowledge, insights)
```

---

## Durable Objects

### Why Two DOs?

McpAgent framework owns specific routes (`/mcp`, `/sse`). WebSocket connections need their own routing. Splitting them prevents protocol collisions and keeps concerns isolated.

### RoomSketcherHelpMCP (McpAgent)

- **Role:** MCP protocol handler + tool registry
- **State:** `SketchSession { sketchId?, plan?, ctaState? }`
- **Storage:** DO-internal SQLite (MCP session state only)
- **Key behavior:** Captures `x-forwarded-host` / `host` header in `onRequest()` to construct correct URLs through the proxy

### SketchSync (Agent)

- **Role:** WebSocket hub for real-time sketch editing
- **State:** `SketchSession` (in-memory via `setState`)
- **Key behavior:**
  - `onConnect` — loads plan from D1 into memory, sends to browser
  - `onMessage` — applies changes, broadcasts to all clients, persists to D1
  - `onClose` — flushes state to D1
  - `/broadcast` endpoint — internal route for MCP DO to push changes to browsers
  - `shouldSendProtocolMessages()` returns `false` — disables the Agent framework's automatic `CF_AGENT_STATE` broadcasts, using our own WebSocket protocol instead

---

## Data Model

### FloorPlan Schema (Layered)

```
FloorPlan
├── version: 1
├── id: nanoid
├── name, units (metric|imperial)
├── canvas: { width, height, gridSize }
├── walls[]
│   ├── id, start {x,y}, end {x,y}
│   ├── thickness, height, type (exterior|interior|divider)
│   └── openings[]
│       ├── id, type (door|window|opening)
│       ├── offset (along wall), width
│       └── properties { swingDirection, sillHeight, windowType }
├── rooms[]
│   ├── id, label, type (living|bedroom|kitchen|...)
│   ├── polygon [{x,y}...] (clockwise)
│   ├── color, area (auto-computed)
│   └── floor_material (future)
├── furniture[]
│   ├── id, type (from furniture catalog)
│   ├── position {x,y}, rotation
│   └── width, depth
├── annotations[] (reserved for V2)
└── metadata { created_at, updated_at, source }
```

**Coordinate system:** Origin (0,0) top-left, X right, Y down, all values in centimeters, 10cm grid snap.

### Change Types (Discriminated Union)

| Change | Fields |
|--------|--------|
| `add_wall` | wall object |
| `move_wall` | wall_id, start?, end? |
| `remove_wall` | wall_id |
| `update_wall` | wall_id, wall_type?, thickness? |
| `add_opening` | wall_id, opening object |
| `remove_opening` | wall_id, opening_id |
| `add_room` | room object |
| `rename_room` | room_id, label, room_type? (updates color when type changes) |
| `remove_room` | room_id |
| `add_furniture` | furniture item object (uses FurnitureItemSchema) |
| `move_furniture` | furniture_id, position?, rotation? |
| `remove_furniture` | furniture_id |

Changes are applied via `applyChanges(plan, changes[])` — returns a new plan object (immutable). Both server (`changes.ts`) and browser (`html.ts`) implement the full set of change handlers with consistent behavior, including color updates on room type changes via `ROOM_COLORS` lookup.

### WebSocket Protocol

```
Client → Server:
  Change | { type: 'save' } | { type: 'load', sketch_id }

Server → Client:
  { type: 'state_update', plan, svg }
  { type: 'saved', sketch_id }
  { type: 'error', message }
```

The SketchSync DO uses a custom protocol — the Agent framework's built-in `CF_AGENT_STATE` broadcasts are disabled via `shouldSendProtocolMessages() → false`.

---

## MCP Tools (17)

### Help Tools (6)

| Tool | Purpose |
|------|---------|
| `search_articles` | FTS5 search across all help articles |
| `list_categories` | Browse top-level categories with counts |
| `list_sections` | Sections within a category |
| `list_articles` | Articles within a section |
| `get_article` | Full article by ID |
| `get_article_by_url` | Full article by Zendesk URL |

### Sketch Tools (9)

| Tool | Purpose |
|------|---------|
| `generate_floor_plan` | Validate + store + render a FloorPlan JSON (description enforces: don't use if sketch exists) |
| `get_sketch` | Retrieve plan summary (walls, rooms, areas) |
| `open_sketcher` | Return browser sketcher URL |
| `update_sketch` | Apply changes + broadcast to browsers (description enforces: prefer over generate_floor_plan) |
| `preview_sketch` | Rasterize SVG to PNG and return as MCP image — visual feedback loop for agents |
| `suggest_improvements` | Spatial analysis + room-specific design knowledge from RoomSketcher guidelines |
| `export_sketch` | SVG download link or text summary |
| `list_templates` | List available floor plan templates for starting points |
| `get_template` | Get a specific template's FloorPlan JSON by ID |

### Design Knowledge Tools (2)

| Tool | Purpose |
|------|---------|
| `search_design_knowledge` | Search chunked articles + agent insights by query, room type, design aspect |
| `log_insight` | Store agent-discovered design patterns with source chunk references + confidence |

---

## Design Knowledge System

Articles from Zendesk are chunked, tagged, and indexed to power AI-driven design recommendations during floor plan creation.

### Pipeline

```
Zendesk Sync (6h cron)
  ↓
Fetch categories/sections/articles
  ↓
Batch insert articles (FTS auto-indexed)
  ↓
For each article:
  chunkArticle() → split by H2/H3 headers (deterministic IDs)
    ↓
  For each chunk:
    tagChunk() → keyword matching → room_types[] + design_aspects[]
      ↓
    INSERT design_knowledge (heading, content, tags as JSON arrays)
  ↓
Flag stale agent_insights (article updated_at > insight created_at)
```

### Chunking (`src/sync/chunker.ts`)

- Splits article HTML by `<h2>` and `<h3>` headers
- Minimum 150 characters per chunk; small chunks merge with previous
- Deterministic chunk IDs via hash of `articleId:heading` — stable across sync cycles so `agent_insights.source_chunk_ids` remain valid

### Tagging (`src/sync/tagger.ts`)

Keyword-based classification applied to each chunk during sync:

| Tag Type | Values |
|----------|--------|
| **Room types** (9) | bathroom, kitchen, bedroom, living, dining, hallway, office, outdoor, closet |
| **Design aspects** (8) | clearance, placement, workflow, dimensions, openings, fixtures, materials, color |

Some keywords require context (e.g., "sink" only tags as bathroom if bathroom-related terms are present).

### Search (`src/tools/knowledge.ts`)

`searchDesignKnowledge(db, query, options)` runs parallel FTS5 queries:
1. `design_knowledge_fts` — filtered by `room_types` / `design_aspects` JSON arrays via `json_each()`
2. `agent_insights_fts` — optionally included (default: true)

Results ranked by BM25, limited to configurable count. Content returned with up to 600 chars per chunk (increased from 300 to preserve measurement details).

`suggest_improvements` automatically calls `searchDesignKnowledge()` for each room type in the plan, appending a `DESIGN GUIDANCE` section with clearance rules, placement patterns, and workflow tips from RoomSketcher articles.

### Agent Insights

`logInsight()` stores AI-discovered patterns:
- Links to source chunks via `source_chunk_ids` (JSON array, validated against `design_knowledge`)
- Confidence score [0, 1]
- Auto-flagged as stale when source article is updated after insight creation

---

## FTS5 Search

### Shared Sanitizer (`src/tools/fts.ts`)

`sanitizeFtsQuery(query)` — used by both `search_articles` and `search_design_knowledge`:

1. Strip FTS5 operators: `"*()-^:+`
2. Collapse whitespace, trim
3. Wrap each term: `"term"*` (phrase + prefix wildcard)
4. Join with space

Example: `bathroom fixture - clearance (min)` → `"bathroom"* "fixture"* "clearance"* "min"*`

---

## Template Catalog

Six floor plan templates agents use as starting points. The agent silently picks the closest match, adapts to the user's request, and presents the finished result. The user never sees template names or knows one was used.

| Template ID | Rooms | Approx Size | Key Features |
|-------------|-------|-------------|--------------|
| `studio` | 1 + bathroom | 35–45 sqm | Open plan, single exterior wall loop |
| `1br-apartment` | 3 (living, bed, bath) | 50–65 sqm | Hallway entry, interior walls |
| `2br-apartment` | 5 (living, 2 bed, bath, kitchen) | 70–90 sqm | L-shaped hallway, open kitchen option |
| `3br-house` | 7+ (living, 3 bed, 2 bath, kitchen) | 110–140 sqm | Rectangular footprint, corridor |
| `open-plan-loft` | 2 (main space, bathroom) | 60–80 sqm | Minimal interior walls, large windows |
| `l-shaped-home` | 5+ | 90–120 sqm | Two wings at 90°, non-rectangular |

Each template is a complete, valid FloorPlan JSON file including fully connected walls, room polygons, doors, windows, and pre-placed furniture with architectural symbols. Templates were regenerated to v3 quality using RoomSketcher design knowledge research.

**Agent workflow for new sketches:** `search_design_knowledge` (per room type) → `list_templates` → pick closest match → `get_template` → adapt dimensions/rooms/furniture → `generate_floor_plan` → `preview_sketch` (visual verification) → fix issues via `update_sketch` → `preview_sketch` again if needed → `suggest_improvements` (returns spatial data + design knowledge). Tool descriptions guide agents to search design knowledge before generating and to visually verify before presenting results.

**Agent workflow for modifications:** When a sketch already exists, the agent must use `update_sketch` (not `generate_floor_plan`). The tool descriptions enforce this: `generate_floor_plan` says "do NOT call this tool if a sketch already exists", and `update_sketch` says "PREFER THIS over generate_floor_plan". The workflow is: `get_sketch` → read current state → `update_sketch` with incremental changes → `preview_sketch` (visual verification, required for structural changes, skippable for cosmetic changes like renames) → fix regressions if found → `suggest_improvements` (includes design knowledge per room type).

**Visual feedback loop:** `preview_sketch` rasterizes the SVG to a 1200px-wide PNG via `@cf-wasm/resvg` (WASM) and returns it as an MCP image content block. This gives agents pixel-level understanding of what they've built — the same feedback loop used during development with Playwright screenshots, but available as a tool.

Tool descriptions enforce the loop with nuanced iteration guidance:
- `generate_floor_plan` marks the loop as **required** — agents must not present a plan they haven't visually verified
- `preview_sketch` describes itself as "your eyes" with a 5-point checklist (wall overlaps, furniture placement, missing openings, room sizing, label readability)
- `update_sketch` requires preview after structural changes but allows skipping for cosmetic edits
- **Iteration budget:** If the user provided a reference image or detailed measurements, 1 preview check suffices. For vague descriptions, expect 1–2 fix rounds. Max 3 iterations total to keep wait time under ~30 seconds.

**Storage:** Templates are static JSON files in `src/sketch/templates/`, validated against `FloorPlanSchema` at build time.

---

## Furniture Catalog & Symbols

### Catalog (`src/sketch/furniture-catalog.ts`)

~25 common furniture items with standard dimensions:

| Room Type | Items |
|-----------|-------|
| Bedroom | bed (double), bed (single), nightstand x2, wardrobe, dresser |
| Living | sofa (3-seat), coffee table, TV unit, armchair, bookshelf |
| Kitchen | counter, sink, fridge, stove/oven, dining table, chairs |
| Bathroom | toilet, sink/vanity, bathtub, shower |
| Office | desk, office chair, bookshelf |
| Dining | dining table, chairs x4-6, sideboard |
| Hallway | shoe rack, coat hook |

### Architectural Symbols (`src/sketch/furniture-symbols.ts`)

~40 proportional top-down SVG symbol generators, one per furniture type. Each function receives `(w, h)` and returns SVG path/shape elements normalized to the item's dimensions.

| Category | Symbol Types |
|----------|-------------|
| Bedroom (5) | bed-double, bed-single, nightstand, wardrobe, dresser |
| Living (6) | sofa-3seat, coffee-table, tv-unit, armchair, bookshelf, shoe-rack |
| Kitchen (4) | kitchen-counter, kitchen-sink, fridge, stove |
| Bathroom (4) | toilet, bath-sink, bathtub, shower |
| Office (2) | desk, office-chair |
| Dining (3) | dining-table, dining-chair, sideboard |
| Hallway (1) | coat-hook |

**Rendering:** `furnitureDefsBlock()` generates a `<defs>` block with `<symbol>` elements for each type. Items render via `<use>` with position/rotation transforms. Uses `vector-effect="non-scaling-stroke"` for DPI-independent rendering. Unknown types fall back to a labeled rectangle.

**Z-order:** rooms → furniture → walls → openings → dimensions → watermark. Openings must render above walls so white gap lines work correctly.

### Furniture in the Browser Sketcher

The browser SPA (`html.ts`) also renders furniture symbols using the same `<defs>` / `<use>` pattern. Symbol definitions are embedded inline in the SPA HTML.

**Furniture-to-room assignment:** `pointInPolygon(point, polygon)` in `geometry.ts` assigns furniture items to rooms for reporting in `suggest_improvements`. Items outside all room polygons are reported as "unassigned."

**Change types:** `add_furniture`, `move_furniture`, `remove_furniture` are handled by `applyChanges()` in `changes.ts`, enabling the `update_sketch` tool to modify furniture after initial generation.

---

## Smart Defaults

Two-schema approach keeps the strict runtime schema unchanged while making agent input significantly shorter.

**FloorPlanInputSchema** (relaxed, agent-facing) → `applyDefaults()` → **FloorPlan** (strict, storage/runtime)

`applyDefaults()` lives in `src/sketch/defaults.ts` with all defaults in a `DEFAULTS` config object at the top.

| Field | Default |
|-------|---------|
| `wall.thickness` | `exterior: 20`, `interior: 10`, `divider: 5` (cm) |
| `wall.height` | `250` (cm) |
| `canvas` | Auto-computed from bounding box of all wall endpoints + 100cm padding; `gridSize: 10` |
| `room.color` | Lookup from room type → `ROOM_COLORS` palette map |
| `opening.properties.swingDirection` | `"left"` for exterior doors, `"right"` for interior |
| `opening.properties.sillHeight` | `90` for windows |
| `opening.properties.windowType` | `"double"` |
| `furniture[].rotation` | `0` |
| `metadata.source` | `"ai"` |
| `metadata.created_at/updated_at` | Auto-filled |

**Default color palette by room type (`ROOM_COLORS`):**

```
living: #E8F5E9    bedroom: #E3F2FD    kitchen: #FFF3E0
bathroom: #E0F7FA  hallway: #F5F5F5    office: #F3E5F5
dining: #FFF8E1    garage: #EFEBE9     closet: #ECEFF1
laundry: #E8EAF6   balcony: #F1F8E9    terrace: #F1F8E9
storage: #ECEFF1   utility: #ECEFF1    other: #FAFAFA
```

`ROOM_COLORS` is also used by `rename_room` change handlers (both server and browser) to update room color when the room type changes.

**Impact:** Wall input drops from 7 required fields to 4 (`id`, `start`, `end`, `type`). Room input drops from 6 to 4 (`id`, `label`, `type`, `polygon`). Canvas is fully optional. All existing code (browser sketcher, `changes.ts`, `svg.ts`, `persistence.ts`) continues to work with the strict schema — no breaking changes.

---

## CTA System

File: `src/sketch/cta-config.ts`

A configurable call-to-action system that surfaces upgrade prompts at natural moments without spamming users.

**Trigger types:**

| Category | Triggers |
|----------|----------|
| Milestone (once per session) | `first_generation`, `first_edit`, `export` |
| Context (content-based) | `suggest_improvements`, `furniture_placed`, `room:kitchen`, `room:bedroom`, `room:bathroom`, etc. |

**Session-aware throttling** via `pickCTA(trigger, sessionState)`:

1. Check if `max_ctas_per_session` (default: 3) has been reached → return null
2. Check if `cooldown_between_ctas` (default: 2 tool calls) has passed → return null
3. Filter CTAs by active variant
4. Return CTA text + URL, or null

**Session state** (`SessionCTAState`) is tracked in the MCP DO's `SketchSession` (persists in DO SQLite across conversations with the same DO instance):

```
ctasShown: number
lastCtaAt: number   // tool call counter
toolCallCount: number
```

**A/B variant support:** Active variant read from `env.CTA_VARIANT` (Cloudflare Workers env var), falling back to `settings.variant` in config. Switching variants requires only a `wrangler secret` change — no code redeploy.

**UTM structure:** All CTA URLs use `utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content={trigger-context}`.

---

## SVG Renderer

`floorPlanToSvg(plan)` renders a complete SVG with:

1. **Rooms** — colored polygons + label + area text at centroid
2. **Furniture** — architectural top-down symbols via `<defs>` / `<use>`, with position/rotation transforms; falls back to labeled rectangles for unknown types
3. **Walls** — lines with thickness by type (exterior 4px, interior 2px, divider 1px dashed)
4. **Openings** — door swing arcs, window parallel lines, plain gaps
5. **Dimensions** — wall length labels, perpendicular offset, angle-normalized (never upside-down)
6. **Watermark** — "Powered by RoomSketcher"

**Z-order:** rooms → furniture → walls → openings → dimensions → watermark. Openings must render above walls so white gap lines work correctly.

**ViewBox calculation:** Bounding box from wall endpoints + door arc endpoints + 50px padding. Arc endpoints use the same perpendicular math as rendering to ensure outward-swinging doors are never clipped.

**Door swing math:**
```
perpX = -sin(wallAngle) * dir * doorWidth
perpY =  cos(wallAngle) * dir * doorWidth
```
Where `dir = 1` (right) or `-1` (left). For a clockwise exterior perimeter, "left" always swings outward.

### SVG Rasterizer (`src/sketch/rasterize.ts`)

`svgToPng(svg, width?)` converts SVG strings to PNG using `@cf-wasm/resvg` (WASM, runs in-Worker). Default 1200px width, height auto-derived from viewBox. Used by `preview_sketch` MCP tool and `GET /api/sketches/:id/preview.png` HTTP endpoint.

---

## Browser Sketcher SPA

Single-file HTML+CSS+JS served at `/sketcher/:id`. No build step.

**Tools:** Select, Wall, Door, Window, Room
**Features:** Snap-to-grid (15px radius), pan/zoom, keyboard shortcuts (W/S/Delete/Cmd+S/Esc), real-time WebSocket sync, properties panel for selected elements, furniture rendered with architectural symbols
**State:** `plan`, `tool`, `selected`, `drawStart`, `viewBox`, `ws`
**Branding:** RoomSketcher teal/gold palette, Merriweather Sans font, logo (home link to `/`), footer CTA

**Client-side change handling:** The SPA implements all 12 change types in `applyChangeLocal()`, matching the server's `applyChanges()` behavior — including color updates on room type change via inline `ROOM_COLORS` map.

**URL strategy:** All API calls use relative paths (`/api/sketches/...`, `/ws/...`) for proxy transparency. No hardcoded origins.

### Mobile-Responsive Design

The sketcher is fully responsive with a mobile-first approach at `max-width: 768px`.

**Layout:**
- Desktop: toolbar + canvas + properties sidebar (220px)
- Mobile: full-width canvas + bottom sheet (hidden toolbar, hidden sidebar)

**Bottom Sheet** (`position: fixed`, `max-height: 60vh` portrait / `50vh` landscape):
- Three sections: actions (Save/SVG), tools (Select/Wall/Door/Window/Room), properties
- Flexbox column layout with `sheet-props` using `flex: 1; min-height: 0` for scrollable overflow
- Handle drag: swipe down 40px to collapse, up 40px to expand
- Safe area support: `env(safe-area-inset-bottom)` padding for notched devices
- Collapsed state peeks 48px (handle only)

**ViewBox-Sheet Awareness:**
The canvas viewBox adjusts based on the bottom sheet state to keep content visible:
- When sheet is expanded on mobile, extra bottom padding is added to the viewBox proportional to the sheet's overlap with the SVG area
- `preserveAspectRatio` switches to `xMidYMin meet` (top-aligned) when sheet is expanded, `xMidYMid meet` (centered) otherwise
- Sheet expand/collapse triggers a refit (`userViewBox = false` → `render()`)
- `sendChange()` always refits with sheet awareness (resets `userViewBox`)
- WebSocket `state_update` only resets `userViewBox` on initial load, not on echoed local changes

**Touch Gestures:**
- Single-finger pan: translates viewBox, sets `userViewBox = true`
- Two-finger pinch zoom: scales viewBox about midpoint, sets `userViewBox = true`
- Tap detection: <10px movement + <300ms → select element or collapse sheet
- `touch-action: none` on SVG prevents browser gesture interference

### Setup & Onboarding Pages

Two static pages for user acquisition, served from `src/setup/`.

**Home page (`/`)** — `src/setup/home.ts`
- Landing page with hero, feature grid (Generate, Edit, Design Knowledge, Export), platform logos (Claude, ChatGPT, Gemini, Perplexity), example prompts, and CTAs
- Logo+brand in header is a home link (`<a href="/">`) — consistent across all pages (home, setup, sketcher)
- All internal links are relative paths for proxy transparency

**Setup page (`/setup`)** — `src/setup/html.ts`
- MCP URL copy-to-clipboard box at top (uses absolute `env.WORKER_URL` for the MCP endpoint since users paste this into external apps)
- Expandable accordion cards with per-platform step-by-step install instructions:
  - **Claude** (recommended) — Settings > Integrations > Add Integration
  - **ChatGPT** — Settings > Apps > Connect by URL
  - **Gemini** — Gemini CLI MCP server config
  - **Perplexity** — Settings > Custom Remote Connectors
- Inline copy buttons on each URL reference
- Prerequisites noted (paid plan requirements)
- RoomSketcher Pro CTA at bottom

**URL strategy:** Internal navigation uses relative paths (`/setup`, `/health`). The MCP URL shown to users is the only absolute URL, built from `env.WORKER_URL` to ensure it shows the custom domain (`roomsketcher.kworq.com/mcp`), not the raw workers.dev URL.

---

## Data Sync (Zendesk)

- **Trigger:** Cron every 6 hours + manual `POST /admin/sync`
- **Process:** Fetch all categories/sections/articles → truncate (FK order: design_knowledge → articles → sections → categories) → batch insert → chunk articles → tag chunks → insert design_knowledge → flag stale insights → rebuild FTS
- **HTML conversion:** Custom regex-based converter (no DOM needed in Workers)
- **Article storage:** Both `body_html` (original) and `body_text` (for MCP + FTS)
- **Chunking:** Articles split by H2/H3 headers with deterministic IDs (hash of `articleId:heading`)
- **Tagging:** Keyword-based classification into room types (9) and design aspects (8)
- **Batching:** D1 batch limit of 100 statements per call; chunks flushed inline to avoid memory accumulation
- **Output:** `{ categories, sections, articles, chunks }` counts

---

## D1 Schema

```sql
-- Help documentation
categories(id, name, description, position, html_url, updated_at)
sections(id, category_id FK, name, description, position, html_url, updated_at)
articles(id, section_id FK, title, body_html, body_text, html_url, position,
         vote_sum, vote_count, promoted, draft, label_names, created_at, updated_at)
articles_fts(title, body_text)  -- FTS5 virtual table with auto-sync triggers

-- Sketches
sketches(id TEXT PK, plan_json, svg_cache, created_at, updated_at, expires_at)

-- Design knowledge (chunked articles)
design_knowledge(id, article_id FK, article_updated_at, heading, content,
                 room_types JSON, design_aspects JSON)
design_knowledge_fts(heading, content)  -- FTS5 with auto-sync triggers

-- Agent insights (AI-discovered patterns)
agent_insights(id, content, context, source_chunk_ids JSON, confidence,
               stale INTEGER, created_at, updated_at)
agent_insights_fts(content, context)  -- FTS5 with auto-sync triggers

-- Metadata
sync_meta(key PK, value)
```

Sketches auto-expire after 30 days. Cleanup runs via cron. Agent insights are auto-flagged as stale when their source article's `updated_at` exceeds the insight's `created_at`.

---

## HTTP Routes

| Route | Method | Handler |
|-------|--------|---------|
| `/` | GET | Home/landing page (feature overview, platform links) |
| `/setup` | GET | MCP setup/onboarding page (per-platform install guides) |
| `/mcp` | * | MCP protocol (McpAgent) |
| `/health` | GET | Health check + last sync time |
| `/admin/sync` | POST | Trigger Zendesk sync |
| `/api/sketches/:id/preview.png` | GET | Rasterized PNG preview (1200px wide) |
| `/api/sketches/:id` | GET | Load plan + SVG from D1 |
| `/api/sketches/:id` | PUT | Save plan to D1 |
| `/api/sketches/:id/export.pdf` | GET | Download SVG file |
| `/ws/:id` | GET (upgrade) | WebSocket → SketchSync DO |
| `/sketcher/:id` | GET | Serve sketcher SPA HTML |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two DOs (MCP + WebSocket) | McpAgent owns `/mcp` routes; WebSocket needs separate routing |
| D1 for sketches (not DO SQLite) | REST API in Worker fetch handler can't access DO-internal storage |
| Relative URLs in SPA | Proxy transparency — works through `roomsketcher.kworq.com` without CORS |
| Immutable change application | No mutation bugs; safe for concurrent edits |
| SVG caching in D1 | Avoid re-rendering on every retrieval |
| Nanoid for sketch IDs | URL-friendly, short, collision-safe with TTL |
| Single-file SPA (no build) | Zero frontend tooling; served as a template literal from Workers |
| Two-schema approach (input + strict) | Smart defaults without breaking existing code or storage schema |
| Tools not Prompts for templates | Prompts are client-initiated; agents cannot call `prompts/get` mid-conversation |
| CTA via env var (CTA_VARIANT) | Variant switching with no code redeploy — wrangler secret change only |
| `shouldSendProtocolMessages() → false` | Prevents Agent framework's `CF_AGENT_STATE` noise on WebSocket; we use our own protocol |
| Deterministic chunk IDs | Hash of `articleId:heading` stays stable across sync cycles, keeping agent_insights references valid |
| Chunking in sync pipeline | Design knowledge extracted inline during Zendesk sync, not as a separate pass |
| JSON arrays for tags | `room_types`/`design_aspects` stored as JSON, filtered via `json_each()` in FTS queries |
| `env.WORKER_URL` for MCP URL | Setup page shows custom domain, not raw workers.dev — only place absolute URLs are needed |
| Relative links in all pages | Home, setup, sketcher use relative paths for proxy transparency |
| Tool descriptions enforce update-first | `generate_floor_plan` says "don't use if sketch exists"; `update_sketch` says "prefer this" |
| `xMidYMin meet` when sheet expanded | Top-aligns content in SVG so floor plan stays visible above the bottom sheet |
| Bottom sheet peek = 100px | Includes handle + Save/SVG buttons fully visible above mobile browser chrome |
| `@cf-wasm/resvg` for rasterization | CF Workers-optimized wrapper handles WASM init pitfalls; adds ~1MB gzip to bundle (total ~1.4MB, under 3MB free tier) |
| `preview_sketch` as separate tool | Agent chooses when to verify visually; doesn't bloat every generate/update response |

---

## Known Issues

### State sync conflict
When Claude updates a sketch via MCP while a browser has it open, the SketchSync DO may have stale in-memory state. The DO should reload from D1 before applying browser changes if it detects a version mismatch. Not yet implemented.

### Floating-point coordinates
Door positions on vertical walls produce scientific notation coordinates (e.g., `6.12e-15` instead of `0`). Cosmetic only — rendering is correct.

---

## Future Work

These are identified extensions from the original build plan, ready for implementation:

### V2 — Furniture & Annotations
- **Furniture icons** — current symbols are proportional SVG shapes; future work could add photorealistic or isometric icons; link to RoomSketcher product catalog via `catalogId`; material/color variants per item; drag-and-drop placement in browser sketcher
- **Annotations** — dimension lines, text labels, symbols, arrows
- **Material finishes** — floor/wall/ceiling textures per room

### V2 — Export & Rendering
- **PDF export** — high-fidelity PDF via a proper SVG→PDF pipeline (pdf-lib attempted and reverted due to missing path fidelity for door arcs; consider Puppeteer/wkhtmltopdf or client-side jsPDF)
- **3D rendering** — Three.js or Babylon.js integration for walkthroughs; furniture items rendered as 3D models
- **Image export** — PNG/JPG rasterization

### V2 — Collaboration
- **Multi-user editing** — SketchSync DO already tracks `sketchWsClients` set; needs conflict resolution (OT or CRDT)
- **Version history** — store change log per sketch for undo/redo across sessions
- **Sharing** — public/private sketch URLs with access control

### V2 — Smarter AI
- **Room detection** — auto-detect rooms from wall topology (currently manual)
- **Snap improvements** — wall-to-wall snapping, angle constraints (45/90)
- **AI layout suggestions** — use room type + area to suggest furniture placement
- **Building code validation** — minimum door widths, egress requirements

### V2 — Design Knowledge Evolution
- **Semantic embeddings** — replace keyword tagging with vector embeddings for better search relevance
- **Insight validation** — human review workflow for agent-discovered patterns
- **Cross-article reasoning** — link related chunks across different articles

### V2 — Template Growth
- Community-submitted templates
- Region-specific templates (US vs. European layouts)
- Templates with material finishes

### V2 — CTA Evolution
- External A/B test service integration
- Per-user variant assignment
- Conversion tracking pipeline
- Dynamic CTA copy from a CMS

### Infrastructure
- **State sync fix** — SketchSync DO should check D1 version before applying in-memory changes
- **Prettier formatting** — codebase should be reformatted to match `.prettierrc` (4-space indent, no semicolons, trailing commas)
- **E2E tests** — Playwright tests for the browser sketcher
- **Rate limiting** — protect `/admin/sync` and sketch creation endpoints

---

## Deployment

**Always deploy via `deploy.sh`** — never run `wrangler deploy` directly.

The script handles the full deployment pipeline:

1. Loads `.env` file (validates `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
2. Ensures a `workers.dev` subdomain exists (creates one if needed)
3. Ensures D1 database exists (creates if needed)
4. Patches `wrangler.toml` with the real `database_id`
5. Runs D1 schema migration (`src/db/schema.sql`)
6. `npm ci` + `wrangler deploy`
7. Triggers initial Zendesk sync
8. Health check

```bash
bash deploy.sh        # uses .env
bash deploy.sh .env.staging  # custom env file
```

**Custom domain:** The worker is proxied through `roomsketcher.kworq.com` via Cloudflare DNS. The `WORKER_URL` env var in `wrangler.toml` is set to the custom domain for URL generation.
