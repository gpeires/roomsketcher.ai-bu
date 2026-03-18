# RoomSketcher Help MCP — Architecture

> Living architecture document for the core system. New major features get their own `docs/arch/<feature>/ARCH.md`.

## Overview

A **hybrid AI + manual floor plan sketcher** on Cloudflare Workers. It combines:

1. **Help documentation MCP** — Zendesk articles synced to D1, searchable via MCP tools
2. **AI floor plan sketcher** — Claude generates floor plans from natural language, users edit in a browser SPA, changes sync in real-time via WebSocket

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                          │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  MCP Tools   │   │  REST API    │   │  Browser Sketcher   │  │
│  │  (14 tools)  │   │  /api/...    │   │  SPA /sketcher/:id  │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬────────────┘  │
│         │                  │                     │               │
│  ┌──────▼──────────────────▼─────────────────────▼───────────┐  │
│  │              Durable Objects (2)                           │  │
│  │                                                           │  │
│  │  RoomSketcherHelpMCP (McpAgent)                           │  │
│  │   ├─ MCP protocol (/mcp)                                 │  │
│  │   ├─ 14 registered tools (6 help + 8 sketch)             │  │
│  │   └─ Routes sketch ops to SketchSync DO                  │  │
│  │                                                           │  │
│  │  SketchSync (Agent)                                       │  │
│  │   ├─ WebSocket connections for live editing               │  │
│  │   ├─ In-memory plan state during sessions                 │  │
│  │   └─ Broadcasts changes to all connected browsers         │  │
│  └──────────────┬────────────────────────────────────────────┘  │
│                 │                                               │
│       ┌─────────▼──────────┬───────────┐                       │
│       │   D1 Database      │  Cron     │                       │
│       │   ├─ articles      │  (6h)     │                       │
│       │   ├─ articles_fts  │  sync +   │                       │
│       │   ├─ categories    │  cleanup  │                       │
│       │   ├─ sections      │           │                       │
│       │   └─ sketches      │           │                       │
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
│   ├── svg.ts                  # floorPlanToSvg() — server-side renderer
│   ├── tools.ts                # 8 MCP tool handlers for sketch ops
│   ├── furniture-catalog.ts    # Furniture item catalog with standard dimensions
│   ├── defaults.ts             # applyDefaults() + DEFAULTS config
│   ├── cta-config.ts           # CTA message templates, trigger config, A/B settings
│   ├── templates/
│   │   ├── studio.json
│   │   ├── 1br-apartment.json
│   │   ├── 2br-apartment.json
│   │   ├── 3br-house.json
│   │   ├── open-plan-loft.json
│   │   └── l-shaped-home.json
│   └── *.test.ts               # Unit tests (vitest)
├── sketcher/
│   └── html.ts                 # Browser SPA (single-file HTML+CSS+JS)
├── tools/
│   ├── search.ts               # FTS5 full-text search
│   ├── browse.ts               # Category/section navigation
│   └── articles.ts             # Article retrieval by ID or URL
├── sync/
│   ├── zendesk.ts              # Zendesk API client (paginated)
│   ├── html-to-text.ts         # HTML → plain text converter
│   └── ingest.ts               # Sync orchestrator (truncate + batch insert)
└── db/
    └── schema.sql              # D1 schema (articles, FTS, sketches)
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
├── furniture[] (V1 — labeled rectangles)
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
| `rename_room` | room_id, label, room_type? |
| `remove_room` | room_id |
| `add_furniture` | furniture item object (uses FurnitureItemSchema) |
| `move_furniture` | furniture_id, position?, rotation? |
| `remove_furniture` | furniture_id |

Changes are applied via `applyChanges(plan, changes[])` — returns a new plan object (immutable).

### WebSocket Protocol

```
Client → Server:
  Change | { type: 'save' } | { type: 'load', sketch_id }

Server → Client:
  { type: 'state_update', plan, svg }
  { type: 'saved', sketch_id }
  { type: 'error', message }
```

---

## MCP Tools (14)

### Help Tools (6)

| Tool | Purpose |
|------|---------|
| `search_articles` | FTS5 search across all help articles |
| `list_categories` | Browse top-level categories with counts |
| `list_sections` | Sections within a category |
| `list_articles` | Articles within a section |
| `get_article` | Full article by ID |
| `get_article_by_url` | Full article by Zendesk URL |

### Sketch Tools (8)

| Tool | Purpose |
|------|---------|
| `generate_floor_plan` | Validate + store + render a FloorPlan JSON |
| `get_sketch` | Retrieve plan summary (walls, rooms, areas) |
| `open_sketcher` | Return browser sketcher URL |
| `update_sketch` | Apply changes + broadcast to browsers |
| `suggest_improvements` | AI analysis prompts for the plan |
| `export_sketch` | SVG download link or text summary |
| `list_templates` | List available floor plan templates for starting points |
| `get_template` | Get a specific template's FloorPlan JSON by ID |

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

