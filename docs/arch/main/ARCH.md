# RoomSketcher Help MCP — Architecture

> Living architecture document for the core system. New major features get their own `docs/arch/<feature>/ARCH.md`.

## Overview

A **hybrid AI + manual floor plan sketcher** on Cloudflare Workers with a computer vision pipeline on Hetzner. It combines:

1. **Help documentation MCP** — Zendesk articles synced to D1, searchable via MCP tools
2. **AI floor plan sketcher** — Claude generates floor plans from natural language, users edit in a browser SPA, changes sync in real-time via WebSocket
3. **Design knowledge system** — Articles chunked, tagged, and indexed for AI-driven design recommendations
4. **CV floor plan extraction** — OpenCV + Tesseract pipeline on Hetzner that analyzes floor plan images and extracts room geometries, labels, and dimensions
5. **Claude-driven Copy Mode** — CV provides measured geometry, Claude interprets the image and drives sketch construction directly (AI specialists removed — see System Audit section)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                          │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  MCP Tools   │   │  REST API    │   │  Browser Sketcher   │  │
│  │  (18 tools)  │   │  /api/...    │   │  SPA /sketcher/:id  │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬────────────┘  │
│         │                  │                     │               │
│  ┌──────▼──────────────────▼─────────────────────▼───────────┐  │
│  │              Durable Objects (2)                           │  │
│  │                                                           │  │
│  │  RoomSketcherHelpMCP (McpAgent)                           │  │
│  │   ├─ MCP protocol (/mcp)                                 │  │
│  │   ├─ 18 registered tools (6 help + 10 sketch + 2 knowledge)│
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
│       │   ├─ uploaded_images           │                       │
│       │   ├─ design_knowledge          │                       │
│       │   ├─ design_knowledge_fts      │                       │
│       │   ├─ agent_insights            │                       │
│       │   └─ agent_insights_fts        │                       │
│       └────────────────────┴───────────┘                       │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTP (cv.kworq.com:8100)
                              ▼
                 ┌────────────────────────┐
                 │   Hetzner Server       │
                 │   (Docker)             │
                 │                        │
                 │   FastAPI CV Service   │
                 │   ├─ /health           │
                 │   ├─ /analyze          │
                 │   ├─ /sweep            │
                 │   ├─ 23 strategies     │
                 │   │  multi-strategy    │
                 │   │  room-level merge  │
                 │   ├─ OpenCV pipeline   │
                 │   └─ Tesseract OCR     │
                 └────────────────────────┘

         (AI specialists REMOVED — see System Audit section)
         Claude interprets image + CV data directly
```

---

## Development

### Commands

```bash
# Worker (Cloudflare)
npm run dev                    # Local dev server (wrangler dev)
npm test                       # Run vitest tests (272 tests)
bash deploy.sh                 # Deploy to production (NEVER use wrangler deploy directly)

# DB migrations
npm run db:migrate             # Apply schema locally
npm run db:migrate:remote      # Apply schema to production D1

# CV service (Hetzner)
cd cv-service && .venv/bin/python -m pytest -v  # Run CV pipeline tests (235 tests)
cd cv-service && docker compose up --build   # Run locally
bash cv-service/deploy-hetzner.sh <server-ip> [ssh-key]  # Deploy to Hetzner
```

### Deploy rules

- **Always use `bash deploy.sh`** for the Worker — it loads `.env` credentials, ensures the D1 database exists, runs schema migrations, deploys, triggers a Zendesk sync, and runs a health check. Running `wrangler deploy` directly will fail (no `CLOUDFLARE_API_TOKEN` in shell).
- **CV service:** `bash cv-service/deploy-hetzner.sh <ip>` — rsyncs code, builds Docker image on server, restarts container, verifies health.

### Environment

The `.env` file (not committed) must contain:
```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
# REPLICATE_API_TOKEN removed — SAM2 evaluated and rejected (see Outline Extraction section)
```

`wrangler.toml` contains non-secret config:
- `WORKER_URL` — public domain (`https://roomsketcher.kworq.com`)
- `CV_SERVICE_URL` — CV service endpoint (`http://cv.kworq.com:8100`)

---

## File Structure

```
src/
├── index.ts                    # Worker entry + both DOs + HTTP router
├── types.ts                    # Env bindings, Zendesk types, SketchSession
├── sketch/
│   ├── types.ts                # FloorPlan schema (Zod) + Change union
│   ├── compile-layout.ts       # SimpleFloorPlanInput → FloorPlan compiler (room-first → walls, classifyWallType probe, computeEnvelope)
│   ├── geometry.ts             # shoelaceArea, centroid, boundingBox, pointInPolygon, wallQuad, polygonBoundingBox, rasterizeToGrid, traceContour, offsetAxisAlignedPolygon
│   ├── changes.ts              # applyChanges() — immutable state machine (15 change types incl. set_envelope)
│   ├── resolve.ts              # Label→ID resolution layer (findRoomByLabel, findRoomWalls, findSharedWall, resolvePosition)
│   ├── high-level-changes.ts   # 15 high-level change schemas + compiler → low-level changes + processChanges()
│   ├── persistence.ts          # D1 load/save/cleanup for sketches
│   ├── svg.ts                  # floorPlanToSvg() — server-side SVG renderer (envelope-based or legacy wall rendering)
│   ├── tools.ts                # 7 MCP tool handlers for sketch ops + CV analyze
│   ├── furniture-catalog.ts    # Furniture item catalog with standard dimensions
│   ├── furniture-symbols.ts    # Architectural top-down SVG symbol generators (~40 types, incl. dishwasher, washer-dryer, aliases)
│   ├── rasterize.ts            # svgToPng() via @cf-wasm/resvg (WASM) for preview_sketch
│   ├── defaults.ts             # applyDefaults() + DEFAULTS config + ROOM_COLORS map + ENVELOPE_GAP_THRESHOLD
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
│   ├── html.ts                 # Setup/onboarding page HTML (per-platform MCP install guides)
│   └── upload.ts               # Image upload page HTML (drag-drop, paste, URL output for CV)
├── tools/
│   ├── search.ts               # FTS5 full-text search (articles)
│   ├── browse.ts               # Category/section navigation
│   ├── articles.ts             # Article retrieval by ID or URL
│   ├── knowledge.ts            # searchDesignKnowledge + logInsight handlers
│   ├── knowledge.test.ts       # Knowledge tool tests
│   └── fts.ts                  # Shared sanitizeFtsQuery() utility
├── ai/
│   ├── orchestrator.ts          # Image fetch, CV service call (specialist dispatch legacy, bypassed)
│   ├── merge.ts                 # Label normalization, deduplication (bypassed in Copy Mode)
│   ├── specialists.ts           # Prompts + response parsers for vision specialists (bypassed)
│   ├── validate.ts              # Merged result validation (bypassed)
│   ├── convert.ts               # pipelineToSketchInput() + cvToSketchInput() — CV→sketch converter
│   ├── types.ts                 # CVResult, MergedRoom, GatherResults, PipelineOutput, PipelineConfig
│   ├── parse-json.ts            # JSON repair (jsonrepair lib) + error handling
│   └── __tests__/
│       ├── merge.test.ts        # Centroid matching, label normalization, dedup tests
│       ├── orchestrator.test.ts # Image fetching, CV service integration tests
│       ├── parse-json.test.ts   # JSON repair tests
│       ├── specialists.test.ts  # Prompt + parser tests
│       └── validate.test.ts     # Validation logic tests
├── sync/
│   ├── zendesk.ts              # Zendesk API client (paginated)
│   ├── html-to-text.ts         # HTML → plain text converter
│   ├── ingest.ts               # Sync orchestrator (chunk + tag + batch insert)
│   ├── chunker.ts              # Split articles by H2/H3 headers, deterministic IDs
│   ├── chunker.test.ts
│   ├── tagger.ts               # Keyword-based room type + design aspect tagging
│   └── tagger.test.ts
└── db/
    └── schema.sql              # D1 schema (articles, FTS, sketches, knowledge, insights, uploaded_images)

cv-service/                     # Python CV pipeline (deployed to Hetzner via Docker)
├── app.py                      # FastAPI entry — /health, /analyze endpoints
├── cv/
│   ├── __init__.py
│   ├── pipeline.py             # Orchestrator — multi-strategy merge, EXCLUDED_STRATEGIES, sweep
│   ├── strategies.py           # 28 preprocessing strategies (STRATEGIES registry, StrategyResult)
│   ├── merge.py                # Composable merge pipeline — step registry, structural detection (distance transform), polygon refinement, wall thickness capping (cap_wall_thickness_cm), dilation capping (_safe_dilation)
│   ├── enhance.py              # Image enhancement (CLAHE + bilateral filter + unsharp mask)
│   ├── preprocess.py           # Binary wall mask extraction (threshold + edge fallback)
│   ├── walls.py                # Wall line detection via morphological extraction
│   ├── rooms.py                # Room detection (adaptive closing kernel) + polygon extraction + closed mask export
│   ├── openings.py             # Door detection (wall-gap scanning) + window detection (exterior breaks)
│   ├── topology.py             # Room adjacency via mask dilation overlap
│   ├── ocr.py                  # Tesseract OCR + merge_nearby_text() for split dimension reassembly
│   ├── dimensions.py           # Parse metric/imperial/compound dimensions to cm
│   ├── outline.py              # Building outline extraction (OpenCV morphological + orthogonal regularization) + spatial grid (ASCII room layout map)
│   └── output.py               # Map CV detections to SimpleFloorPlanInput JSON (rect or polygon), label filtering (_is_room_label, _DIM_LIKE, _FIXTURE_ABBREVS, _LOGO_WORDS), ghost room filtering
├── tests/
│   ├── conftest.py             # Synthetic floor plan image fixtures (2-room, L-shaped, low-contrast)
│   ├── test_app.py             # FastAPI endpoint tests
│   ├── test_enhance.py         # Enhancement algorithm + pick_winner tests (10 tests)
│   ├── test_merge.py           # Room clustering, bbox IoU, assemble_rooms, merge pipeline, wall thickness capping, dilation capping tests
│   ├── test_strategies.py      # Strategy output format/shape tests
│   ├── test_sweep.py           # Sweep endpoint + single-strategy pipeline tests
│   ├── test_pipeline.py        # Pipeline integration tests (incl. multi-strategy merge, confidence)
│   ├── test_rooms.py           # Room detection + polygon extraction tests
│   ├── test_openings.py        # Door/window detection tests
│   ├── test_topology.py        # Adjacency detection tests
│   ├── test_dimensions.py      # Dimension parsing tests (metric, imperial, compound)
│   ├── test_ocr.py             # OCR + text merging tests
│   ├── test_output.py          # Output formatting tests
│   ├── test_preprocess.py      # Wall mask extraction tests
│   └── test_walls.py           # Wall segment tests
├── Dockerfile                  # Python 3.11 + Tesseract + OpenCV
├── docker-compose.yml          # Single-service compose
├── deploy-hetzner.sh           # One-command deploy: rsync + copy .env + docker compose up
└── requirements.txt            # FastAPI, OpenCV, pytesseract, httpx
```

---

## Durable Objects

### Why Two DOs?

McpAgent framework owns specific routes (`/mcp`, `/sse`). WebSocket connections need their own routing. Splitting them prevents protocol collisions and keeps concerns isolated.

### RoomSketcherHelpMCP (McpAgent)

