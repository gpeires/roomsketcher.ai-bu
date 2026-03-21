# RoomSketcher Help MCP — Architecture

> Living architecture document for the core system. New major features get their own `docs/arch/<feature>/ARCH.md`.

## Overview

A **hybrid AI + manual floor plan sketcher** on Cloudflare Workers with a computer vision pipeline on Hetzner. It combines:

1. **Help documentation MCP** — Zendesk articles synced to D1, searchable via MCP tools
2. **AI floor plan sketcher** — Claude generates floor plans from natural language, users edit in a browser SPA, changes sync in real-time via WebSocket
3. **Design knowledge system** — Articles chunked, tagged, and indexed for AI-driven design recommendations
4. **CV floor plan extraction** — OpenCV + Tesseract pipeline on Hetzner that analyzes floor plan images and extracts room geometries, labels, and dimensions
5. **AI-layered CV pipeline** — 4 Workers AI vision specialists run in parallel with CV, results merged via centroid-distance matching

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
                 │   ├─ 21 strategies     │
                 │   │  multi-strategy    │
                 │   │  room-level merge  │
                 │   ├─ OpenCV pipeline   │
                 │   └─ Tesseract OCR     │
                 └────────────────────────┘

         Cloudflare AI Gateway (roomsketcher-ai)
                 ┌────────────────────────┐
                 │  4 Vision Specialists  │
                 │  ├─ Room Namer         │
                 │  ├─ Layout Describer   │
                 │  ├─ Symbol Spotter     │
                 │  └─ Dimension Reader   │
                 │                        │
                 │  Model: llama-3.2-11b  │
                 │  -vision-instruct      │
                 └────────────────────────┘
```

---

## Development

### Commands

```bash
# Worker (Cloudflare)
npm run dev                    # Local dev server (wrangler dev)
npm test                       # Run vitest tests
bash deploy.sh                 # Deploy to production (NEVER use wrangler deploy directly)

# DB migrations
npm run db:migrate             # Apply schema locally
npm run db:migrate:remote      # Apply schema to production D1

# CV service (Hetzner)
cd cv-service && .venv/bin/python -m pytest -v  # Run CV pipeline tests (142 tests)
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
│   ├── compile-layout.ts       # SimpleFloorPlanInput → FloorPlan compiler (room-first → walls)
│   ├── geometry.ts             # shoelaceArea, centroid, boundingBox, pointInPolygon
│   ├── changes.ts              # applyChanges() — immutable state machine
│   ├── persistence.ts          # D1 load/save/cleanup for sketches
│   ├── svg.ts                  # floorPlanToSvg() — server-side SVG renderer
│   ├── tools.ts                # 7 MCP tool handlers for sketch ops + CV analyze
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
│   ├── orchestrator.ts          # Image fetch, CV service call, specialist dispatch, merge
│   ├── merge.ts                 # Centroid-distance matching, label normalization, deduplication
│   ├── specialists.ts           # Prompts + response parsers for 4 vision specialists
│   ├── validate.ts              # Merged result validation (optional feedback loop)
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
│   ├── strategies.py           # 26 preprocessing strategies (STRATEGIES registry, StrategyResult)
│   ├── merge.py                # Room-level clustering across strategies (cluster_rooms, assemble_rooms)
│   ├── enhance.py              # Image enhancement (CLAHE + bilateral filter + unsharp mask)
│   ├── preprocess.py           # Binary wall mask extraction (threshold + edge fallback)
│   ├── walls.py                # Wall line detection via morphological extraction
│   ├── rooms.py                # Room detection + polygon extraction + closed mask export
│   ├── openings.py             # Door detection (wall-gap scanning) + window detection (exterior breaks)
│   ├── topology.py             # Room adjacency via mask dilation overlap
│   ├── ocr.py                  # Tesseract OCR + merge_nearby_text() for split dimension reassembly
│   ├── dimensions.py           # Parse metric/imperial/compound dimensions to cm
│   └── output.py               # Map CV detections to SimpleFloorPlanInput JSON (rect or polygon)
├── tests/
│   ├── conftest.py             # Synthetic floor plan image fixtures (2-room, L-shaped, low-contrast)
│   ├── test_app.py             # FastAPI endpoint tests
│   ├── test_enhance.py         # Enhancement algorithm + pick_winner tests (10 tests)
│   ├── test_merge.py           # Room clustering, bbox IoU, assemble_rooms tests (17 tests)
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
├── docker-compose.yml          # Single-service compose for local/prod
├── deploy-hetzner.sh           # One-command deploy: rsync + docker compose up
└── requirements.txt            # FastAPI, OpenCV, pytesseract, httpx
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
| `update_room` | room_id, polygon?, area? |
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