Each template is a complete, valid FloorPlan JSON file including fully connected walls, room polygons, doors, windows, and pre-placed furniture.

**Agent workflow:** `list_templates` → pick closest match → `get_template` → adapt dimensions/rooms/furniture → `generate_floor_plan`. The `generate_floor_plan` tool description directs agents to always start from a template rather than generating coordinates from a blank canvas.

**Storage:** Templates are static JSON files in `src/sketch/templates/`, validated against `FloorPlanSchema` at build time.

---

## Furniture Catalog (V1)

~25 common furniture items with standard dimensions. Rendered as labeled rectangles in the SVG output. Templates ship fully furnished.

| Room Type | Items |
|-----------|-------|
| Bedroom | bed (double), bed (single), nightstand x2, wardrobe, dresser |
| Living | sofa (3-seat), coffee table, TV unit, armchair, bookshelf |
| Kitchen | counter, sink, fridge, stove/oven, dining table, chairs |
| Bathroom | toilet, sink/vanity, bathtub, shower |
| Office | desk, office chair, bookshelf |
| Dining | dining table, chairs x4-6, sideboard |
| Hallway | shoe rack, coat hook |

**SVG rendering:** Furniture renders as labeled rectangles — light gray fill (`#F5F5F5`), border (`#BDBDBD`), item label centered in small text. Rotation applied via SVG transform. Z-order: rooms → furniture → walls → openings → dimensions → watermark.

**Furniture-to-room assignment:** `pointInPolygon(point, polygon)` in `geometry.ts` assigns furniture items to rooms for reporting in `suggest_improvements`. Items outside all room polygons are reported as "unassigned."

**Change types:** `add_furniture`, `move_furniture`, `remove_furniture` are handled by `applyChanges()` in `changes.ts`, enabling the `update_sketch` tool to modify furniture after initial generation.

**Extension points:** `svgIcon` field (future top-down icons), `catalogId` field (future link to RoomSketcher product catalog for upsell).

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
| `room.color` | Lookup from room type → color palette map |
| `opening.properties.swingDirection` | `"left"` for exterior doors, `"right"` for interior |
| `opening.properties.sillHeight` | `90` for windows |
| `opening.properties.windowType` | `"double"` |
| `furniture[].rotation` | `0` |
| `metadata.source` | `"ai"` |
| `metadata.created_at/updated_at` | Auto-filled |

**Default color palette by room type:**

```
living: #E8F5E9    bedroom: #E3F2FD    kitchen: #FFF3E0
bathroom: #E0F7FA  hallway: #F5F5F5    office: #F3E5F5
dining: #FFF8E1    garage: #EFEBE9     closet: #ECEFF1
laundry: #E8EAF6   balcony: #F1F8E9    storage: #ECEFF1
```

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
2. **Furniture** — labeled rectangles (fill `#F5F5F5`, stroke `#BDBDBD`), rotation via transform
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

---

## Browser Sketcher SPA

Single-file HTML+CSS+JS served at `/sketcher/:id`. No build step.

**Tools:** Select, Wall, Door, Window, Room
**Features:** Snap-to-grid (15px radius), pan/zoom, keyboard shortcuts (W/S/Delete/Cmd+S/Esc), real-time WebSocket sync, properties panel for selected elements
**State:** `plan`, `tool`, `selected`, `drawStart`, `viewBox`, `ws`
**Branding:** RoomSketcher teal/gold palette, Merriweather Sans font, logo, footer CTA

**URL strategy:** All API calls use relative paths (`/api/sketches/...`, `/ws/...`) for proxy transparency. No hardcoded origins.

---

## Data Sync (Zendesk)

- **Trigger:** Cron every 6 hours + manual `POST /admin/sync`
- **Process:** Fetch all categories/sections/articles → truncate → batch insert → rebuild FTS
- **HTML conversion:** Custom regex-based converter (no DOM needed in Workers)
- **Article storage:** Both `body_html` (original) and `body_text` (for MCP + FTS)

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

-- Metadata
sync_meta(key PK, value)
```

Sketches auto-expire after 30 days. Cleanup runs via cron.

---

## HTTP Routes

| Route | Method | Handler |
|-------|--------|---------|
| `/mcp` | * | MCP protocol (McpAgent) |
| `/health` | GET | Health check + last sync time |
| `/admin/sync` | POST | Trigger Zendesk sync |
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
- **Furniture V2** — top-down SVG icons replace labeled rectangles; link to RoomSketcher product catalog via `catalogId`; material/color variants per item; drag-and-drop placement in browser sketcher
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