- **Role:** MCP protocol handler + tool registry
- **State:** `SketchSession { sketchId?, plan?, ctaState?, sourceImageUrl? }`
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
├── envelope? [{x,y}...] (optional — outer building boundary polygon, computed by compileLayout)
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
└── metadata { created_at, updated_at, source, source_image_url? }
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
| `update_room` | room_id, polygon?, area? |
| `add_furniture` | furniture item object (uses FurnitureItemSchema) |
| `move_furniture` | furniture_id, position?, rotation? |
| `remove_furniture` | furniture_id |
| `set_envelope` | polygon (Point[]) — sets building outline directly |

Changes are applied via `applyChanges(plan, changes[])` — returns a new plan object (immutable). Both server (`changes.ts`) and browser (`html.ts`) implement the full set of change handlers with consistent behavior, including color updates on room type changes via `ROOM_COLORS` lookup.

### SVG Rendering (Two Renderers)

Both renderers must stay in sync — they render the same FloorPlan data.

**Server-side** (`src/sketch/svg.ts`): Used by `floorPlanToSvg()` → `preview_sketch` (rasterized to PNG via resvg) and `export_sketch`. Pure string concatenation.

**Browser-side** (`src/sketcher/html.ts`): Used by the interactive sketcher SPA. Vanilla JS (embedded in template string). Includes selection highlighting, drag handles, tool modes.

**Envelope rendering (as of 2026-03-22):**

When `plan.envelope` exists, the renderer uses the **envelope-minus-rooms** model:
1. **Structure layer** (`<g id="structure">`): Envelope polygon filled `#333` (structural mass), then room polygons filled with room colors on top (cutouts via painters model)
2. **Walls layer** (`<g id="walls">`): Only interior/divider walls rendered as thin `<line>` elements — exterior walls are implicit in the envelope shape
3. **Openings layer**: Openings on both interior and exterior walls cut gaps
4. **Room labels layer** (`<g id="room-labels">`): Labels rendered separately (not embedded in room polygons)
5. No junction circles needed — envelope provides continuous structural mass

The envelope is computed by `computeEnvelope()` in `compile-layout.ts`:
- Rasterize all room polygons onto a 10cm boolean grid
- Morphological close (dilate then erode) on padded grid to bridge gaps < 50cm between rooms
- Trace contour of the filled grid to extract axis-aligned polygon
- Offset polygon outward by exterior wall thickness

**Legacy rendering (fallback when no envelope):**
- Exterior walls → `<polygon>` elements using `wallQuad()` (4-point quad). Fill `#333`.
- Interior walls → `<line>` elements with `stroke-width="2"`.
- Divider walls → `<line>` elements with dashed stroke.
- Junction circles at shared **exterior** wall endpoints fill corner gaps.
- Room polygons rendered with fill + labels inline.
- Openings: gap width = `thickness + 2` for exterior walls, `6` for interior walls.

**Wall type classification** (`compile-layout.ts`):
- Shared edges (two rooms touch at aligned edges) → `interior` walls. Detected via `findSharedEdges()` which finds overlapping opposing edges within `SNAP_TOLERANCE` (20cm).
- Non-shared edges → classified by `classifyWallType()`, which probes a point 5cm to each side of the wall midpoint. If both sides are inside a room rectangle (with 1cm boundary tolerance), the wall is `interior`; otherwise `exterior`. This correctly handles rooms embedded inside larger rooms (e.g., W/D and CL 2 surrounded by Bedroom 2) where edges don't align but the wall is still internal to the building.
- Before this fix, ALL non-shared edges were classified as `exterior`, causing thick polygon walls around small internal rooms like closets and laundry rooms.

**Element attributes:** All SVG elements have `data-id` (element ID) and `data-type` (`"wall"`, `"room"`, `"opening"`, `"furniture"`). These are required for:
- Incremental updates via `update_sketch` (agent can target specific elements)
- Browser sketcher selection/interaction (CSS selectors use `[data-type="wall"]`)
- Drag handle logic (polygon walls update `points` attribute, divider lines update `x1/y1/x2/y2`)

**Geometry utility** (`src/sketch/geometry.ts`):
- `wallQuad(wall)` → `[Point, Point, Point, Point]` — compute the 4-corner polygon
- `boundingBox(walls, envelope?)` — when envelope present, uses envelope bounds (no thickness expansion needed); otherwise expands by max exterior wall thickness / 2
- `polygonBoundingBox(polygon)` → `{ minX, minY, maxX, maxY }` — tight bounds on polygon vertices
- `rasterizeToGrid(polygons, gridSize)` → boolean 2D array — rasterizes axis-aligned polygons via point-in-polygon at cell centers
- `traceContour(grid, originX, originY, gridSize)` → `Point[]` — boundary-following on grid edges, produces axis-aligned polygon
- `offsetAxisAlignedPolygon(polygon, distance)` → `Point[]` — outward expansion with winding-aware normal computation (handles both CW/CCW)
- Browser renderer has vanilla JS equivalent: `wallQuadPoints(w)` → returns points string directly

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

## MCP Tools (18)

### Help Tools (6)

| Tool | Purpose |
|------|---------|
| `search_articles` | FTS5 search across all help articles |
| `list_categories` | Browse top-level categories with counts |
| `list_sections` | Sections within a category |
| `list_articles` | Articles within a section |
| `get_article` | Full article by ID |
| `get_article_by_url` | Full article by Zendesk URL |

### Sketch Tools (10)