The pipeline uses **multi-strategy room-level merging**: run 21 preprocessing strategies in parallel, detect rooms per strategy, cluster overlapping rooms across strategies, then run the full pipeline once on an anchor strategy's binary mask.

```
analyze_image(image)
  ├── Step 1: Run 21 strategies in parallel → binary masks
  │   (EXCLUDED_STRATEGIES: lab_a_channel, lab_b_channel, saturation, top_hat_otsu, black_hat)
  ├── Step 2: detect_rooms() per strategy in parallel → rooms per strategy
  ├── Step 3: cluster_rooms() — cluster spatially overlapping rooms across strategies
  │   ├── Pool all rooms tagged with source strategy
  │   ├── Sort by area descending (largest = best representative)
  │   ├── Greedy clustering: IoU >= 0.3 or centroid distance < 15% diagonal
  │   └── Confidence: 5+ strategies=0.9, 3-4=0.7, 2=0.5, 1=0.3
  ├── Step 4: Pick anchor strategy (most rooms) for walls/openings/scale
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
  └── build_floor_plan_input(rooms, text, scale, openings, adjacency) → JSON
```

**Why room-level merging, not wall-level?** Bitwise OR of wall masks is destructive — accumulated wall noise from many strategies fills room interiors, destroying rooms. Room-level clustering is monotonic: it can only ADD rooms, never destroy them. On the critical 520 W 23rd test image, wall-level merge produced 0 rooms from 13 contributing strategies; room-level merge recovered 5 rooms.

**Sweep endpoint** (`/sweep`): Runs all 26 strategies (including excluded ones) and returns per-strategy results with debug binary masks. Used for diagnostics and strategy evaluation.

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
  "meta": {
    "image_size": [1200, 800],
    "scale_cm_per_px": 1.25,
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

1. **Close door gaps** — morphological close with a kernel sized to span realistic door openings (15–80px, capped at image_dim/10). Returns `(rooms, closed_binary)` — the closed mask is reused by opening detection.
2. **Invert** — rooms become white regions
3. **Connected components** — each region with area > 1% of image area becomes a room
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
2. **Assign to rooms** — primary: check if label center falls inside room's binary mask. Fallback: check if label center is inside room's bounding box.
3. **Room-name filtering** — a word list (~40 common room names like "bedroom", "kitchen", "foyer") filters OCR noise. Title-case alphabetic words of 4+ chars are also accepted.

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
- A horizontal dimension label (wider than tall) matches only horizontal walls
- The text must fall within the wall's span along the parallel axis (±20% margin)
- Maximum perpendicular distance: 15% of image dimension (tighter than the previous 30%)
- Compute `cm / wall_pixel_length` for each match
- Use the median as the scale factor to reject outliers
- Fallback: `1000 / image_width` (assumes 10m-wide floor plan)

### Deployment

```bash
# One-command deploy to Hetzner
./cv-service/deploy-hetzner.sh <server-ip> [ssh-key-path]
```

The script: installs Docker if needed, opens port 8100 via ufw, rsyncs the cv-service directory, runs `docker compose up --build -d`, and verifies via health check.

### FastAPI Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/analyze` | POST | Multi-strategy merge: run 21 strategies, cluster rooms, return merged result |
| `/sweep` | POST | Diagnostics: run all 26 strategies independently, return per-strategy results with debug binary masks |

The `/analyze` endpoint accepts either `image` (base64) or `image_url` (fetched server-side via httpx). Returns `{name, rooms[], openings[], adjacency[], meta}`. Rooms have `confidence` (0.3-0.9) and `found_by` (list of strategy names). Meta includes `strategies_run`, `strategies_contributing`, `merge_stats`, `merge_time_ms`, and `preprocessing` with anchor strategy info.

The `/sweep` endpoint runs all 26 strategies (including excluded ones) and returns `{image_size, strategies[]}` where each strategy entry has the full pipeline result plus `debug_binary` (base64 PNG of the binary wall mask) and `time_ms`.

---

## AI-Layered CV Pipeline (2026-03-19 — 2026-03-21)

### Overview

The `analyze_floor_plan_image` MCP tool runs **CV + 4 AI vision specialists in parallel**, then merges results. This was added to compensate for CV's weakness on complex real-world floor plans.

```
analyze_floor_plan_image(image_url)
  ↓
Worker fetches image bytes, encodes to base64
  ↓
┌──────────── Parallel ────────────┐
│                                  │
│  CV Service (Hetzner)            │  Workers AI (Cloudflare AI Gateway)
│  POST /analyze                   │  4 vision specialists:
│  └─ 21-strategy multi-merge     │  ├─ Room Namer → ["Kitchen", "Bedroom", ...]
│     └─ room-level clustering    │  ├─ Layout Describer → {room_count, rooms[{name, position, size}]}
│                                  │  ├─ Symbol Spotter → [{type: "Toilet", position: "bottom-left"}]
│  Returns: CVResult               │  └─ Dimension Reader → [{text: "10'2\"x15'8\"", room: "Bedroom"}]
│  (rooms w/ confidence+found_by)  │
└──────────┬───────────────────────┘
           ↓
     Tier Rooms (src/ai/orchestrator.ts)
       ├─ tierRooms(): split CV rooms by confidence
       │   ├─ forAI: confidence >= 0.5 → sent to AI merge
       │   └─ hintBank: confidence < 0.5 → held back
           ↓
     Merge (src/ai/merge.ts) — uses only forAI rooms
       ├─ Centroid-distance matching: map AI rooms to CV rooms
       ├─ Label normalization: "Toilet" → Bathroom, "Bed" → Bedroom
       ├─ Deduplication: overlapping regions merged
       ├─ Confidence scoring: CV confidence preserved (0.3-0.9), specialist agreement = +0.15-0.2
       └─ Fallback: if CV finds 0 rooms, AI specialists provide all room data
           ↓
     Validate (src/ai/validate.ts)
       └─ Optional feedback loop via validator specialist
           ↓
     Reconcile Hint Bank (src/ai/orchestrator.ts)
       └─ reconcileHintBank(): add non-overlapping hint bank rooms (IoU < 0.3)
           ↓
     Returns: PipelineOutput JSON (ready for generate_floor_plan)
```

### Specialist Details

| Specialist | Model | Prompt Summary | Response Parser |
|-----------|-------|----------------|-----------------|
| Room Namer | `@cf/meta/llama-3.2-11b-vision-instruct` | "List every room label visible" | `parseRoomNamerResponse` |
| Layout Describer | same | "Count rooms, describe position (3x3 grid) & size" | `parseLayoutDescriberResponse` |
| Symbol Spotter | same | "Find fixtures: toilet, sink, bed, stove..." | `parseSymbolSpotterResponse` |
| Dimension Reader | same | "Extract measurement text & room association" | `parseDimensionReaderResponse` |

Routed through **AI Gateway** (`roomsketcher-ai`) for caching, retries, and rate limiting.

**Error handling:** Each specialist has a 30s timeout. Bad JSON is repaired via `jsonrepair`. If a specialist fails, merge proceeds with partial data (returns `SpecialistFailure` with error message).

### Merge Algorithm (`src/ai/merge.ts`)

1. **Grid-based position mapping** — AI specialists report room positions on a 3x3 grid (top-left, center, bottom-right). These are mapped to pixel coordinates based on image dimensions.
2. **Centroid-distance matching** — Each AI-identified room is matched to the nearest CV room by centroid distance. Unmatched AI rooms become new rooms (AI-only).
3. **Label normalization** — `SYMBOL_ROOM_MAP` maps fixture names to room types (e.g., "Toilet" → "Bathroom", "Stove" → "Kitchen"). Fuzzy matching handles partial labels.
4. **Confidence scoring** — CV rooms keep their multi-strategy confidence (0.3-0.9). Each specialist that corroborates a room adds +0.15-0.2, capped at 1.0.
5. **Split hints** — When AI finds significantly more rooms than CV (3+ gap), remaining CV rooms get `split_hint: true` with evidence strings.

### Neuron Budget Tracking

Workers AI charges by "neurons" (compute units). The system tracks daily usage in `ai_neuron_usage` D1 table:
- Budget: 50,000 neurons/day (configurable via `DEFAULT_CONFIG.neuronBudget`)
- Buffer: 5,000 neurons (skip AI when within buffer of limit)
- Each specialist call costs ~625 neurons (4 calls = ~2,500 per analysis)
- Budget checked before each analysis; if exceeded, CV-only results returned

### CV Preprocessing Strategies (2026-03-20)

The CV service has **26 preprocessing strategies** registered in `cv/strategies.py`, of which **21 are active** (5 excluded for zero yield). Each strategy transforms the input image into a form optimized for wall/room detection.

**Strategy categories:**
- **Direct binarization** (8): raw, otsu, adaptive_large, canny_dilate, downscale, morph_gradient, sauvola, median_otsu
- **Enhancement + binarization** (4): enhanced (CLAHE+bilateral+unsharp), heavy_bilateral, clahe_aggressive, hsv_value
- **Edge-based** (5): sobel_magnitude, log_edges, dog_edges, hough_lines, multi_scale
- **Local adaptive** (3): niblack, wolf, bilateral_adaptive
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

**Merge stats** added to `meta.merge_stats`:
```json
{"high": 5, "medium": 1, "low": 1, "total": 7}
```

### TypeScript Types (`src/ai/types.ts`)

```typescript
// Specialist result types
RoomNamerResult, LayoutDescriberResult, SymbolSpotterResult, DimensionReaderResult
SpecialistFailure  // { ok: false, specialist, error }

// CV service output
CVRoom { label, x, y, width, depth, polygon?, confidence?, found_by? }
CVResult { name, rooms: CVRoom[], meta: { ..., preprocessing?: { strategy_used, anchor_strategy?, strategies_run?, strategies_contributing? } } }

// Merge output
MergedRoom { label, x, y, width, depth, type, confidence, sources[], split_hint?, split_evidence? }

// Full pipeline
GatherResults { cv, roomNamer, layoutDescriber, symbolSpotter, dimensionReader }
PipelineOutput { name, rooms: MergedRoom[], openings, adjacency, meta: { ..., specialists_succeeded, specialists_failed, merge_stats?, merge_time_ms? } }
PipelineConfig { ai, db, cvServiceUrl, model, fallbackModel, timeouts, neuronBudget }

// Orchestrator exports
tierRooms(rooms: CVRoom[]) → { forAI: CVRoom[], hintBank: CVRoom[] }
reconcileHintBank(merged: MergedRoom[], hintBank: CVRoom[], imageSize) → MergedRoom[]
```

---

## Known Issues & Status (as of 2026-03-21)

### Resolved: CV finds 0 rooms on real-world floor plans

**Fixed by multi-strategy merge.** The old raw+enhanced pipeline found 0 rooms on complex floor plans. The new 21-strategy room-level merge recovers rooms from multiple preprocessing strategies. On the critical 520 W 23rd image: old pipeline found 0, multi-strategy merge finds 5 CV rooms + 4 AI-only rooms = 9 total.

### Resolved: Letterboxed images caused 0 rooms in threshold strategies

**Fixed (2026-03-21).** Floor plan images with black letterbox bars (sidebars, top/bottom bars from PDF rendering) contaminated threshold-based strategies — black bars became ~40% wall density, destroying room detection. `remove_letterbox()` in `preprocess.py` now scans inward from each edge and fills uniformly dark strips with white before any strategy runs. On 520 W 23rd: raw went from 0→5 rooms, multi_scale from 0→5, otsu from 0→4.

### Open: Thick walls and structural columns in luxury floor plans

**Status: Unsolved.** Architectural floor plans (e.g., 547 W 47th) draw walls as filled rectangles (8-20px thick) and columns as small filled squares/circles. The pipeline struggles with these:

- **Thin-edge splitting** — Threshold strategies (raw, otsu) detect thick walls as parallel thin edges instead of solid fills. `raw` on 547 W 47th: gradient_ratio=0.494 (half the wall pixels are edge-only), only 4 rooms detected.
- **Over-filling** — Strategies that DO fill thick walls (multi_scale, downscale) also merge furniture and room content into the wall mask. `multi_scale` on 547 W 47th: 24.5% density (vs. ideal ~10%), 6 rooms but with furniture artifacts.
- **The morphological close trap** — A larger morphological close (7x7) bridges parallel wall edges but ALSO merges furniture into walls — exactly the multi_scale failure mode. This is why a simple `prepare()` fix doesn't work.
- **Columns** — Captured naturally by strategies that handle thick walls (multi_scale, downscale find 2-3 column-like blobs on 547 W 47th). But since those strategies also over-fill, columns aren't reliably isolated. Columns don't appear in RoomSketcher sketch output, so detection only has value as intermediate structural reasoning (e.g., perimeter anchoring).

**Empirical data (547 W 47th):**

| Strategy | Rooms | Density | Gradient Ratio | Issue |
|----------|-------|---------|----------------|-------|
| multi_scale | 6 | 24.5% | 0.203 (solid) | Over-fills furniture |
| raw | 4 | 11.1% | 0.494 (mixed) | Thin edges, missing rooms |
| adaptive_large | 3 | 9.2% | 0.897 (thin) | Edge-only walls |

**Next steps:** Solving this likely requires either (a) wall vs. furniture classification (structural elements are elongated and connected, furniture is isolated), or (b) a two-pass approach where edges are detected first, then filled only within connected wall-like structures. The current room-level merge partially compensates by clustering rooms across strategies, but the underlying wall mask quality limits room detection accuracy.

### Quality: CV room detection still imperfect

Multi-strategy merge improved room counts but quality issues remain:
- **~~OCR label concatenation~~** — FIXED (2026-03-21). `output.py` now picks the single best label per room (prefers known room words, breaks ties by centroid proximity) instead of concatenating all matches.
- **Logo/text regions detected as rooms** — "COMPASS", "WEST RESIDENCE CLUB CONDOMINIUMS" appear as rooms. The CV pipeline doesn't filter non-room regions (logos, legends, titles).
- **~~Large merged rooms~~** — FIXED (2026-03-21). `merge.py` now excludes rooms exceeding 50% of image area from clustering.

### Quality: Sketch generation from CV+AI data

The generated sketches don't closely match source images:
- **CV polygon geometry is real** but often irregular/noisy
- **AI-only rooms use estimated geometry** — grid-cell positions (3x3) and estimated sizes, not real pixel coordinates
- **No spatial constraint solver** — rooms placed at raw coordinates without overlap resolution
- **Furniture placement is approximate** — Symbol Spotter detects fixtures but gives grid-cell positions, not pixel coords

### Resolved: Worker-side merge now uses CV confidence data

FIXED (2026-03-21). `merge.ts` now uses `room.confidence ?? 0.3` as the starting confidence instead of hardcoded 0.3. CV rooms found by 5+ strategies (confidence 0.9) retain their high confidence through the AI merge layer.

### Preprocessing metadata now flows through

`meta.cv_preprocessing` in `PipelineOutput` contains `{ strategy_used, anchor_strategy, strategies_run, strategies_contributing }`. Specialist errors surfaced in `meta.specialist_errors`.

### Minor: Furniture catalog gaps

Missing items: dishwasher, oven, washer/dryer, kitchen island, fireplace, AC unit. Tracked in `project_furniture_catalog_gaps.md`.

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
- Copy-to-clipboard URL output
- Hint text directing users to paste URL in Claude conversation

### Image Storage

Images stored as base64 text in D1 `uploaded_images` table. Served via `GET /api/images/:id` with appropriate `Content-Type` and 1-hour cache headers. UUIDs as IDs.

---

## Agent Workflows

### Copy Mode (Reference Image → Floor Plan)

When a user provides a floor plan image to replicate:

```
Step 1 — ANALYZE IMAGE
  analyze_floor_plan_image(image_url) → CV extracts:
    - rooms (rect or polygon format, coords normalized to origin)
    - openings (doors between rooms, windows on exterior walls)
    - adjacency (which rooms share walls, with orientation + length)
    - meta (scale, counts)
  Agent sees: source image (inline) + CV JSON

Step 2 — REVIEW & ADJUST
  Agent compares CV output against source image visually
  Fixes: misdetected labels, merged open-plan rooms, scale errors
  Uses adjacency data to verify room connectivity
  Uses polygon rooms for L-shaped/irregular spaces
  Rounds dimensions to nearest 10cm

Step 3 — REFINE OPENINGS
  CV now provides detected doors/windows — agent verifies and adjusts
  Adds any missed openings based on source image
  Interior: {type, between: [room1, room2]}
  Exterior: {type, room, wall: "north"|...}

Step 4 — ADD FURNITURE
  Agent places only furniture visible in reference image
  Positions relative to room top-left corner

Step 5 — GENERATE
  generate_floor_plan(adjusted data) → preview_sketch → verify → fix
```

### Template Mode (Description → Floor Plan)

When a user describes what they want:

```
search_design_knowledge (per room type)
  → list_templates → pick closest match
  → get_template → adapt dimensions/rooms/furniture
  → generate_floor_plan → preview_sketch (visual verification)
  → fix issues via update_sketch → preview_sketch again if needed
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

Tool descriptions enforce the loop:
- `generate_floor_plan` marks the loop as **required** — agents must not present a plan they haven't visually verified
- `preview_sketch` describes itself as "your eyes" with a 5-point checklist (wall overlaps, furniture placement, missing openings, room sizing, label readability)
- `update_sketch` requires preview after structural changes but allows skipping for cosmetic edits
- **Iteration budget:** If the user provided a reference image or detailed measurements, 1 preview check suffices. For vague descriptions, expect 1–2 fix rounds. Max 3 iterations total to keep wait time under ~30 seconds.

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
└── furniture[]: {type, room, x, y, width, depth}
```

This is the primary input format used by both template mode and copy mode (CV output maps directly to this schema).

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
**Features:** Snap-to-grid, multi-snap system, pan/zoom, keyboard shortcuts, real-time WebSocket sync, properties panel, furniture rendered with architectural symbols, undo/redo, visual filter dimming, wall endpoint dragging with connected wall auto-follow, room polygon propagation, furniture rotation handles
**State:** `plan`, `tool`, `selected`, `drawStart`, `viewBox`, `ws`, `dragState`, `undoStack`, `redoStack`, `interactionMode`
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
| `rotating_furniture` | Drag on rotation handle | Furniture rotation in progress |
| `panning` | Drag on empty canvas | ViewBox translation |

### Wall Endpoint Dragging

Drag handles (teal circles, r=6 desktop / r=14 mobile) appear at wall endpoints when a wall is selected. Dragging an endpoint:

1. **Grab offset** — On drag start, stores the offset between cursor position and endpoint position. The endpoint stays under the finger/cursor throughout the drag (no jump on first frame).
2. **Connected wall auto-follow** — `findConnectedEndpoints()` finds walls sharing a point (1cm threshold). Connected walls move together. Hold Alt/Option to detach and move independently.
3. **Multi-snap system** — During drag, `computeSnap()` tests snap targets in priority order: endpoint (15px) > perpendicular (10px) > alignment (10px) > midpoint (10px) > grid (always). Snap guide lines render as an SVG overlay.
4. **Direct DOM update** — During drag, only `setAttribute()` calls on wall `<line>` and handle `<circle>` elements (no full `render()`). WebSocket broadcast throttled to 10fps via `sendWsThrottled()`.
5. **Commit on mouseup** — `commitEndpointDrag()` builds change + inverse-change arrays for the undo stack, propagates room polygons, clears snap guides, and does a full `render()`.

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