| Tool | Purpose |
|------|---------|
| `generate_floor_plan` | Validate + store + render a FloorPlan JSON (description enforces: don't use if sketch exists) |
| `analyze_floor_plan_image` | Send image to CV service, return source image + extracted room JSON as MCP content blocks |
| `get_sketch` | Retrieve plan summary (walls, rooms, areas) |
| `open_sketcher` | Return browser sketcher URL |
| `update_sketch` | Apply low-level changes (by ID) and/or high-level changes (by label) + broadcast to browsers |
| `preview_sketch` | Rasterize SVG to PNG + optional source image for side-by-side comparison |
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

## CV Floor Plan Extraction

### Architecture

The CV pipeline runs as a **FastAPI service on a Hetzner VPS**, deployed via Docker. The Cloudflare Worker calls it over HTTP.

```
User uploads image → /upload page → stored in D1 (uploaded_images)
                                       ↓
Agent calls analyze_floor_plan_image → Worker fetches image from D1
                                       ↓
                                     Worker POSTs to cv.kworq.com:8100/analyze
                                       ↓
                                     CV service fetches image_url (or accepts base64)
                                       ↓
                                     OpenCV pipeline → rooms, walls, text regions
                                       ↓
                                     JSON response → Worker formats result
                                       ↓
                                     Returns: source image (MCP image block) + CV JSON (text block)
```

**Why Hetzner, not Cloudflare Workers?** OpenCV and Tesseract require native binaries (~200MB) that can't run in Workers. The CV service needs a real Linux environment with apt-get packages.

**Why a domain, not a bare IP?** Cloudflare Workers cannot `fetch()` to raw IP addresses (error 1003). The Hetzner box is exposed via a DNS A record (`cv.kworq.com` → server IP, DNS-only / grey cloud). Port 8100 works fine with a domain — the restriction is on IPs, not ports.

**Why return the image inline?** Claude Desktop and other MCP clients can't always fetch arbitrary URLs. By returning the source image as an MCP `image` content block alongside the CV JSON, the agent can visually verify the extraction without needing to download the image separately.

### CV Pipeline (`cv-service/cv/pipeline.py`)

The pipeline uses **multi-strategy room-level merging**: run 23 preprocessing strategies in parallel, detect rooms per strategy, run the composable merge pipeline (bbox filtering, clustering, structural detection via distance transform, polygon refinement at thick walls), then run the full pipeline once on an anchor strategy's binary mask. Wall thickness data (`wall_thickness`) is included in the API response.

```
analyze_image(image)
  ├── Step 1: Run 23 strategies in parallel → binary masks
  │   (EXCLUDED_STRATEGIES: lab_a_channel, lab_b_channel, saturation, top_hat_otsu, black_hat)
  ├── Step 2: detect_rooms() per strategy in parallel → rooms per strategy
  ├── Step 3: Merge pipeline (composable step registry)
  │   ├── bbox_filter_pre — consensus floor plan bbox (median of per-strategy bboxes),
  │   │                      removes rooms with centroids outside it (eliminates false rooms
  │   │                      from logos, headers, dimension text)
  │   ├── cluster — cluster spatially overlapping rooms across strategies
  │   │   ├── Pool all rooms tagged with source strategy
  │   │   ├── Sort by area descending (largest = best representative)
  │   │   ├── Greedy clustering: IoU >= 0.3 or centroid distance < 15% diagonal
  │   │   └── Confidence: 5+ strategies=0.9, 3-4=0.7, 2=0.5, 1=0.3
  │   ├── bbox_filter_post — safety net re-check of clustered room centroids
  │   ├── structural_detect — distance-transform wall thickness profiling, column/thick-wall/perimeter classification
  │   └── polygon_refine — dilate thick wall regions (capped at 8px via _safe_dilation),
  │                        re-trace room contours, split merged rooms
  │   MergeContext carries shared state: strategy bboxes, consensus bbox, anchor, columns
  │   MergeStepResult reports rooms kept, removed, per-step diagnostics
  │   Steps excludable via EXCLUDED_MERGE_STEPS for debugging/testing
  ├── Step 4: Pick anchor strategy (closest to median room count) for walls/openings/scale
  ├── Step 5: _run_pipeline(anchor_mask, clustered_rooms) → full pipeline
  └── Step 6: Attach confidence/found_by to output rooms, merge metadata

_run_pipeline(image, binary_override?, rooms_override?)
  ├── prepare(image) or use binary_override
  ├── find_floor_plan_bbox(binary) → crop region excluding headers/legends
  ├── detect_walls(binary)        → wall segments [{start, end, thickness}]
  ├── detect_rooms(binary)        → (rooms, closed_binary) — still runs for closed_binary even with override
  ├── extract_text_regions(image) → OCR results [{text, center}] (with text merging)
  ├── _calibrate_scale(walls, text_regions) → cm-per-pixel scale factor
  ├── detect_openings(binary, closed, rooms, walls, scale)
  ├── detect_adjacency(rooms, binary)
  ├── build_floor_plan_input(rooms, text, scale, openings, adjacency) → JSON
  │   ├── _assign_labels() — mask containment + nearest centroid, picks best single label
  │   │   └── No fallback: if all candidates fail _is_room_label(), room gets "Room N" (not noise text)
  │   ├── Ghost room filter — removes negative coords, <0.5% image area, centroid outside bbox
  │   └── _is_room_label() — rejects dimensions (_DIM_LIKE), fixture abbrevs, logos, all-caps non-room
  ├── cap_wall_thickness_cm() on output: interior 5-20cm, exterior 10-40cm
  ├── extract_outline(binary, scale, fp_bbox, epsilon_override?) → OpenCV contour + orthogonal regularization → building perimeter polygon (cm, origin-normalized)
  └── build_spatial_grid(rooms, text_regions, scale, fp_bbox) → ASCII room layout map
```

**Why room-level merging, not wall-level?** Bitwise OR of wall masks is destructive — accumulated wall noise from many strategies fills room interiors, destroying rooms. Room-level clustering is monotonic: it can only ADD rooms, never destroy them. On the critical 520 W 23rd test image, wall-level merge produced 0 rooms from 13 contributing strategies; room-level merge recovered 3 real rooms (earlier baseline of 5 included 2 margin artifacts that `bbox_filter_pre` now correctly removes).

**Sweep endpoint** (`/sweep`): Runs all 28 strategies (including excluded ones) and returns per-strategy results with debug binary masks. Used for diagnostics and strategy evaluation.

**Output JSON structure:**
```json
{
  "name": "Extracted Floor Plan",
  "rooms": [
    {"label": "Kitchen", "x": 0, "y": 0, "width": 300, "depth": 250},
    {"label": "Living", "polygon": [{"x": 300, "y": 0}, ...]}
  ],
  "openings": [
    {"type": "door", "between": ["Kitchen", "Living"], "width": 80},
    {"type": "window", "room": "Bedroom", "wall": "north", "width": 120}
  ],
  "adjacency": [
    {"rooms": ["Kitchen", "Living"], "shared_edge": "vertical", "length_cm": 300}
  ],
  "outline": [
    {"x": 0, "y": 0}, {"x": 500, "y": 0}, {"x": 500, "y": 480},
    {"x": 730, "y": 480}, {"x": 730, "y": 850}, {"x": 0, "y": 850}
  ],
  "spatial_grid": {
    "grid": ["KT KT ·  BR BR", "LV LV ·  BR BR", "LV LV BA BA ·"],
    "legend": {"KT": "Kitchen (11'8\" x 9'8\")", "LV": "Living Room", "BR": "Bedroom", "BA": "Bath"},
    "cell_size_cm": 30,
    "origin": {"x": 0, "y": 0},
    "size": {"cols": 5, "rows": 3}
  },
  "meta": {
    "image_size": [1200, 800],
    "scale_cm_per_px": 1.25,
    "scale_confidence": "measured",
    "walls_detected": 12,
    "rooms_detected": 5,
    "text_regions": 15,
    "openings_detected": 4
  }
}
```

Rooms are emitted as **rect** (`{x, y, width, depth}`) when the room is rectangular (mask area / bbox area ≥ 0.85) or **polygon** (`{polygon: [{x,y}...]}`) for L-shaped/irregular rooms. Both formats are accepted by `SimpleFloorPlanInputSchema` in `compile-layout.ts`. Coordinates are normalized to the floor plan bbox origin so rooms start near (0,0).

### Input Normalization (`cv-service/cv/preprocess.py`)

**Letterbox removal** (`remove_letterbox()`) runs before any strategy or binarization. Real-world floor plan images often have black bars on sides/top/bottom (letterboxing from PDF rendering, scanning, or marketing materials). These bars contaminate threshold-based binarization — on the 520 W 23rd test image, black sidebars caused raw/otsu/downscale/multi_scale strategies to produce ~40% wall density and detect 0 rooms. After letterbox removal, `raw` detects 5 rooms at 6.7% density.

Algorithm: scan inward from each edge in 10px strips. If a strip is uniformly dark (mean < 30, std < 15), classify as letterbox. Fill with white (255). Scan depth limited to 1/3 of image from each edge. Applied once in `analyze_image()` and `run_single_strategy()` before the image reaches any strategy.

### Preprocessing (`cv-service/cv/preprocess.py`)

Two-pass wall mask extraction:

1. **Threshold pass** (fast, for clean plans with dark walls):
   - Strict binary threshold (< 50) for near-black pixels
   - Adaptive threshold restricted to dark pixels (< 80) for robustness
   - Combined with OR

2. **Edge pass** (fallback when < 1% wall pixels found):
   - Otsu's method for automatic foreground/background separation
   - Canny edge detection + morphological thickening
   - Combined for filled regions + reinforced boundaries

3. **Component filtering** — removes noise blobs while keeping elongated wall-like segments (aspect ratio > 3)

4. **Floor plan bbox** — density-based detection of the actual floor plan region, excluding header/legend areas. Uses row/column pixel density at 15% of peak threshold.

### Room Detection (`cv-service/cv/rooms.py`)

1. **Close door gaps** — morphological close with an **adaptive** kernel sized to span realistic door openings. Base size: 15–80px (image_dim/10). `_estimate_wall_thickness()` samples 50 rows for median horizontal wall run-length, then reduces kernel when walls are thick relative to image size: >1.5% → 60% of base, >1% → 80% of base. This prevents thick-walled plans from having small rooms (closets, bathrooms) swallowed by the closing operation. Returns `(rooms, closed_binary)` — the closed mask is reused by opening detection.
2. **Invert** — rooms become white regions
3. **Connected components** — each region with area > 0.5% of image area becomes a room (lowered from 1% to recover closets and small bathrooms)
4. **Polygon extraction** — `cv2.findContours` + `cv2.approxPolyDP` (epsilon = 1.5% of perimeter) extracts a simplified polygon from each room's mask. Vertices are snapped to a 5px grid and corrected to rectilinear (90-degree angles) via a two-pass snap that aligns near-horizontal/vertical edges. This captures L-shapes, T-shapes, and irregular rooms that a bounding box would miss.
5. **Output** — bbox, centroid, area, binary mask, and polygon per room

### Opening Detection (`cv-service/cv/openings.py`)

**Door detection** — scans wall segments detected from the closed mask (which has door gaps bridged) against the original binary mask. Breaks in the original where the closed mask has wall pixels are door candidates. For each gap:
- Filter by size (8px minimum, max 1/3 image width)
- Look 30-120px perpendicular to the gap to find rooms on both sides
- Only emit as a door if it connects two distinct rooms

**Window detection** — scans exterior wall segments for gaps in the binary mask. A wall is classified as exterior if it's near the image edge or has a room on only one side. Gaps in exterior walls are window candidates, filtered by reasonable size (40-300cm). Each window is assigned to the nearest room and given a wall side (north/south/east/west).

### Room Adjacency (`cv-service/cv/topology.py`)

For each pair of rooms, dilates both masks by wall thickness (15px) and checks for overlap. If the dilated masks overlap:
- The overlap region's shape determines orientation (wider = horizontal shared wall, taller = vertical)
- Shared wall length and center are extracted
- Output includes room indices, orientation, length, and center position

This tells the agent which rooms share walls and how the layout connects — critical for reconstructing the floor plan's perimeter topology.

### Label Assignment (`cv-service/cv/output.py`)

1. **Filter text regions** — exclude dimension strings, single characters, and text outside the floor plan bbox
2. **Assign to rooms** — three-tier fallback:
   - Primary: check if label center falls inside room's binary mask
   - Fallback 1: check if label center is inside room's bounding box
   - Fallback 2 (added 2026-03-22): assign to nearest room by centroid distance within 0.7× room diagonal — catches labels just outside noisy masks/bboxes
3. **Room-name filtering** — a word list (~40 common room names like "bedroom", "kitchen", "foyer") filters OCR noise. Title-case alphabetic words of 4+ chars are also accepted.
4. **Confidence filtering** (added 2026-03-22) — rooms with confidence < 0.5 (found by only 1 strategy) are dropped before output. These are almost always detection noise.
5. **Room type inference** (added 2026-03-22) — `_infer_room_type(label)` maps label text to room types via `_ROOM_TYPE_MAP` (~40 keyword→type mappings). Splits label on whitespace/separators and returns the first matching type. Output rooms include `"type"` field when not `"other"`.

### OCR Text Merging (`cv-service/cv/ocr.py`)

After Tesseract extraction, `merge_nearby_text()` reassembles text regions that were split across multiple detections. Tesseract PSM 11 (sparse text mode) often splits dimension strings like `10' - 8"` into separate regions (`10'`, `-`, `8"`). The merger combines horizontally-adjacent regions whose vertical centers are within 60% of average text height and whose horizontal gap is less than 1.5× average height.

### Dimension Parsing (`cv-service/cv/dimensions.py`)

Parses dimension strings into centimeters. Supported formats:

| Format | Example | Result |
|--------|---------|--------|
| Metric with unit | `3.30m` | 330 cm |
| Metric bare | `3.30` (two decimal places) | 330 cm |
| Imperial ft-in | `10'-8"`, `10'- 8"`, `10' 8"` | 325 cm |
| Imperial ft-only | `10'` | 305 cm |
| Unicode quotes | `10\u2019- 8\u201d` | 325 cm |
| Compound | `10'-8" x 8'-1"` | parses both (325, 246) |

`parse_dimension()` returns the first valid dimension. `parse_all_dimensions()` returns all dimensions from compound strings (useful for room-size labels like `10'-8" x 8'-1"`). Area strings (`m²`, `sq ft`) are explicitly rejected.

### Scale Calibration (`cv-service/cv/pipeline.py`)

Matches dimension text labels to their nearest **parallel** wall using perpendicular distance:
- A horizontal dimension label (wider than tall) prefers horizontal walls; orientation mismatch allowed with 2x distance penalty (compound dims like "10'-6" x 8'-10"" are always horizontal text but may label vertical walls)
- The text must fall within the wall's span along the parallel axis (±20% margin)
- Maximum perpendicular distance: 20% of image dimension
- Compute `cm / wall_pixel_length` for each match
- Use the median as the scale factor to reject outliers
- Returns `(scale, confidence)` tuple: `"measured"` when dimension labels matched, `"fallback"` when using default
- Fallback: `1000 / image_width` (assumes 10m-wide floor plan) — **unreliable, produces wrong room sizes**
- `scale_confidence` is exposed in the API response (`meta.scale_confidence`) so downstream can warn users
- **Debug logging:** `log.debug()` traces every dimension→wall match attempt with distances, wall coordinates, and match/reject reasons. Enable with `DEBUG` log level to diagnose scale fallback issues.

### Deployment

```bash
# One-command deploy to Hetzner
./cv-service/deploy-hetzner.sh <server-ip> [ssh-key-path]
```

The script: installs Docker if needed, opens port 8100 via ufw, rsyncs the cv-service directory, copies the project root `.env` file to the server (contains `REPLICATE_API_TOKEN`), sources it before running `docker compose up --build -d`, and verifies via health check. The `docker-compose.yml` passes `REPLICATE_API_TOKEN` from the environment to the container via `${REPLICATE_API_TOKEN}` interpolation.

### FastAPI Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/analyze` | POST | Multi-strategy merge: run 23 strategies, cluster rooms, return merged result |
| `/sweep` | POST | Diagnostics: run all 28 strategies independently, return per-strategy results with debug binary masks |

The `/analyze` endpoint accepts either `image` (base64) or `image_url` (fetched server-side via httpx). Returns `{name, rooms[], openings[], adjacency[], outline?, spatial_grid?, meta}`. Rooms have `confidence` (0.5-0.9, rooms below 0.5 are filtered out), `found_by` (list of strategy names), and optionally `type` (inferred from label text via `_infer_room_type()`). `outline` is the building perimeter polygon (cm, origin-normalized). `spatial_grid` contains an ASCII grid, legend, cell size, and grid dimensions. Meta includes `strategies_run`, `strategies_contributing`, `merge_stats`, `merge_time_ms`, and `preprocessing` with anchor strategy info.

The `/sweep` endpoint runs all 28 strategies (including excluded ones) and returns `{image_size, strategies[]}` where each strategy entry has the full pipeline result plus `debug_binary` (base64 PNG of the binary wall mask) and `time_ms`.

---

## System Audit & Architecture Simplification (2026-03-22)

### What was removed and why

A full system audit (plan file: `abstract-sparking-globe.md`) traced data through every pipeline boundary and identified a **fundamental architectural flaw**: the AI specialist + merge + validate layer (~1000 LOC) could only change room *labels* and confidence, never room *geometry*. When CV got wrong room sizes/positions, nothing downstream could fix it.

**Removed components (still in codebase, bypassed at runtime):**
- 4 Llama 3.2 11B Vision specialists (Room Namer, Layout Describer, Symbol Spotter, Dimension Reader)
- Merge logic (`src/ai/merge.ts`) — centroid-distance matching, label normalization, confidence scoring
- Validation loop (`src/ai/validate.ts`) — 2-pass Llama 3.2 self-correction
- Orchestrator AI path (`src/ai/orchestrator.ts`) — specialist dispatch, tiering, hint bank

**Evidence for removal:**
- Layout Describer used 3×3 grid (33% image per cell) — too coarse for positioning
- Dimension Reader captured text but never parsed it into numeric values
- Merge scoring system (6 factors, ~200 LOC) net effect: sometimes fixing room labels
- Validation loop: Llama 3.2 too weak to reliably self-correct
- None of these components could fix the actual quality problems (wrong room sizes, positions, missing rooms)

### Current architecture: CV + Claude

```
analyze_floor_plan_image(image_url)
  ↓
Worker fetches image, sends to CV service
  ↓
CV Service (Hetzner): POST /analyze
  └─ 23-strategy multi-merge → rooms, openings, adjacency, wall thickness
  ↓
cvToSketchInput() — deterministic conversion (src/ai/convert.ts)
  ↓
Returns to Claude: source image (MCP image block) + CV rooms + ready-to-use sketch input
  ↓
Claude interprets image, corrects CV data, drives sketch construction via generate_floor_plan
```

**Why this is better:** Claude (frontier model) can see the floor plan image and has the visual intelligence to understand room boundaries, labels, and spatial relationships. CV provides measured geometry (pixel coordinates, polygons, scale). Each component does what it's best at.

### Neuron Budget Tracking

Workers AI neuron budget tracking (`ai_neuron_usage` D1 table) remains in the codebase but is not consumed since the AI specialists are bypassed. It can be removed in a future cleanup.

### CV Preprocessing Strategies (2026-03-20)

The CV service has **28 preprocessing strategies** registered in `cv/strategies.py`, of which **23 are active** (5 excluded for zero yield). Each strategy transforms the input image into a form optimized for wall/room detection.

**Strategy categories:**
- **Direct binarization** (8): raw, otsu, adaptive_large, canny_dilate, downscale, morph_gradient, sauvola, median_otsu
- **Enhancement + binarization** (4): enhanced (CLAHE+bilateral+unsharp), heavy_bilateral, clahe_aggressive, hsv_value
- **Edge-based** (5): sobel_magnitude, log_edges, dog_edges, hough_lines, multi_scale
- **Local adaptive** (3): niblack, wolf, bilateral_adaptive
- **Thick wall handling** (2): thick_wall_open (morphological open removes thin furniture lines, preserves thick walls), distance_wall_fill (distance transform bridges thick wall pairs at threshold 8px, complements thick_wall_open)
- **Color channel** (3, excluded): lab_a_channel, lab_b_channel, saturation
- **Morphological** (2, excluded): top_hat_otsu, black_hat
- **Other** (1): invert

**Top performers by image (rooms detected):**
- 547 W 47th: multi_scale=6, hough_lines=6, downscale=5
- 520 W 23rd: canny_dilate=6, hough_lines=6, niblack=6, morph_gradient=6 (after letterbox fix; previously raw/otsu/multi_scale all detected 0 rooms due to black sidebar contamination, now raw=5, multi_scale=5, otsu=4)
- Plan 3: canny_dilate=10, log_edges=10, then 6 strategies at 9
- New plan: enhanced=8, then 7 strategies at 7

**Preprocessing metadata** added to `meta.preprocessing`:
```json
{
  "strategy_used": "multi_strategy_merge",
  "anchor_strategy": "canny_dilate",
  "strategies_run": 21,
  "strategies_contributing": 17
}
```

### TypeScript Types

```typescript
// CV service output (src/ai/types.ts)
CVRoom { label, x, y, width, depth, polygon?, confidence?, found_by? }
CVResult { name, rooms: CVRoom[], meta: { ..., preprocessing?: { strategy_used, anchor_strategy?, strategies_run?, strategies_contributing? } } }

// Merge output (src/ai/types.ts — legacy, used by orchestrator.ts)
MergedRoom { label, x, y, width, depth, type, confidence, sources[], split_hint?, split_evidence? }
PipelineOutput { name, rooms: MergedRoom[], openings, adjacency, meta }

// CV-direct converter (src/ai/convert.ts — active Copy Mode path)
CVAnalyzeResult { name, rooms: Array<{ label, x, y, width, depth, polygon? }>, openings?, meta: { wall_thickness? } }
cvToSketchInput(cv: CVAnalyzeResult) → SimpleFloorPlanInput  // polygon passthrough, wall thickness mapping
pipelineToSketchInput(output: PipelineOutput) → SimpleFloorPlanInput  // legacy path
```

---

## Known Issues & Status (as of 2026-03-22)

### Resolved: CV finds 0 rooms on real-world floor plans

**Fixed by multi-strategy merge + polygon refinement.** The old raw+enhanced pipeline found 0 rooms on complex floor plans. The new 23-strategy room-level merge recovers rooms from multiple preprocessing strategies. Polygon refinement splits rooms merged by thick walls. On 520 W 23rd: 7 rooms (up from 3). On 547 W 47th: 9 rooms. Plan 3: 9 rooms. New Plan: 7 rooms.

### Resolved: Letterboxed images caused 0 rooms in threshold strategies

**Fixed (2026-03-21).** Floor plan images with black letterbox bars (sidebars, top/bottom bars from PDF rendering) contaminated threshold-based strategies — black bars became ~40% wall density, destroying room detection. `remove_letterbox()` in `preprocess.py` now scans inward from each edge and fills uniformly dark strips with white before any strategy runs. On 520 W 23rd: raw went from 0→5 rooms, multi_scale from 0→5, otsu from 0→4.

### Partially resolved: Thick walls and structural columns in luxury floor plans

**Status: Mitigated (2026-03-21).** Architectural floor plans (e.g., 547 W 47th) draw walls as filled rectangles (8-20px thick) and columns as small filled squares/circles. The core tension: strategies that fill thick walls (multi_scale, downscale) also over-fill furniture.

**What was added:** `thick_wall_open` strategy — morphological open (erode 5x5 then dilate) on the raw binary mask. Erosion removes thin furniture outlines (1-3px) while preserving thick walls (5-15px). On 547 W 47th: 6 rooms at 9.1% density (vs. multi_scale's 6 rooms at 24.5%). Contributes uniquely to rooms that no other strategy detects.

**What remains:** The strategy regresses on thin-walled plans (plan3: 3→2, new_plan: 6→3) because erosion also removes thin walls. This is acceptable in the multi-strategy merge — other strategies compensate. But it means thick wall handling is a strategy-level addition, not a universal preprocessing fix.

**Empirical data (547 W 47th):**

| Strategy | Rooms | Density | Gradient Ratio | Issue |
|----------|-------|---------|----------------|-------|
| thick_wall_open | 6 | 9.1% | 0.438 | Clean walls, no furniture |
| multi_scale | 6 | 24.5% | 0.203 (solid) | Over-fills furniture |
| raw | 4 | 11.1% | 0.494 (mixed) | Thin edges, missing rooms |
| adaptive_large | 3 | 9.2% | 0.897 (thin) | Edge-only walls |

**Multi-strategy merge results with thick_wall_open:**

| Image | Rooms | Strategies contributing | thick_wall_open contributes to |
|-------|-------|------------------------|-------------------------------|
| 547 W 47th | 8 | 18/22 | 4 rooms (1 unique) |
| 520 W 23rd | 3 | 22/22 | 3 rooms |
| Plan 3 | 8 | 21/22 | 2 rooms |
| New plan | 5 | 21/22 | 2 rooms |

**Implemented since:** `distance_wall_fill` strategy bridges thick wall pairs via distance transform (threshold 8px). `structural_detect` replaces old `column_detect` — uses distance transform to profile wall thickness, classifying elements as columns, thick walls, or perimeter. `polygon_refine` dilates thick wall regions (capped at 8px via `_safe_dilation()` to avoid swallowing small rooms) and re-traces contours, splitting rooms that were merged by thick structural junctions. Wall thickness data (`thin_cm`, `thick_cm`, structural elements) is included in the API response, capped at realistic residential bounds via `cap_wall_thickness_cm()` (interior 8-20cm, exterior 15-40cm). **Remaining opportunities:** Using structural element data for perimeter anchoring and grid overlay, and wall-vs-furniture classification.

### Quality: CV room detection still imperfect

Multi-strategy merge improved room counts but quality issues remain:
- **~~OCR label concatenation~~** — FIXED (2026-03-21). `output.py` now picks the single best label per room (prefers known room words, breaks ties by centroid proximity) instead of concatenating all matches.
- **~~Logo/text regions detected as rooms~~** — MITIGATED (2026-03-21). `bbox_filter_pre` merge step computes consensus floor plan bbox (median of per-strategy bboxes) and removes rooms with centroids outside it, eliminating false rooms from logos, headers, and dimension text. `bbox_filter_post` re-checks after clustering as a safety net. **Validated (2026-03-21):** On 520 W 23rd, bbox_filter_pre correctly removes 44 margin artifacts (two clusters of ~22 rooms each at left/right margins, area ~590K px each — these are blank areas flanking the floor plan that every strategy detects as giant contours). The previous baseline of 5 rooms was wrong — 2 were margin artifacts. Correct baseline is 3 rooms. 547 W 47th: 0 rooms removed (all inside bbox), 8 rooms preserved.
- **~~Large merged rooms~~** — FIXED (2026-03-21). `merge.py` now excludes rooms exceeding 50% of image area from clustering.
- **~~Dimension text as room labels~~** — FIXED (2026-03-22). `_DIM_LIKE` regex expanded to catch OCR-garbled imperial dimensions (degree symbols, dashes, spaces). `_FIXTURE_ABBREVS` blocklist rejects "DW", "Ref", "W/D", "LC", "P". `_LOGO_WORDS` blocklist rejects "COMPASS", "Hanna", brokerage names. `_is_room_label()` now rejects all-caps non-room words. Added "WIC" and "CL" to `_ROOM_WORDS` (walk-in closet, closet).
- **~~Ghost rooms at negative coordinates~~** — FIXED (2026-03-22). `build_floor_plan_input()` now filters rooms with negative coordinates, area < 0.5% of image, or centroids outside floor plan bbox.
- **~~Excessive polygon dilation~~** — FIXED (2026-03-22). `_safe_dilation()` caps polygon refinement dilation at 8px max, preventing thick wall measurements from swallowing small rooms.
- **~~Unrealistic wall thickness in output~~** — FIXED (2026-03-22). `cap_wall_thickness_cm()` clamps interior walls to 8-20cm, exterior to 15-40cm (raised from 5/10 to match standard residential construction).
- **~~Scale calibration orientation mismatch~~** — FIXED (2026-03-22). `_calibrate_scale()` now allows orientation-mismatched dimension-to-wall matching with 2x distance penalty. Max matching distance increased from 15% to 20% of image diagonal.

- **~~Label fallback leaks noise~~** — FIXED (2026-03-22). `_assign_labels()` no longer falls back to unfiltered candidates. When all labels for a room fail `_is_room_label()`, the room gets a generic "Room N" label instead of noise like "COMPASS", "ye", or "Net". Confirmed on Shore Dr (COMPASS gone) and Res 507 (ye/Net gone).
- **~~Adaptive room segmentation~~** — ADDED (2026-03-22). `detect_rooms()` now estimates wall thickness via `_estimate_wall_thickness()` and reduces the closing kernel for thick-walled plans. Helps on synthetic tests but real-world impact is limited — Apt 6C bedrooms still merge, Unit 2C still only 5 rooms. The root cause is at the contour-detection level, not just the closing kernel size.

**Remaining quality issues (2026-03-22):**
- **Room segmentation upstream of merge** — thick walls cause adjacent rooms to merge at the contour-detection level. The adaptive closing kernel helps marginally but doesn't fix the fundamental issue. Unit 2C detects only 5 rooms for a 9-room apartment. Potential approaches: watershed segmentation, skeleton-based room splitting, or using structural element data to identify merge boundaries.
- **Scale calibration still falls back on some images** — Res 507 has clear dimension labels ("10'- 6\" x 8'- 10\"") that parse correctly, but OCR may fragment compound text or the wall detector doesn't find walls close enough to match. Debug logging now in place — enable `DEBUG` level on the CV service to trace dimension→wall matching.
- **Footer/legend text assigned to rooms** — Shore Drive picks up "2 Bedroom 2 Bathroom" from the COMPASS footer and assigns it to a small room near the bottom. The floor plan bbox filter should catch this but the footer text falls inside the bbox. Need a secondary filter: reject labels that look like summary stats (contain digit + room-type word patterns like "2 Bedroom").
- **Noisy polygon geometry** — rooms that should be simple rectangles often have 8-15 vertices due to DP epsilon (0.015 * perimeter) keeping too many points and rectilinear snapping not fully cleaning up. The `_snap_to_rectilinear()` function only snaps edges within 15° of axis-aligned.

**Latest CV test results (2026-03-22, deployed):**

| Image | Rooms | Scale | Labels | Types | Issues |
|-------|-------|-------|--------|-------|--------|
| Unit 2C (520 W 23rd) | 5 | measured (0.46) | Primary, Bedroom, Room (3 generic) | bedroom×2 | Only 5 rooms for 9-room apt |
| Shore Dr (9511) | 12 | measured (0.62) | Bedroom, wic, "2 Bedroom 2 Bathroom"; 9 generic | bedroom, closet | Footer text leaking; Room 13 (0.3) filtered |
| Apt 6C (520 W 23rd) | 5 | measured (2.63) | FOYER, BEDROOM×2, CL, LIVING/DINING | hallway, bedroom×2, closet, living | BATH (0.3) filtered; all rooms now labeled |
| Res 507 (547 W 47th) | 8 | fallback (0.85) | Bed, Bedroom×2, Foyer, & Dining; 3 generic | bedroom×3, hallway, dining | Scale still fallback; "& Dining" partial label |

### Quality: Sketch generation from CV data

The generated sketches don't closely match source images:
- **CV polygon geometry is real** but often irregular/noisy
- **No spatial constraint solver** — rooms placed at raw coordinates without overlap resolution
- **Wall thickness passthrough and rendering** — `SimpleFloorPlanInput` accepts `wallThickness: { interior, exterior }` (populated from CV `wall_thickness.thin_cm`/`thick_cm`), and `compile-layout.ts` uses these values when provided (defaults: 20cm exterior / 10cm interior). CV data flows end-to-end via `cvToSketchInput()`. As of 2026-03-22, **envelope-based rendering** — `compileLayout()` computes a building envelope (union of room polygons expanded by exterior wall thickness) and stores it as `plan.envelope`. Both SVG renderers detect this field and use the envelope-minus-rooms model: structural mass as filled polygon, rooms as colored cutouts, interior walls as thin lines. Legacy sketches without `envelope` fall back to the old wall-based rendering (exterior wall polygons + junction circles).
- **Polygon wall generation** — `compile-layout.ts` now generates walls from polygon edges (via `getPolygonEdges()`) for rooms with >4 vertices, producing accurate L-shaped/irregular wall outlines instead of bounding-box rectangles

### Exterior perimeter irregularity (2026-03-22 finding, PARTIALLY PROVEN)

**Problem:** Generated sketches always have rectangular exterior perimeters, even when source floor plans have irregular shapes (L-shaped apartments, step-outs, indentations). Real floor plans often have non-rectangular exterior walls.

**Root cause is room placement approach, NOT the envelope code.** The `computeEnvelope()` function in `compile-layout.ts` correctly traces the actual room contours:
1. Rasterizes all room polygons onto a 10cm boolean grid
2. Morphological close bridges gaps < 50cm (`ENVELOPE_GAP_THRESHOLD`)
3. Traces outer contour of filled grid → axis-aligned polygon
4. Offsets outward by exterior wall thickness

**Partially proven (2026-03-22):** Shore Drive sketch `2Gq_OIlsBj2W69-yW8w7l` shows some irregularity (balcony protrusion, stepped south wall). However, the full L-shape of the source is NOT accurately reproduced — specifically, Bedroom 2 should protrude significantly to the RIGHT at the bottom, and the kitchen protrudes a bit at the top. The sketch only captured the balcony bump, not the main building shape.

**New approach (2026-03-23): CV-extracted building outline.** Instead of hoping room placement produces the right perimeter, the CV pipeline now extracts the **actual building outline** directly from the source image via contour detection on thick black walls. This gives Claude the exact target shape as a polygon before placing any rooms. See "Building Outline & Spatial Grid" section below.

The envelope code required NO changes. The remaining challenge is getting Claude to place rooms accurately within the known outline.

**The fundamental insight — additive vs subtractive:**
- **Wrong approach (subtractive):** Start with a rectangular bounding box, place rooms to fill it, "cut out" room shapes. This forces every floor plan into a rectangle.
- **Correct approach (additive):** Place each room at its actual position and size based on the source image. Let gaps exist naturally. Let the envelope trace whatever shape results from the actual room positions. Rooms that protrude beyond the main footprint (balconies, bump-outs) create irregular perimeter features.

**Practical guidance for the agent:**
1. Place rooms at their actual sizes from the source — do NOT stretch rooms to fill gaps
2. Rooms that protrude (balconies, bay areas) should be placed at their real position even if they extend beyond the main building footprint
3. The `ENVELOPE_GAP_THRESHOLD` (50cm) bridges small gaps between rooms (for wall thickness) but preserves large gaps as perimeter irregularities
4. Preview after placing rooms to verify the envelope shape matches the source perimeter
5. For rectangular floor plans (like Apt 6C), the result WILL be rectangular — that's correct when the source is rectangular

**Key files:**
- `src/sketch/compile-layout.ts` — `computeEnvelope()` (lines ~522-562), `ENVELOPE_GAP_THRESHOLD` imported from defaults
- `src/sketch/geometry.ts` — `rasterizeToGrid()`, `traceContour()`, `offsetAxisAlignedPolygon()`
- `src/sketch/defaults.ts` — `ENVELOPE_GAP_THRESHOLD = 50` (cm)

### Building Outline & Spatial Grid (2026-03-23, NEW)

**Problem:** Claude struggles to reproduce the correct building shape from floor plan images. Even with additive room placement, the agent often misinterprets which rooms protrude and by how much. The CV room detection merges many rooms into blobs, so the spatial layout is ambiguous.

**Solution:** Two new CV outputs give Claude structured spatial data instead of making it interpret the image:

#### 1. Building Outline (`outline` field)

The building perimeter polygon, extracted from the floor plan image using OpenCV morphological operations + orthogonal regularization.

**Algorithm** (`cv/outline.py: extract_outline()`):
1. Crop to floor plan bbox (excludes footer/logos like COMPASS branding)
2. Heavy morphological closing (kernel = image_dim/8) seals ALL gaps (doors, windows, openings)
3. Flood fill from border → marks exterior
4. Interior = NOT exterior, union with walls = building footprint
5. `_contour_to_outline()` → largest contour → simplified polygon

**Contour processing** (`_contour_to_outline()`):
1. `cv2.findContours(RETR_EXTERNAL)` → largest contour
2. `cv2.approxPolyDP(epsilon=0.015*perimeter)` → simplified polygon (tunable via `epsilon_ratio` param)
3. `_regularize_orthogonal()` → snap edges to nearest 90° angle, recompute intersections, merge collinear segments
4. Convert to cm, snap to grid, normalize origin to (0,0)
5. `_remove_collinear()` → final cleanup of any collinear points created by grid snapping

**Orthogonal regularization** (`_regularize_orthogonal()`):
1. Find dominant angle from longest edges (weighted circular mean mod 90°)
2. Snap each edge to nearest multiple of 90° from dominant angle
3. Recompute vertices as intersections of consecutive snapped edges (each edge is a ray from its original midpoint in the snapped direction)
4. Merge near-duplicate vertices (<1cm apart) and remove collinear points

**Epsilon override / LLM feedback loop:**
The `/analyze` endpoint accepts `outline_epsilon` to override the default 0.015 ratio. The MCP `analyze_floor_plan_image` tool exposes this parameter. Claude acts as the "LLM in the loop": after the first analysis, Claude evaluates the outline vertex count against the visible building shape, and re-calls with a higher epsilon (0.03-0.05) if the outline is over-detailed. Expected vertex counts: rectangle=4, L-shape=6, T-shape=8, U-shape=8. The tool description and system prompt guide this feedback loop.

Returns a list of `{x, y}` points in cm. Example for Shore Drive (L-shaped):
```json
[{"x": 0, "y": 0}, {"x": 0, "y": 850}, {"x": 600, "y": 850},
 {"x": 600, "y": 740}, {"x": 680, "y": 740}, {"x": 690, "y": 480},
 {"x": 500, "y": 480}, {"x": 500, "y": 0}]
```

**Quality across test images (2026-03-23, after orthogonal regularization):**
- Shore Drive: 8 vertices, 690×850cm — clean L-shape (was 9)
- Unit 2C: 14 vertices, 650×450cm (was 22). With epsilon override 0.04 → 8 vertices
- Res 507: 10 vertices, 960×1090cm — shows stepped shape (was 16)
- Apt 6C: 12 vertices, 2040×2040cm (was 16)

**SAM2 evaluated and rejected (2026-03-23):** SAM2 (Segment Anything 2) was integrated via Replicate (`lucataco/segment-anything-2`), tested on all 4 images, and removed. SAM2 is trained on natural photographs and does not understand floor plans — all returned masks were tiny fragments (0.1-2.1% coverage, segmenting individual furniture/text labels), never the building footprint. The one "success" (Unit 2C) produced a harmful 230×540cm rectangle vs OpenCV's correct 650×450cm. The `meta/sam-2` combined mask (88.9% coverage) was just the whole image. SAM2 added ~$0.048 + ~50s per call with zero benefit. `replicate` package removed from requirements.

**Known issues:**
- **Apt 6C outline is oversized** — 2040cm wide suggests the fp_bbox is too large or scale is off.
- **Unit 2C still needs feedback loop** — 14 vertices at default epsilon, but drops to 8 with epsilon=0.04. The LLM feedback loop should catch this automatically.

#### 2. Spatial Grid (`spatial_grid` field)

An ASCII map showing where each room sits, built from room masks + OCR labels. Algorithm (`cv/outline.py: build_spatial_grid()`):
1. Create grid cells at `cell_size_cm` resolution (default 30cm)
2. For each cell, test which room mask contains its center pixel
3. Assign 2-char abbreviations via `_make_room_abbreviation()` (LV=Living, KT=Kitchen, BR=Bedroom, etc.)
4. Pair rooms with dimension text from OCR (finds compound dimensions like "12'8\" x 8'8\"" near room centroids)
5. Junk label filtering via `_is_junk_label()` — rejects dimensions, addresses, broker names, fixture abbreviations, special characters

**Grid quality is bottlenecked by room detection.** The CV pipeline merges many rooms into single blobs (e.g., Shore Drive has one giant "Room" blob covering Living+Kitchen+Halls+Baths). The grid can only show rooms the CV detects individually. The outline polygon is the more reliable output.

**Junk label filtering (`_is_junk_label()`)** catches:
- Dimension fragments: `15'1"`, `8-7"`, numbers with `x`
- Footer text: addresses, city names, broker names (COMPASS, Douglas Elliman, etc.)
- Fixture abbreviations: DW, Ref, W/D, P
- Short/single-char text, special characters ({, \, |)

**Remaining junk leakers (2026-03-23):** Some OCR garbage still gets through: `ay`, `tc`, `{0`. The filter needs to reject short lowercase non-room words and text with special characters more aggressively. This is the next improvement to make.

#### MCP Tool Output

The `analyze_floor_plan_image` MCP tool (`src/sketch/tools.ts: handleAnalyzeImage()`) formats both outputs for Claude:
- **Outline** → JSON polygon with explanation ("Use this as the target shape — place rooms INSIDE this outline")
- **Grid** → ASCII art with legend showing abbreviation→room name mappings and dimension annotations

**Key files:**
- `cv-service/cv/outline.py` — `_regularize_orthogonal()`, `_remove_collinear()`, `_contour_to_outline()`, `extract_outline()`, `build_spatial_grid()`, `_make_room_abbreviation()`, `_is_junk_label()`
- `cv-service/cv/pipeline.py` — threads `outline_epsilon` through `analyze_image()` → `_run_pipeline()` → `extract_outline()`
- `cv-service/app.py` — `AnalyzeRequest` has optional `outline_epsilon` field; `AnalyzeResponse` Pydantic model includes `outline` and `spatial_grid` fields
- `src/sketch/tools.ts` — `handleAnalyzeImage()` passes `outline_epsilon` to CV service, formats outline+grid in MCP response
- `src/index.ts` — `analyze_floor_plan_image` tool schema includes `outline_epsilon` param with feedback loop guidance in description

### Generate→Preview→Compare loop experience (2026-03-22, updated)

Ran 5+ iterations on Apt 6C and 1 iteration on Shore Drive. Key learnings for the agent-driven sketch construction loop:

**What works:**
- The generate→preview→compare cycle is effective — each iteration improves the sketch visibly
- CV output provides good starting geometry (room positions, relative sizes) even if imperfect
- The agent can manually correct CV data using the source image for reference
- `preview_sketch` returns a rendered PNG that's sufficient for visual comparison
- **Additive room placement produces correct irregular perimeters** — demonstrated on Shore Drive where balcony protrusion and stepped south wall rendered correctly without any code changes

**What doesn't work yet (known limitations):**
- CV misses rooms — Unit 2C has 9 rooms but CV only finds 5. Claude is authoritative for room count and adds CV-missed rooms from printed labels/dimensions.
- Complex service areas (corridors, closets, baths clustered together) are hard to lay out correctly — the structured comparison protocol (room-by-room checklist) helps catch and fix these one at a time.
- **Room adjacency for openings** — rooms must be within ~10cm (interior wall thickness) of each other for the system to detect a shared wall and place doors between them.
- CV dimension orientation is ambiguous — Claude can resolve this visually by comparing against the source image.

**Surgical iteration (IMPLEMENTED):** The `update_sketch` tool now accepts a `high_level_changes` array with 16 label-based operations (resize_room, move_room, add_door, place_furniture, etc.) that compile to low-level changes. This enables in-place surgical fixes instead of regenerating the entire sketch. Validated on 4 test images — all operations work end-to-end.

**Best sketches:**
- **Apt 6C:** `0H_S8-YHU2T5LwQXnWZYM` — 11 rooms, rooms at labeled dimensions (305×447, 549×366, 358×417cm), correct layout but still rectangular (Apt 6C IS rectangular). Previous best: `PE72Hg-AziIJhY3QzfNLM` (9 rooms, oversized rooms to fill gaps).
- **Shore Drive:** `2Gq_OIlsBj2W69-yW8w7l` — 10 rooms, **irregular perimeter proven** (balcony protrusion, stepped south wall). Room dimensions approximate — needs refinement to match labeled dimensions more closely.

**Test image URLs (all 4):**
- Apt 6C: `https://roomsketcher.kworq.com/api/images/53c1822d-3e22-429b-8476-b8066e409534`
- Res 507: `https://roomsketcher.kworq.com/api/images/44e71e4b-e100-4572-aed1-674193c78785`
- Unit 2C: `https://roomsketcher.kworq.com/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`
- Shore Drive: `https://roomsketcher.kworq.com/api/images/f299ae0e-894b-4d16-a468-78775eb73400`

### Preprocessing metadata now flows through

`meta.cv_preprocessing` in `PipelineOutput` contains `{ strategy_used, anchor_strategy, strategies_run, strategies_contributing }`.

### Minor: Furniture catalog gaps

Added in this session: dishwasher, washer-dryer, plus aliases (refrigerator→fridge, range→stove, bathroom-sink→bathSink). Still missing: oven, kitchen island, fireplace, AC unit. Tracked in `project_furniture_catalog_gaps.md`.

### Minor: Uploaded images not cleaned up

`uploaded_images` table entries persist indefinitely. Should be cleaned up after CV analysis or via cron.

### Blocked: MCP App for in-chat image upload (2026-03-21)

**Goal:** Let users drag-drop floor plan images directly in the Claude conversation instead of visiting `/upload` separately.

**Approach:** MCP Apps (`@modelcontextprotocol/ext-apps`) — tool + resource pairs that render interactive HTML in sandboxed iframes inside the host UI. The app would upload to `/api/upload-image`, get a URL, then call `analyze_floor_plan_image`.

**Status: BLOCKED — Claude Desktop does not support MCP Apps for custom servers.**

Root cause (confirmed via systematic isolation testing):
- `_meta: { test: true }` on a tool → connects fine
- `_meta: { ui: { resourceUri: 'ui://...' } }` on a tool → Claude Desktop **disconnects immediately**
- `registerResource()` alone → connects fine
- The `extensions` capability (`io.modelcontextprotocol/ui`) is **not in the MCP SDK** yet (pending SEP-1724)
- `claudemcpcontent.com` (Anthropic's sandbox proxy for MCP App iframes) returns **NXDOMAIN** — infrastructure not operational
- Launch partners (Slack, monday.com, Figma) use Anthropic's managed connector infrastructure, not the same path
- GitHub issues: [anthropics/claude-ai-mcp#61](https://github.com/anthropics/claude-ai-mcp/issues/61), [anthropics/claude-code#34820](https://github.com/anthropics/claude-code/issues/34820)

**Code ready** (parked, not deployed):
- `src/mcp-app/upload-app.ts` — MCP Apps client with drag-drop, paste, file picker
- `src/mcp-app/upload-app.html` + `upload-app.css` — Vite entry point
- `vite.config.ts` — builds single-file HTML via `vite-plugin-singlefile`
- `deploy.sh` includes `vite build` step
- CORS on `/api/upload-image` for cross-origin iframe

**When to retry:** Monitor SEP-1724 (extensions capability in MCP SDK), `claudemcpcontent.com` DNS, Claude Desktop release notes. When ready, use `getUiCapability()` guard in `oninitialized` + `tool.update({ _meta })` to conditionally enable.

**Current workaround:** Users upload at `/upload` page, paste returned URL into chat.

### Claude Desktop Copy Mode Testing Feedback (2026-03-23)

Testing the full Copy Mode workflow in Claude Desktop (analyze → generate → preview → surgical update → preview) on 4 images surfaced these operational insights:

**What works well:**
- **Side-by-side rasterized preview** — "Probably the most valuable part of the whole workflow." Immediate visual comparison between generated sketch and source image. The tool Claude Desktop would call repeatedly during iteration.
- **`generate_floor_plan` room-first input format** — "Very clean — just give it rectangles with x/y/width/depth and it builds walls automatically."
- **CV data for scale and wall thickness** — Even when CV misidentifies rooms, its scale calibration and wall thickness measurements are reliable and directly usable.

**What doesn't work well:**
- **Spatial grid** — "Not really helpful. Large ASCII matrix with lots of RO labels and dots that was hard to parse." The JSON room coordinates from CV were far more actionable. Grid added noise without being as precise as JSON or as intuitive as the image.
- **CV room labeling** — Mislabeled most rooms (generic "Room" or wrong labels from footer text like "2 Bedroom 2 Bathroom"). Claude had to override almost everything using what it could read from the image itself.
- **Envelope doesn't follow room edits** — When resizing a room, the building envelope didn't follow. Attempting `set_envelope` to fix it broke exterior walls. (This is being addressed by the Envelope Recomputation plan.)

---

## Image Upload System

Users upload floor plan images via the `/upload` page, which stores them in D1 and returns a URL the agent can use with `analyze_floor_plan_image`. An in-chat MCP App upload widget is built but blocked on Claude Desktop MCP Apps support (see Known Issues).

### Flow

```
User drags/pastes image → /upload page
  → POST /api/upload-image (binary body, Content-Type header)
  → Store base64 in D1 uploaded_images table (max 10MB)
  → Return { url: "/api/images/<uuid>", id }

Agent calls analyze_floor_plan_image with image_url
  → Worker fetches image from /api/images/<id> (same-origin)
  → Returns image as MCP image content block
  → Worker POSTs image_url to CV service
  → CV service fetches image, runs pipeline, returns JSON
```

### Upload Page (`src/setup/upload.ts`)

Single-file HTML page at `/upload` with:
- Drag-and-drop zone
- Clipboard paste support
- File picker (PNG, JPG, max 10MB)
- Image preview
- Copy-to-clipboard URL output with canonical `WORKER_URL` prefix
- Hint text directing users to paste URL in Claude conversation

**URL architecture (2026-03-22):**
- Fetch uses **relative** path (`/api/upload-image`) — no CORS issues regardless of which domain serves the page
- API returns **relative** URL: `{ url: "/api/images/{uuid}" }`
- Upload page prepends `WORKER_URL` (from `env.WORKER_URL`, fallback `url.origin`) for display
- This ensures the user always copies the canonical URL (e.g., `https://roomsketcher.kworq.com/api/images/...`), matching what MCP tools use

**MCP image-in-chat limitation:** When users paste images directly into Claude chat, the agent can see them via vision but cannot pass the bytes to MCP tools (MCP protocol limitation). Tool descriptions for `analyze_floor_plan_image` and `generate_floor_plan` explicitly instruct the agent to direct users to `/upload` in this case.

### Image Storage

Images stored as base64 text in D1 `uploaded_images` table. Served via `GET /api/images/:id` with appropriate `Content-Type` and 1-hour cache headers. UUIDs as IDs.

---

## Agent Workflows

### Image Handling (MCP Protocol Limitation)

MCP cannot pass images from chat to tools. The agent's behavior depends on how the user provides the image:

1. **User provides a URL** → Agent calls `analyze_floor_plan_image` immediately with that URL. No questions asked.
2. **User pastes/attaches an image in chat** → Agent can SEE the image but MUST NOT eyeball the layout. Must direct user to upload at `{WORKER_URL}/upload`, then use the returned URL.

**Why CV is mandatory:** The agent cannot accurately estimate room dimensions, wall coordinates, or spatial relationships by looking at an image. The CV pipeline uses edge detection, OCR, and geometric analysis to extract exact measurements in centimeters. Tool descriptions reinforce this: `analyze_floor_plan_image` says "NEVER skip this tool", `generate_floor_plan` says "MANDATORY: You MUST call analyze_floor_plan_image BEFORE calling generate_floor_plan".

### Copy Mode (Reference Image → Floor Plan) — Vision-First with CV Advisory

**Design principle (2026-03-23):** Claude drives room layout from its own visual understanding of the source image. CV data is advisory — expert input that Claude evaluates and may override when it can see something different. This replaced the earlier "CV is source of truth" approach because CV detects only 5 of 9 rooms on Unit 2C, while Claude reads all 9 labels and dimensions directly from the image.

**CV is authoritative for:** scale calibration (cm/px), wall thickness, building outline polygon
**Claude is authoritative for:** room count, room labels, printed dimensions, spatial relationships, openings, furniture

**Design spec:** `docs/superpowers/specs/2026-03-23-surgical-iteration-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-03-23-surgical-iteration.md`

```
PHASE 1 — ANALYZE AND BUILD SKELETON:

  Step 1: ANALYZE
    analyze_floor_plan_image(image_url) → CV + source image
    Read the CV output AND look at the source image yourself.
    Count every room you can see. Note rooms CV missed.
    Trust CV for: scale, wall thickness, outline.
    Trust your eyes for: room count, labels, printed dimensions.

  Step 1b: EVALUATE OUTLINE
    Check outline vertex count vs building shape.
    Rectangle=4, L-shape=6, T-shape=8. Re-call with higher outline_epsilon if over-detailed.

  Step 2: BUILD ALL ROOMS
    generate_floor_plan with ALL rooms — CV-detected + manually identified.
    Convert imperial dims (1' = 30.48cm). Add basic openings. No furniture yet.

  Step 3: PREVIEW AND COMPARE (side-by-side)
    preview_sketch returns sketch + source image together.
    Follow the COMPARISON PROTOCOL: count rooms, room-by-room check
    (size, position, shape), openings, overall outline shape.
    List specific discrepancies.

PHASE 2 — SURGICAL ITERATION:

  Step 4: FIX ONE THING AT A TIME
    Use high-level surgical operations (resize_room, move_room, split_room, etc.)
    via update_sketch high_level_changes array.
    Apply ONE fix → preview → verify → repeat.
    Never regenerate the entire layout to fix one room.

  Step 5: ADD OPENINGS
    add_door (between: [room1, room2] for interior, room + wall_side for exterior)
    add_window (room + wall_side)
    Preview to verify placement.

  Step 6: ADD FURNITURE
    place_furniture with room-relative named positions (center, north, sw, etc.)
    Preview to verify.
```

**Architecture note:** Copy Mode bypasses the AI specialist layer (4× Llama 3.2 11B Vision models removed). `handleAnalyzeImage` calls the CV service directly and auto-converts via `cvToSketchInput()`. Claude interprets the image + CV data and drives sketch construction.

### Surgical Iteration System (2026-03-23, IMPLEMENTED)

**Status:** Fully implemented, deployed, and validated on 4 test images. 272 tests passing.

Two new modules add label-based surgical editing on top of the existing 15 low-level change types:

**`src/sketch/resolve.ts`** — Label→ID resolution layer:
- `findRoomByLabel(plan, label)` — case-insensitive match, throws descriptive error listing available rooms
- `findRoomWalls(plan, room)` — geometric wall-to-room association via bounding box edge matching (SNAP_TOLERANCE=20cm)
- `findRoomWallOnSide(plan, room, side)` — find wall on N/S/E/W side
- `findSharedWall(plan, roomA, roomB)` — find shared wall between two rooms
- `findFurnitureInRoom(plan, room, type?)` — point-in-polygon check
- `resolvePosition(room, position, width, depth)` — named positions (center/north/sw/etc.) → absolute coords

**`src/sketch/high-level-changes.ts`** — Compiler from label-based ops to low-level changes:
- 15 high-level change types: `resize_room`, `move_room`, `split_room`, `merge_rooms`, `remove_room`, `add_room`, `add_door`, `add_window`, `update_opening`, `remove_opening`, `place_furniture`, `move_furniture`, `remove_furniture`, `rename_room`, `retype_room` (`set_envelope` removed — envelope is now auto-derived, see Envelope Recomputation below)
- Each compiles to an array of existing low-level `Change` types
- `processChanges(plan, highLevelChanges, lowLevelChanges)` — sequential compilation + application
- Canvas bounds recomputed after changes
- Atomic error handling — if any label resolution fails, entire batch rolls back

**`update_sketch` tool** uses separate arrays to avoid Zod discriminant collisions:
```
inputSchema: {
  sketch_id: string,
  changes?: Change[],              // existing low-level (by ID)
  high_level_changes?: HighLevelChange[],  // new label-based (by room name)
}
```

**Side-by-side preview:** `preview_sketch` returns source image alongside rendered sketch when `source_image_url` is in metadata. Source URL flows: `analyze_floor_plan_image` caller stores in `SketchSession.sourceImageUrl` → `generate_floor_plan` copies to `plan.metadata.source_image_url`.

**Low-level `set_envelope` change type** — sets `plan.envelope` directly (added to `ChangeSchema` and `applyChanges`). Used internally; NOT exposed as a high-level operation.

### Envelope Recomputation (2026-03-23, PLANNED — spec + plan committed)

**Problem:** The building envelope (thick perimeter outline) was computed once during `generate_floor_plan` and never updated when rooms changed via surgical ops or wall drag. `set_envelope` as a high-level workaround made things worse — it replaced the polygon without updating walls.

**Solution (designed, not yet implemented):**
- **Client-side:** Port `computeEnvelope` pipeline (rasterize → morphological close → contour trace → offset) to vanilla JS in `html.ts`. Recompute in real-time during wall drag with a 16ms performance escape hatch. Also recompute on commit, undo/redo, and `applyChangeLocal`.
- **Server-side:** Auto-recompute in `processChanges` after geometry-changing operations (`resize_room`, `move_room`, `add_room`, `remove_room`, `split_room`, `merge_rooms`).
- **Remove `set_envelope`** from high-level changes (schema, compiler, tool description). Low-level `set_envelope` stays for internal use.
- **Room polygon propagation during drag** — currently only happens on mouseup (commit). Must also happen during mousemove for real-time envelope feedback. Extract shared helper, use absolute deltas from drag-start to avoid floating-point drift.

**Spec:** `docs/superpowers/specs/2026-03-23-client-envelope-recompute-design.md`
**Plan:** `docs/superpowers/plans/2026-03-23-client-envelope-recompute.md` (7 tasks)

### Template Mode (Description → Floor Plan)

Same two-phase approach — get visible first, refine after.

```
PHASE 1:
  search_design_knowledge (per room type)
    → list_templates → pick closest match
    → generate_floor_plan with rooms + basic openings, NO furniture
    → preview_sketch IMMEDIATELY

PHASE 2:
  → fix layout via update_sketch + preview
  → add remaining openings + preview
  → add furniture + preview
  → suggest_improvements (spatial data + design knowledge)
```

### Modification Mode (Existing Sketch)

When a sketch already exists, the agent must use `update_sketch` (not `generate_floor_plan`). Tool descriptions enforce this.

```
get_sketch → read current state
  → update_sketch with incremental changes
  → preview_sketch (required for structural changes, skippable for cosmetic)
  → fix regressions if found
  → suggest_improvements
```

### Visual Feedback Loop

`preview_sketch` rasterizes the SVG to a 1200px-wide PNG via `@cf-wasm/resvg` (WASM) and returns it as an MCP image content block.

**Side-by-side comparison (implemented 2026-03-23):** When a sketch has `metadata.source_image_url` (set during Copy Mode), `preview_sketch` returns both the rendered sketch AND the source floor plan image together, enabling direct visual comparison in a single tool call. The source URL flows: `analyze_floor_plan_image` stores in `SketchSession.sourceImageUrl` → `generate_floor_plan` copies to `plan.metadata.source_image_url` → `preview_sketch` fetches and returns alongside sketch PNG.

**Structured comparison protocol (implemented):** The `preview_sketch` tool description embeds a room-by-room COMPARISON PROTOCOL: count rooms, check each room's size/position/shape, verify openings, compare overall outline. Each discrepancy maps to a specific surgical fix.

Tool descriptions enforce the loop:
- `generate_floor_plan` says "CRITICAL: Do NOT skip preview_sketch after generating."
- `preview_sketch` describes itself as "your eyes" with a comparison protocol (Copy Mode) or 5-point checklist (Design Mode)
- `update_sketch` enforces surgical iteration — fix one thing at a time, preview after each fix
- The two-phase workflow means the agent previews BEFORE investing in openings and furniture, catching layout errors early

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

**Rendering:** `furnitureDefsBlock()` generates a `<defs>` block with `<symbol>` elements for each type. Items render via `<use>` with position/rotation transforms. Uses `vector-effect="non-scaling-stroke"` for DPI-independent rendering. Unknown types fall back to a labeled rectangle. All text in SVG symbols is XML-escaped via `escXml()` to prevent XSS.

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

### Room-First Input (SimpleFloorPlanInput)

For agent convenience, `compile-layout.ts` accepts a simplified format where agents specify rooms as rectangles or polygons, and the system auto-generates walls, room polygons, and canvas:

```
SimpleFloorPlanInput
├── rooms[]: {label, x, y, width, depth} or {label, polygon: [{x,y}...]}
├── openings[]: {type, between: [room1, room2]} or {type, room, wall: "north"|...}
├── furniture[]: {type, room, x, y, width, depth}
└── wallThickness?: {exteriorCm, interiorCm}  ← NOT YET IMPLEMENTED
```

This is the primary input format used by both template mode and copy mode (CV output maps directly to this schema).

**Wall thickness override:** `SimpleFloorPlanInput` accepts an optional `wallThickness: { exterior?: number, interior?: number }` field (cm). When provided, `compile-layout.ts` uses these values instead of the defaults (`WALL_THICKNESS = {exterior: 20, interior: 10}`). The CV pipeline detects actual wall thickness (`wall_thickness.thin_cm` / `thick_cm` in the `/analyze` response) and `cvToSketchInput()` maps these to the `wallThickness` field.

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

1. **Rooms** — colored polygons + XML-escaped label + area text at centroid
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

`svgToPng(svg, width?)` converts SVG strings to PNG using `@cf-wasm/resvg` (WASM, runs in-Worker). Default 1200px width, height auto-derived from viewBox. PNG bytes are base64-encoded via chunked `btoa()` (not Node `Buffer`, which is unavailable in Cloudflare Workers runtime). Used by `preview_sketch` MCP tool and `GET /api/sketches/:id/preview.png` HTTP endpoint.

---

## Browser Sketcher SPA

Single-file HTML+CSS+JS served at `/sketcher/:id`. No build step.

**Tools:** Select, Wall, Door, Window, Room, Furniture
**Features:** Snap-to-grid, multi-snap system, pan/zoom, keyboard shortcuts, real-time WebSocket sync, properties panel, furniture rendered with architectural symbols, undo/redo, visual filter dimming, wall endpoint dragging with connected wall auto-follow, wall-segment dragging (perpendicular translation), room polygon propagation, furniture rotation handles
**State:** `plan`, `tool`, `selected`, `drawStart`, `viewBox`, `ws`, `dragState`, `wallDragState`, `undoStack`, `redoStack`, `interactionMode`
**Branding:** RoomSketcher teal/gold palette, Merriweather Sans font, logo (home link to `/`), footer CTA

**Client-side change handling:** The SPA implements all 13 change types (including `update_room`) in `applyChangeLocal()`, matching the server's `applyChanges()` behavior — including color updates on room type change via inline `ROOM_COLORS` map.

**URL strategy:** All API calls use relative paths (`/api/sketches/...`, `/ws/...`) for proxy transparency. No hardcoded origins.

### Interaction State Machine

The sketcher uses an `interactionMode` variable to manage input state:

| Mode | Trigger | Behavior |
|------|---------|----------|
| `idle` | Default | No active interaction |
| `selecting` | mousedown on element/handle | Waiting for click vs drag threshold (3px) |
| `dragging_endpoint` | Drag past threshold on handle | Wall endpoint drag in progress |
| `dragging_wall` | Drag past threshold on wall body | Wall-segment translation in progress |
| `dragging_furniture` | Drag past threshold on furniture | Furniture translation in progress |
| `rotating_furniture` | Drag on rotation handle | Furniture rotation in progress |
| `panning` | Drag on empty canvas | ViewBox translation |

### Wall Endpoint Dragging

Drag handles (teal circles, r=6 desktop / r=14 mobile) appear at wall endpoints when a wall is selected. Dragging an endpoint:

1. **Grab offset** — On drag start, stores the offset between cursor position and endpoint position. The endpoint stays under the finger/cursor throughout the drag (no jump on first frame).
2. **Connected wall auto-follow** — `findConnectedEndpoints()` finds walls sharing a point (1cm threshold). Connected walls move together. Hold Alt/Option to detach and move independently.
3. **Multi-snap system** — During drag, `computeSnap()` tests snap targets in priority order: endpoint (15px) > perpendicular (10px) > alignment (10px) > midpoint (10px) > grid (always). Snap guide lines render as an SVG overlay.
4. **Direct DOM update** — During drag, only `setAttribute()` calls on wall `<line>` and handle `<circle>` elements (no full `render()`). WebSocket broadcast throttled to 10fps via `sendWsThrottled()`.
5. **Commit on mouseup** — `commitEndpointDrag()` builds change + inverse-change arrays for the undo stack, propagates room polygons, clears snap guides, and does a full `render()`.

### Wall-Segment Dragging

Grabbing a wall body (not its endpoint handles) and dragging translates the entire wall segment. This is a higher-level abstraction built on top of endpoint dragging — the underlying flexibility is preserved.

1. **Perpendicular constraint** — Movement is projected onto the wall's perpendicular axis. You cannot slide a wall along its length, only push it sideways. This matches intuitive behavior (making a room wider/narrower).
2. **Grid snap** — The projected delta is snapped to 10cm increments.
3. **Connected wall auto-follow** — Walls connected at both endpoints have their shared endpoints moved. Connected walls stretch/shrink to follow. Uses `findConnectedEndpoints()` for both start and end.
4. **Room polygon propagation** — Vertices near either original endpoint of the dragged wall are moved by the same delta, same as endpoint dragging.
5. **Direct DOM update** — During drag, only `setAttribute()` calls (no full render). WebSocket broadcast throttled.
6. **Undo** — One undo step covers the main wall + all connected walls + room polygon updates.
7. **Cursor** — Walls show `cursor: move` to indicate they're draggable.

State: `wallDragState = { wallId, origStart, origEnd, grabPoint, connectedStart[], connectedEnd[], originalPositions }`.

### Room Polygon Propagation

When wall endpoints move, room polygon vertices must follow. The system uses a two-pass approach:

1. **Delta-based propagation** — Room polygon vertices within `maxWallThickness + 5` cm of the original drag point are moved by the same delta (dx, dy) as the wall endpoint. This preserves the inward offset (room vertices are inset from wall endpoints by half the wall thickness).
2. **Drift repair** — After delta propagation, a second pass checks every room's polygon vertices against the room's wall endpoints. If any vertex drifted too far from all wall endpoints (e.g., after disconnect/reconnect), it is snapped to the nearest wall endpoint with the proper inward offset direction preserved.

Both passes generate `update_room` changes for the undo stack.

### Undo/Redo System

- Stack-based: `undoStack` and `redoStack` (max 50 entries)
- Each entry stores `{ changes[], inverseChanges[] }` — a batch of changes that form one logical operation
- A single endpoint drag affecting N walls + room polygons = 1 undo step
- Keyboard shortcuts: Cmd+Z (undo), Cmd+Shift+Z (redo)
- Toolbar buttons on desktop (right side); mobile undo/redo buttons in bottom sheet actions
- `pushUndo()` clears the redo stack (standard undo/redo behavior)

### Visual Filter Dimming

Each tool mode highlights its relevant layer and dims the rest at 20% opacity with `pointer-events: none`:

| Tool | Highlighted | Dimmed |
|------|-------------|--------|
| Select | All | None |
| Wall | Walls + openings | Rooms, furniture |
| Door/Window | Walls + openings | Rooms, furniture |
| Room | Rooms | Walls, furniture |
| Furniture | Furniture | Walls, rooms |

### Furniture Rotation Handle

Selected furniture shows a "lollipop" rotation handle (teal circle on a stem above the selection). Dragging it rotates the furniture with 15-degree snap increments. Rotation is computed from the angle between cursor and furniture center, quantized to the nearest 15 degrees.

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

### Setup, Upload & Onboarding Pages

Three static pages for user acquisition and image handling, served from `src/setup/`.

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

**Upload page (`/upload`)** — `src/setup/upload.ts`
- Drag-and-drop, file picker, and clipboard paste support for floor plan images
- Uploads to `/api/upload-image` (binary body, Content-Type header)
- Shows copyable URL for pasting into Claude conversation
- PNG and JPG, max 10MB

**URL strategy:** Internal navigation uses relative paths (`/setup`, `/health`, `/upload`). The MCP URL shown to users is the only absolute URL, built from `env.WORKER_URL` to ensure it shows the custom domain (`roomsketcher.kworq.com/mcp`), not the raw workers.dev URL.

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

-- Image uploads (temporary storage for CV analysis)
uploaded_images(id TEXT PK, data TEXT base64, content_type, created_at)

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
| `/upload` | GET | Image upload page (drag-drop, paste, URL output for CV) |
| `/mcp` | * | MCP protocol (McpAgent) |
| `/health` | GET | Health check + last sync time |
| `/admin/sync` | POST | Trigger Zendesk sync |
| `/api/upload-image` | POST | Store uploaded image in D1, return URL |
| `/api/images/:id` | GET | Serve uploaded image by UUID |
| `/api/sketches/:id/preview.png` | GET | Rasterized PNG preview (1200px wide) |
| `/api/sketches/:id` | GET | Load plan + SVG from D1 |
| `/api/sketches/:id` | PUT | Save plan to D1 |
| `/api/sketches/:id/export.pdf` | GET | Download SVG file |
| `/ws/:id` | GET (upgrade) | WebSocket → SketchSync DO |
| `/sketcher/:id` | GET | Serve sketcher SPA HTML |

---

## Infrastructure

### Cloudflare Worker

- **Runtime:** Cloudflare Workers with `nodejs_compat` flag
- **Bindings:** D1 database, 2 Durable Objects (RoomSketcherHelpMCP, SketchSync)
- **Env vars:** `WORKER_URL` (public domain), `CV_SERVICE_URL` (CV service endpoint), `CTA_VARIANT` (optional A/B)
- **Bundle size:** ~1.4MB gzip (mostly `@cf-wasm/resvg` WASM at ~1MB)
- **Deploy:** `bash deploy.sh` (wraps `wrangler deploy` + sync + health check)

### Hetzner VPS (CV Service)

- **Runtime:** Docker container (Python 3.11 + Tesseract + OpenCV)
- **Port:** 8100 (HTTP, no TLS — internal service)
- **DNS:** `cv.kworq.com` A record (DNS-only, grey cloud) → server IP
- **Deploy:** `bash cv-service/deploy-hetzner.sh <ip>` (rsync + docker compose up)
- **No auth:** The CV service is stateless and processes only images sent to it. No secrets or user data stored.

### Networking Constraint

Cloudflare Workers cannot `fetch()` to bare IP addresses (error 1003). All external service URLs must use domain names. This is why `CV_SERVICE_URL` is set to `http://cv.kworq.com:8100` rather than `http://<ip>:8100`. Port 8100 works fine with DNS-only records (no Cloudflare proxy).

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
| Room-first input (SimpleFloorPlanInput) | Agents specify rooms; system generates walls, polygons, canvas |
| Tools not Prompts for templates | Prompts are client-initiated; agents cannot call `prompts/get` mid-conversation |
| CTA via env var (CTA_VARIANT) | Variant switching with no code redeploy — wrangler secret change only |
| `shouldSendProtocolMessages() → false` | Prevents Agent framework's `CF_AGENT_STATE` noise on WebSocket; we use our own protocol |
| Deterministic chunk IDs | Hash of `articleId:heading` stays stable across sync cycles, keeping agent_insights references valid |
| Chunking in sync pipeline | Design knowledge extracted inline during Zendesk sync, not as a separate pass |
| JSON arrays for tags | `room_types`/`design_aspects` stored as JSON, filtered via `json_each()` in FTS queries |
| `env.WORKER_URL` for MCP URL | Setup page shows custom domain, not raw workers.dev — only place absolute URLs are needed |
| Relative links in all pages | Home, setup, upload, sketcher use relative paths for proxy transparency |
| Tool descriptions enforce update-first | `generate_floor_plan` says "don't use if sketch exists"; `update_sketch` says "prefer this" |
| `xMidYMin meet` when sheet expanded | Top-aligns content in SVG so floor plan stays visible above the bottom sheet |
| Bottom sheet peek = 100px | Includes handle + Save/SVG buttons fully visible above mobile browser chrome |
| `@cf-wasm/resvg` for rasterization | CF Workers-optimized wrapper handles WASM init pitfalls; adds ~1MB gzip to bundle (total ~1.4MB, under 3MB free tier) |
| `preview_sketch` as separate tool | Agent chooses when to verify visually; doesn't bloat every generate/update response |
| `analyze_floor_plan_image` returns inline image | MCP clients can't always fetch arbitrary URLs; inline image lets agent verify CV output |
| CV on Hetzner, not Workers | OpenCV + Tesseract need native binaries; can't run in V8 isolate |
| DNS-only A record for CV | Workers can't fetch bare IPs (error 1003); domain name on non-standard port works fine |
| Image upload to D1 | Simple storage for temporary images; no external blob service needed |
| Direct DOM updates during drag | `setAttribute()` on wall lines + handle circles avoids full innerHTML rebuild; full `render()` only on mouseup for performance |
| Grab offset on drag start | Stores cursor-to-endpoint offset at mousedown; prevents handle jump when drawer/sheet changes SVG layout |
| Delta-based room polygon propagation | Applies drag delta to room vertices (not snap-to-endpoint) to preserve inward thickness offset |
| Batch undo for multi-wall drags | Single endpoint drag that moves N connected walls + room polygons = 1 undo step |
| `btoa()` chunked encoding for base64 | Node `Buffer` unavailable in Cloudflare Workers runtime; chunked `String.fromCharCode` + `btoa` works |
| XML escaping in SVG text | `escXml()` prevents XSS from user-provided room labels and furniture types |
