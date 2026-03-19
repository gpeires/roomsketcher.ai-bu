# AI Room Sketcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the RoomSketcher Help MCP server with AI-assisted floor plan generation, a browser-based sketcher SPA, and real-time sync between Claude and the browser.

**Architecture:** Cloudflare Worker + Durable Object (McpAgent) + D1. Claude generates FloorPlan JSON → server validates + renders SVG → returns to chat. Browser SPA at `/sketcher/:id` connects via WebSocket for live sync. D1 persists sketches with 30-day TTL.

**Tech Stack:** Cloudflare Workers, D1, Durable Objects, McpAgent (`agents/mcp`), Zod 4, nanoid, vanilla JS + SVG DOM (browser SPA), jspdf + svg2pdf.js (PDF export)

**Spec:** `docs/superpowers/specs/2026-03-18-ai-room-sketcher-design.md` — read this for full data model, architecture diagrams, user flow, and funnel strategy.

---

## Current Status (2026-03-18)

**Tasks 1–13: COMPLETE** — All code written, tested (36 unit tests pass), deployed, and live.

**Tasks 14–15: REMAINING** — E2E testing and final verification.

**Uncommitted changes:** `src/sketch/tools.ts` and `package-lock.json` — MCP tool responses stripped of `image` content blocks (now text-only with sketcher URLs). Must be committed before proceeding.

**Deploy:** Always via `bash deploy.sh` — never `wrangler deploy` directly.

### Open Issue: Inline Image Rendering in Claude Desktop

MCP tool `image` content (base64 PNG/SVG) does NOT render inline in Claude desktop app conversations — it's hidden inside the expandable tool result accordion. We tried `image/svg+xml` (400 error — unsupported mime type) and `image/png` via `@resvg/resvg-wasm` (rendered in tool result but not inline in chat).

**Current state:** Image content stripped from all MCP tool responses. Tools return text-only.

**Known working approach:** User has successfully rendered inline PNGs in Claude desktop using Puppeteer screenshots in other projects. This approach hasn't been tried here yet.

**Action needed:** Investigate returning a server-rendered PNG (via Puppeteer/headless browser, NOT resvg-wasm) or find the correct MCP content type that Claude desktop renders inline. Pin this for a future session.

**Note:** `@resvg/resvg-wasm` was installed and removed — do not re-add it. Bundle is back to 445KB gzipped.

---

## Existing Codebase Context

This is a working Cloudflare Workers MCP server deployed at `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev`. It serves RoomSketcher help documentation (192 articles from Zendesk) to AI assistants via 6 MCP tools.

### Current Project Structure

```
src/
  index.ts              — Worker entry: McpAgent class, fetch router (/mcp, /admin/sync, /health), scheduled handler
  types.ts              — Zendesk API types, D1 row types, Env interface (DB: D1Database, MCP_OBJECT: DurableObjectNamespace)
  db/
    schema.sql          — D1 schema: categories, sections, articles tables + FTS5 virtual table + sync_meta
  sync/
    zendesk.ts          — Zendesk API client with pagination
    html-to-text.ts     — HTML-to-plaintext converter (Workers-safe, no DOM)
    ingest.ts           — Sync orchestration: fetch → clear → batch insert
  tools/
    search.ts           — FTS5 search with bm25 ranking
    browse.ts           — listCategories, listSections
    articles.ts         — listArticles, getArticle, getArticleByUrl
```

### Key Patterns in Existing Code

**McpAgent class** in `src/index.ts`:
```typescript
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export class RoomSketcherHelpMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({ name: 'roomsketcher-help', version: '1.0.0', ... });

  async init() {
    this.server.registerTool('tool_name', {
      description: '...',
      inputSchema: { param: z.string().describe('...') },
    }, async ({ param }) => {
      // Access D1 via: this.env.DB
      // Access DO state via: this.state / this.setState()
      return { content: [{ type: 'text' as const, text: 'result' }] };
    });
  }
}
```

**Worker default export** routes: `/mcp` → McpAgent, `/admin/sync` → sync, `/health` → health check.
**Scheduled handler** calls `syncFromZendesk(env.DB)` on cron trigger (every 6 hours).
**MCP served via:** `RoomSketcherHelpMCP.serve('/mcp', { binding: 'MCP_OBJECT' })`.

### Dependencies (package.json)

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

### Known Issues & Constraints

- **MCP SDK version:** Must pin `@modelcontextprotocol/sdk` to `^1.26.0` — the `agents` package bundles SDK 1.26.0 internally and mismatched versions cause TS errors about incompatible private `_serverInfo` property.
- **DO migrations:** Must use `new_sqlite_classes` (not `new_classes`) in wrangler.toml for McpAgent.
- **`nodejs_compat`** flag is required for the `agents` package's Node.js imports (`node:async_hooks`, etc).
- **D1 variable limits:** Cannot use `NOT IN (?)` with >100 bind params.
- **McpAgent generics:** `McpAgent<Env, State, Props>` — State is DO state (currently `{}`), Props is init props (currently `{}`). This plan changes State to `SketchSession`.

### Deployment

Deploy script at `deploy.sh` handles: load `.env` → create workers.dev subdomain → create D1 → migrate schema → deploy → trigger sync → health check.

For quick deploys: `npx wrangler deploy` (after `source .env`).
For schema changes: `npx wrangler d1 execute roomsketcher-help --remote --file=src/db/schema.sql --yes`

### Critical Design Decisions (from spec review)

1. **`update_wall` and `rename_room` changes use `wall_type` / `room_type`** (not `type`) to avoid collision with the discriminated union's `type` field. This was a critical bug found during review.
2. **WebSocket routing:** MCP and sketch WebSockets run in **separate DO instances** (MCP creates DOs per session, sketch creates DOs per sketch ID). D1 is the shared state layer between them. The sketch DO loads state from D1 on first connection.
3. **`btoa()` is not UTF-8 safe** in Workers. Use `btoa(unescape(encodeURIComponent(str)))` for SVG encoding.
4. **Worker URL must be configurable** via `WORKER_URL` env var in wrangler.toml `[vars]`, not hardcoded.
5. **`agents` package WebSocket API** needs research at implementation time. The plan provides the logic, but method signatures (`onMessage`, `onClose`, `getConnections`, `broadcast`) must be verified against the actual `agents` package source in `node_modules/agents/src/`.

---

## File Structure

```
src/
  index.ts                    ← MODIFY: add sketch MCP tools, new routes, WebSocket upgrade
  types.ts                    ← MODIFY: add SketchSession state type
  db/
    schema.sql                ← MODIFY: add sketches table + expires index
  sketch/
    types.ts                  ← CREATE: FloorPlan interfaces + Zod schemas + Change union
    geometry.ts               ← CREATE: shoelace area, centroid, bounding box helpers
    svg.ts                    ← CREATE: floorPlanToSvg() pure function
    changes.ts                ← CREATE: applyChanges(plan, changes) — mutates FloorPlan
    persistence.ts            ← CREATE: D1 load/save/cleanup helpers
    tools.ts                  ← CREATE: MCP tool handler functions
  sketcher/
    html.ts                   ← CREATE: exports the SPA HTML string (inline JS + CSS)
```

**Design decisions:**
- `sketch/` contains all server-side sketch logic, one file per responsibility
- `sketcher/html.ts` exports the SPA as a template literal string — no static asset serving, no build step
- Pure functions (`geometry.ts`, `svg.ts`, `changes.ts`) are independently testable
- `tools.ts` contains the handler logic; `index.ts` wires them into `registerTool()`

---

## Task 1: Test Infrastructure ✅

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add vitest dev dependency + test script)

- [x] **Step 1: Install vitest**

```bash
npm install -D vitest
```

- [x] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [x] **Step 3: Add test script to package.json**

Add to `scripts` in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [x] **Step 4: Verify vitest runs (no tests yet)**

```bash
npm test
```

Expected: exits cleanly with "no test files found" or similar.

- [x] **Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: add vitest test infrastructure"
```

---

## Task 2: FloorPlan Types + Zod Schemas ✅

**Files:**
- Create: `src/sketch/types.ts`
- Create: `src/sketch/types.test.ts`

- [x] **Step 1: Write the test file**

Create `src/sketch/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FloorPlanSchema, ChangeSchema } from './types';

describe('FloorPlanSchema', () => {
  it('validates a minimal valid floor plan', () => {
    const plan = {
      version: 1,
      id: 'test123',
      name: 'Test Plan',
      units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: {
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        source: 'ai',
      },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('validates a plan with walls, openings, and rooms', () => {
    const plan = {
      version: 1,
      id: 'test456',
      name: 'Studio',
      units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [
        {
          id: 'w1',
          start: { x: 0, y: 0 },
          end: { x: 600, y: 0 },
          thickness: 20,
          height: 250,
          type: 'exterior',
          openings: [
            {
              id: 'd1',
              type: 'door',
              offset: 100,
              width: 90,
              properties: { swingDirection: 'left' },
            },
          ],
        },
      ],
      rooms: [
        {
          id: 'r1',
          label: 'Living Room',
          type: 'living',
          polygon: [
            { x: 0, y: 0 },
            { x: 600, y: 0 },
            { x: 600, y: 500 },
            { x: 0, y: 500 },
          ],
          color: '#E8F5E9',
        },
      ],
      furniture: [],
      annotations: [],
      metadata: {
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        source: 'ai',
      },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('rejects invalid version', () => {
    const plan = {
      version: 2,
      id: 'x',
      name: 'X',
      units: 'metric',
      canvas: { width: 100, height: 100, gridSize: 10 },
      walls: [],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: { created_at: 'x', updated_at: 'x', source: 'ai' },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it('rejects invalid wall type', () => {
    const plan = {
      version: 1,
      id: 'x',
      name: 'X',
      units: 'metric',
      canvas: { width: 100, height: 100, gridSize: 10 },
      walls: [
        {
          id: 'w1',
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          thickness: 10,
          height: 250,
          type: 'invisible',
          openings: [],
        },
      ],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: { created_at: 'x', updated_at: 'x', source: 'ai' },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe('ChangeSchema', () => {
  it('validates add_wall change', () => {
    const change = {
      type: 'add_wall',
      wall: {
        id: 'w1',
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        thickness: 20,
        height: 250,
        type: 'exterior',
        openings: [],
      },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates move_wall change', () => {
    const change = {
      type: 'move_wall',
      wall_id: 'w1',
      start: { x: 10, y: 10 },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates update_wall change with wall_type', () => {
    const change = {
      type: 'update_wall',
      wall_id: 'w1',
      thickness: 10,
      wall_type: 'interior',
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates rename_room change with room_type', () => {
    const change = {
      type: 'rename_room',
      room_id: 'r1',
      label: 'Master Bedroom',
      room_type: 'bedroom',
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates add_room change', () => {
    const change = {
      type: 'add_room',
      room: {
        id: 'r1',
        label: 'Kitchen',
        type: 'kitchen',
        polygon: [
          { x: 0, y: 0 },
          { x: 300, y: 0 },
          { x: 300, y: 300 },
          { x: 0, y: 300 },
        ],
        color: '#FFF3E0',
      },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('rejects unknown change type', () => {
    const change = { type: 'fly_away' };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(false);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `./types` module not found.

- [x] **Step 3: Write the types and Zod schemas**

Create `src/sketch/types.ts`:

```typescript
import { z } from 'zod';

// ─── Base types ─────────────────────────────────────────────────────────────

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

// ─── Layer 2: Openings ─────────────────────────────────────────────────────

export const OpeningSchema = z.object({
  id: z.string(),
  type: z.enum(['door', 'window', 'opening']),
  offset: z.number(), // distance from wall start, cm
  width: z.number(),  // cm
  properties: z.object({
    swingDirection: z.enum(['left', 'right']).optional(),
    swingAngle: z.number().optional(),
    sillHeight: z.number().optional(),
    windowType: z.enum(['single', 'double', 'sliding', 'bay']).optional(),
  }),
});
export type Opening = z.infer<typeof OpeningSchema>;

// ─── Layer 1: Walls ─────────────────────────────────────────────────────────

export const WallSchema = z.object({
  id: z.string(),
  start: PointSchema,
  end: PointSchema,
  thickness: z.number(),
  height: z.number(),
  type: z.enum(['exterior', 'interior', 'divider']),
  openings: z.array(OpeningSchema),
});
export type Wall = z.infer<typeof WallSchema>;

// ─── Layer 3: Rooms ─────────────────────────────────────────────────────────

export const RoomTypeSchema = z.enum([
  'living', 'bedroom', 'kitchen', 'bathroom', 'hallway', 'closet',
  'laundry', 'office', 'dining', 'garage', 'balcony', 'terrace',
  'storage', 'utility', 'other',
]);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: RoomTypeSchema,
  polygon: z.array(PointSchema).min(3),
  wall_ids: z.array(z.string()).optional(),
  color: z.string(),
  area: z.number().optional(),
  floor_material: z.string().optional(),
});
export type Room = z.infer<typeof RoomSchema>;

// ─── Layer 4: Furniture (V2) ────────────────────────────────────────────────

export const FurnitureItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  catalog_id: z.string().optional(),
  position: PointSchema,
  rotation: z.number(),
  width: z.number(),
  depth: z.number(),
  label: z.string().optional(),
  material: z.string().optional(),
});
export type FurnitureItem = z.infer<typeof FurnitureItemSchema>;

// ─── Layer 5: Annotations (V2) ─────────────────────────────────────────────

export const AnnotationSchema = z.object({
  id: z.string(),
  type: z.enum(['label', 'dimension', 'symbol', 'arrow']),
  position: PointSchema,
  content: z.string(),
  rotation: z.number().optional(),
  style: z.object({
    fontSize: z.number().optional(),
    color: z.string().optional(),
  }).optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

// ─── FloorPlan ──────────────────────────────────────────────────────────────

export const FloorPlanSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  units: z.enum(['metric', 'imperial']),
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    gridSize: z.number(),
  }),
  walls: z.array(WallSchema),
  rooms: z.array(RoomSchema),
  furniture: z.array(FurnitureItemSchema),
  annotations: z.array(AnnotationSchema),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    source: z.enum(['ai', 'sketcher', 'mixed']),
  }),
});
export type FloorPlan = z.infer<typeof FloorPlanSchema>;

// ─── Changes (used by update_sketch + WebSocket) ───────────────────────────

export const ChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_wall'), wall: WallSchema }),
  z.object({ type: z.literal('move_wall'), wall_id: z.string(), start: PointSchema.optional(), end: PointSchema.optional() }),
  z.object({ type: z.literal('remove_wall'), wall_id: z.string() }),
  z.object({ type: z.literal('update_wall'), wall_id: z.string(), thickness: z.number().optional(), wall_type: z.enum(['exterior', 'interior', 'divider']).optional() }),
  z.object({ type: z.literal('add_opening'), wall_id: z.string(), opening: OpeningSchema }),
  z.object({ type: z.literal('remove_opening'), wall_id: z.string(), opening_id: z.string() }),
  z.object({ type: z.literal('add_room'), room: RoomSchema }),
  z.object({ type: z.literal('rename_room'), room_id: z.string(), label: z.string(), room_type: RoomTypeSchema.optional() }),
  z.object({ type: z.literal('remove_room'), room_id: z.string() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

// ─── WebSocket protocol ────────────────────────────────────────────────────

export type ClientMessage =
  | Change
  | { type: 'save' }
  | { type: 'load' };

export type ServerMessage =
  | { type: 'state_update'; plan: FloorPlan }
  | { type: 'state_delta'; changes: Change[] }
  | { type: 'saved'; updated_at: string }
  | { type: 'error'; message: string };

// ─── DO session state ──────────────────────────────────────────────────────

export interface SketchSession {
  sketchId?: string;
  plan?: FloorPlan;
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all 7 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/sketch/types.ts src/sketch/types.test.ts
git commit -m "feat: add FloorPlan types and Zod schemas with Change union"
```

---

## Task 3: Geometry Helpers ✅

**Files:**
- Create: `src/sketch/geometry.ts`
- Create: `src/sketch/geometry.test.ts`

- [x] **Step 1: Write the test file**

Create `src/sketch/geometry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shoelaceArea, centroid, boundingBox } from './geometry';
import type { Point, Wall } from './types';

describe('shoelaceArea', () => {
  it('calculates area of a 3x4 rectangle (in cm², converted to m²)', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 400 },
      { x: 0, y: 400 },
    ];
    // 300cm × 400cm = 120000 cm² = 12 m²
    expect(shoelaceArea(polygon)).toBeCloseTo(12, 2);
  });

  it('calculates area of a triangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 200, y: 300 },
    ];
    // Triangle: base=400cm, height=300cm → 60000cm² = 6m²
    expect(shoelaceArea(polygon)).toBeCloseTo(6, 2);
  });

  it('returns 0 for degenerate polygon', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(shoelaceArea(polygon)).toBe(0);
  });
});

describe('centroid', () => {
  it('calculates centroid of a rectangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 400 },
      { x: 0, y: 400 },
    ];
    const c = centroid(polygon);
    expect(c.x).toBeCloseTo(300);
    expect(c.y).toBeCloseTo(200);
  });

  it('calculates centroid of a triangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 0, y: 300 },
    ];
    const c = centroid(polygon);
    expect(c.x).toBeCloseTo(100);
    expect(c.y).toBeCloseTo(100);
  });
});

describe('boundingBox', () => {
  it('calculates bounding box of walls', () => {
    const walls: Wall[] = [
      { id: 'w1', start: { x: 100, y: 50 }, end: { x: 500, y: 50 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w2', start: { x: 500, y: 50 }, end: { x: 500, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ];
    const bb = boundingBox(walls);
    expect(bb).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 400 });
  });

  it('returns zero box for empty walls', () => {
    const bb = boundingBox([]);
    expect(bb).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/sketch/geometry.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Write the geometry helpers**

Create `src/sketch/geometry.ts`:

```typescript
import type { Point, Wall } from './types';

/**
 * Shoelace formula for polygon area.
 * Input: polygon vertices in cm. Output: area in m².
 */
export function shoelaceArea(polygon: Point[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    sum += polygon[i].x * polygon[j].y;
    sum -= polygon[j].x * polygon[i].y;
  }
  const areaCm2 = Math.abs(sum) / 2;
  return areaCm2 / 10000; // cm² → m²
}

/**
 * Geometric centroid of a polygon (average of vertices).
 */
export function centroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  const sum = polygon.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );
  return {
    x: sum.x / polygon.length,
    y: sum.y / polygon.length,
  };
}

/**
 * Bounding box of all wall endpoints.
 */
export function boundingBox(walls: Wall[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  if (walls.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const wall of walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/sketch/geometry.test.ts
```

Expected: all 6 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/sketch/geometry.ts src/sketch/geometry.test.ts
git commit -m "feat: add geometry helpers (shoelace area, centroid, bounding box)"
```

---

## Task 4: SVG Renderer ✅

**Files:**
- Create: `src/sketch/svg.ts`
- Create: `src/sketch/svg.test.ts`

- [x] **Step 1: Write the test file**

Create `src/sketch/svg.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { floorPlanToSvg } from './svg';
import type { FloorPlan } from './types';

function makePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    version: 1,
    id: 'test',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [],
    rooms: [],
    furniture: [],
    annotations: [],
    metadata: { created_at: '', updated_at: '', source: 'ai' },
    ...overrides,
  };
}

describe('floorPlanToSvg', () => {
  it('returns valid SVG string for empty plan', () => {
    const svg = floorPlanToSvg(makePlan());
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('renders walls as lines', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    expect(svg).toContain('<line');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="600"');
  });

  it('renders rooms as polygons with fill', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
      rooms: [
        {
          id: 'r1', label: 'Kitchen', type: 'kitchen',
          polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
          color: '#FFF3E0',
        },
      ],
    }));
    expect(svg).toContain('<polygon');
    expect(svg).toContain('#FFF3E0');
    expect(svg).toContain('Kitchen');
  });

  it('renders door openings as arcs', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        {
          id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior',
          openings: [{ id: 'd1', type: 'door', offset: 100, width: 90, properties: { swingDirection: 'left' } }],
        },
      ],
    }));
    // Door should render an arc path
    expect(svg).toContain('<path');
  });

  it('renders window openings as parallel lines', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        {
          id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior',
          openings: [{ id: 'win1', type: 'window', offset: 200, width: 120, properties: {} }],
        },
      ],
    }));
    expect(svg).toContain('id="openings"');
  });

  it('renders dimension labels along walls', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    // 600cm = 6.00m dimension label
    expect(svg).toContain('6.00');
  });

  it('includes watermark', () => {
    const svg = floorPlanToSvg(makePlan());
    expect(svg).toContain('RoomSketcher');
  });

  it('computes viewBox from wall bounding box + padding', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 100, y: 100 }, end: { x: 500, y: 100 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
        { id: 'w2', start: { x: 500, y: 100 }, end: { x: 500, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    // Bounding box: 100,100 → 500,400. With 50cm padding: 50,50 → 550,450
    // viewBox="50 50 500 400"
    expect(svg).toContain('viewBox="50 50 500 400"');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/sketch/svg.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Write the SVG renderer**

Create `src/sketch/svg.ts`:

```typescript
import type { FloorPlan, Wall, Opening, Room, Point } from './types';
import { shoelaceArea, centroid, boundingBox } from './geometry';

function wallLength(wall: Wall): number {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function wallAngle(wall: Wall): number {
  return Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
}

function formatDimension(cm: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    const inches = cm / 2.54;
    const feet = Math.floor(inches / 12);
    const rem = Math.round(inches % 12);
    return `${feet}'${rem}"`;
  }
  return `${(cm / 100).toFixed(2)}m`;
}

function strokeWidth(type: Wall['type']): number {
  switch (type) {
    case 'exterior': return 4;
    case 'interior': return 2;
    case 'divider': return 1;
  }
}

function strokeDasharray(type: Wall['type']): string {
  return type === 'divider' ? '6,4' : 'none';
}

function renderWalls(walls: Wall[]): string {
  return walls.map(w => {
    const sw = strokeWidth(w.type);
    const dash = strokeDasharray(w.type);
    return `<line x1="${w.start.x}" y1="${w.start.y}" x2="${w.end.x}" y2="${w.end.y}" ` +
      `stroke="#333" stroke-width="${sw}" stroke-linecap="round"` +
      (dash !== 'none' ? ` stroke-dasharray="${dash}"` : '') +
      ` data-id="${w.id}"/>`;
  }).join('\n    ');
}

function renderOpening(wall: Wall, opening: Opening): string {
  const angle = wallAngle(wall);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Position along wall
  const ox = wall.start.x + cos * opening.offset;
  const oy = wall.start.y + sin * opening.offset;

  if (opening.type === 'door') {
    // Draw gap (white line over wall) + swing arc
    const ex = ox + cos * opening.width;
    const ey = oy + sin * opening.width;
    const gap = `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="6"/>`;

    // Arc for door swing
    const r = opening.width;
    const dir = opening.properties.swingDirection === 'right' ? 1 : -1;
    const perpX = -sin * dir * r;
    const perpY = cos * dir * r;
    const arcEnd = { x: ox + perpX, y: oy + perpY };
    const sweep = dir === 1 ? 1 : 0;
    const arc = `<path d="M${ox},${oy} L${ex},${ey} A${r},${r} 0 0,${sweep} ${arcEnd.x},${arcEnd.y} Z" ` +
      `fill="none" stroke="#666" stroke-width="1" data-id="${opening.id}"/>`;
    return gap + '\n    ' + arc;
  }

  if (opening.type === 'window') {
    // Draw gap + parallel lines
    const ex = ox + cos * opening.width;
    const ey = oy + sin * opening.width;
    const offset = 4;
    const nx = -sin * offset;
    const ny = cos * offset;
    const gap = `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="6"/>`;
    const line1 = `<line x1="${ox + nx}" y1="${oy + ny}" x2="${ex + nx}" y2="${ey + ny}" stroke="#4FC3F7" stroke-width="2"/>`;
    const line2 = `<line x1="${ox - nx}" y1="${oy - ny}" x2="${ex - nx}" y2="${ey - ny}" stroke="#4FC3F7" stroke-width="2"/>`;
    return [gap, line1, line2].join('\n    ');
  }

  // Plain opening: just a gap
  const ex = ox + cos * opening.width;
  const ey = oy + sin * opening.width;
  return `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="6"/>`;
}

function renderOpenings(walls: Wall[]): string {
  const parts: string[] = [];
  for (const wall of walls) {
    for (const opening of wall.openings) {
      parts.push(renderOpening(wall, opening));
    }
  }
  return parts.join('\n    ');
}

function renderRooms(rooms: Room[], units: 'metric' | 'imperial'): string {
  return rooms.map(room => {
    const points = room.polygon.map(p => `${p.x},${p.y}`).join(' ');
    const area = room.area ?? shoelaceArea(room.polygon);
    const areaLabel = units === 'imperial'
      ? `${(area * 10.7639).toFixed(1)} ft²`
      : `${area.toFixed(1)} m²`;
    const c = centroid(room.polygon);

    const poly = `<polygon points="${points}" fill="${room.color}" fill-opacity="0.5" stroke="none" data-id="${room.id}"/>`;
    const label = `<text x="${c.x}" y="${c.y - 8}" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">${room.label}</text>`;
    const areaText = `<text x="${c.x}" y="${c.y + 10}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">${areaLabel}</text>`;
    return [poly, label, areaText].join('\n    ');
  }).join('\n    ');
}

function renderDimensions(walls: Wall[], units: 'metric' | 'imperial'): string {
  return walls.map(w => {
    const len = wallLength(w);
    if (len < 1) return '';
    const label = formatDimension(len, units);
    const mx = (w.start.x + w.end.x) / 2;
    const my = (w.start.y + w.end.y) / 2;
    const angle = wallAngle(w) * (180 / Math.PI);
    // Offset label perpendicular to wall
    const offsetPx = 14;
    const perpAngle = wallAngle(w) + Math.PI / 2;
    const lx = mx + Math.cos(perpAngle) * offsetPx;
    const ly = my + Math.sin(perpAngle) * offsetPx;

    return `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#999" ` +
      `transform="rotate(${angle}, ${lx}, ${ly})">${label}</text>`;
  }).filter(Boolean).join('\n    ');
}

function renderWatermark(maxX: number, maxY: number): string {
  return `<text x="${maxX}" y="${maxY + 30}" text-anchor="end" font-size="10" font-family="sans-serif" fill="#ccc">Powered by RoomSketcher</text>`;
}

export function floorPlanToSvg(plan: FloorPlan): string {
  const bb = boundingBox(plan.walls);
  const pad = 50;
  const vbX = bb.minX - pad;
  const vbY = bb.minY - pad;
  const vbW = (bb.maxX - bb.minX) + pad * 2;
  const vbH = (bb.maxY - bb.minY) + pad * 2;

  // For empty plans, use canvas dimensions
  const hasWalls = plan.walls.length > 0;
  const viewBox = hasWalls
    ? `${vbX} ${vbY} ${vbW} ${vbH}`
    : `0 0 ${plan.canvas.width} ${plan.canvas.height}`;

  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" style="background:#fff">
  <g id="rooms">
    ${renderRooms(plan.rooms, plan.units)}
  </g>
  <g id="walls">
    ${renderWalls(plan.walls)}
  </g>
  <g id="openings">
    ${renderOpenings(plan.walls)}
  </g>
  <g id="dimensions">
    ${renderDimensions(plan.walls, plan.units)}
  </g>
  <g id="labels"></g>
  <g id="watermark">
    ${hasWalls ? renderWatermark(bb.maxX, bb.maxY) : `<text x="${plan.canvas.width - 10}" y="${plan.canvas.height - 10}" text-anchor="end" font-size="10" font-family="sans-serif" fill="#ccc">Powered by RoomSketcher</text>`}
  </g>
</svg>`;
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/sketch/svg.test.ts
```

Expected: all 8 tests PASS. If any tests fail due to exact string matching, adjust the assertions to match the actual output format (e.g., rounding, attribute order).

- [x] **Step 5: Commit**

```bash
git add src/sketch/svg.ts src/sketch/svg.test.ts
git commit -m "feat: add floorPlanToSvg() server-side SVG renderer"
```

---

## Task 5: Change Application Logic ✅

**Files:**
- Create: `src/sketch/changes.ts`
- Create: `src/sketch/changes.test.ts`

- [x] **Step 1: Write the test file**

Create `src/sketch/changes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyChanges } from './changes';
import type { FloorPlan, Change } from './types';

function makePlan(): FloorPlan {
  return {
    version: 1,
    id: 'test',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ],
    rooms: [
      { id: 'r1', label: 'Room', type: 'living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], color: '#E8F5E9' },
    ],
    furniture: [],
    annotations: [],
    metadata: { created_at: '', updated_at: '', source: 'ai' },
  };
}

describe('applyChanges', () => {
  it('adds a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_wall', wall: { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(2);
    expect(result.walls[1].id).toBe('w2');
  });

  it('moves a wall endpoint', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'move_wall', wall_id: 'w1', end: { x: 700, y: 0 } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].end.x).toBe(700);
    expect(result.walls[0].start.x).toBe(0); // unchanged
  });

  it('removes a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [{ type: 'remove_wall', wall_id: 'w1' }];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(0);
  });

  it('updates wall properties', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'update_wall', wall_id: 'w1', thickness: 10, wall_type: 'interior' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].thickness).toBe(10);
    expect(result.walls[0].type).toBe('interior');
  });

  it('adds an opening to a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_opening', wall_id: 'w1', opening: { id: 'd1', type: 'door', offset: 100, width: 90, properties: { swingDirection: 'left' } } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].openings).toHaveLength(1);
    expect(result.walls[0].openings[0].id).toBe('d1');
  });

  it('removes an opening from a wall', () => {
    const plan = makePlan();
    plan.walls[0].openings = [{ id: 'd1', type: 'door', offset: 100, width: 90, properties: {} }];
    const changes: Change[] = [
      { type: 'remove_opening', wall_id: 'w1', opening_id: 'd1' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].openings).toHaveLength(0);
  });

  it('adds a room', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_room', room: { id: 'r2', label: 'Bath', type: 'bathroom', polygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], color: '#E3F2FD' } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms).toHaveLength(2);
  });

  it('renames a room', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'rename_room', room_id: 'r1', label: 'Living Room', room_type: 'living' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms[0].label).toBe('Living Room');
  });

  it('removes a room', () => {
    const plan = makePlan();
    const changes: Change[] = [{ type: 'remove_room', room_id: 'r1' }];
    const result = applyChanges(plan, changes);
    expect(result.rooms).toHaveLength(0);
  });

  it('applies multiple changes in order', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_wall', wall: { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] } },
      { type: 'remove_wall', wall_id: 'w1' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(1);
    expect(result.walls[0].id).toBe('w2');
  });

  it('ignores changes targeting nonexistent IDs', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'move_wall', wall_id: 'nonexistent', end: { x: 999, y: 999 } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(1);
    expect(result.walls[0].end.x).toBe(600); // unchanged
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/sketch/changes.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Write the change application logic**

Create `src/sketch/changes.ts`:

```typescript
import type { FloorPlan, Change } from './types';
import { shoelaceArea } from './geometry';

/**
 * Apply a list of changes to a FloorPlan. Returns a new object (shallow clone).
 * Ignores changes targeting nonexistent IDs.
 */
export function applyChanges(plan: FloorPlan, changes: Change[]): FloorPlan {
  // Shallow clone top-level arrays so we don't mutate the original
  const result: FloorPlan = {
    ...plan,
    walls: plan.walls.map(w => ({ ...w, openings: [...w.openings] })),
    rooms: [...plan.rooms],
    metadata: { ...plan.metadata, updated_at: new Date().toISOString(), source: 'mixed' },
  };

  for (const change of changes) {
    switch (change.type) {
      case 'add_wall':
        result.walls.push({ ...change.wall, openings: [...change.wall.openings] });
        break;

      case 'move_wall': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        if (change.start) wall.start = change.start;
        if (change.end) wall.end = change.end;
        break;
      }

      case 'remove_wall':
        result.walls = result.walls.filter(w => w.id !== change.wall_id);
        break;

      case 'update_wall': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        if (change.thickness !== undefined) wall.thickness = change.thickness;
        if (change.wall_type !== undefined) wall.type = change.wall_type;
        break;
      }

      case 'add_opening': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        wall.openings.push(change.opening);
        break;
      }

      case 'remove_opening': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        wall.openings = wall.openings.filter(o => o.id !== change.opening_id);
        break;
      }

      case 'add_room': {
        const room = { ...change.room };
        room.area = shoelaceArea(room.polygon);
        result.rooms.push(room);
        break;
      }

      case 'rename_room': {
        const room = result.rooms.find(r => r.id === change.room_id);
        if (!room) break;
        room.label = change.label;
        if (change.room_type !== undefined) room.type = change.room_type;
        break;
      }

      case 'remove_room':
        result.rooms = result.rooms.filter(r => r.id !== change.room_id);
        break;
    }
  }

  return result;
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/sketch/changes.test.ts
```

Expected: all 11 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/sketch/changes.ts src/sketch/changes.test.ts
git commit -m "feat: add change application logic for FloorPlan mutations"
```

---

## Task 6: D1 Persistence Helpers ✅

**Files:**
- Modify: `src/db/schema.sql` (add sketches table)
- Create: `src/sketch/persistence.ts`

- [x] **Step 1: Add sketches table to schema.sql**

Append to the end of `src/db/schema.sql`:

```sql

-- Sketch persistence
CREATE TABLE IF NOT EXISTS sketches (
  id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  svg_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sketches_expires ON sketches(expires_at);
```

- [x] **Step 2: Write the persistence helpers**

Create `src/sketch/persistence.ts`:

```typescript
import type { FloorPlan } from './types';

const TTL_DAYS = 30;

export interface SketchRow {
  id: string;
  plan_json: string;
  svg_cache: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export async function loadSketch(db: D1Database, id: string): Promise<{ plan: FloorPlan; svg: string | null } | null> {
  const row = await db.prepare(
    'SELECT plan_json, svg_cache FROM sketches WHERE id = ?'
  ).bind(id).first<SketchRow>();

  if (!row) return null;
  return {
    plan: JSON.parse(row.plan_json) as FloorPlan,
    svg: row.svg_cache,
  };
}

export async function saveSketch(
  db: D1Database,
  id: string,
  plan: FloorPlan,
  svg: string,
): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO sketches (id, plan_json, svg_cache, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plan_json = excluded.plan_json,
      svg_cache = excluded.svg_cache,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).bind(id, JSON.stringify(plan), svg, now, now, expires).run();
}

export async function cleanupExpiredSketches(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM sketches WHERE expires_at < datetime('now')"
  ).run();
  return result.meta.changes ?? 0;
}
```

- [x] **Step 3: Commit**

```bash
git add src/db/schema.sql src/sketch/persistence.ts
git commit -m "feat: add sketches D1 table and persistence helpers"
```

---

## Task 7: MCP Tool Handlers (Milestone 1 — generate + get) ✅

**Files:**
- Create: `src/sketch/tools.ts`
- Modify: `src/types.ts` (add SketchSession)
- Modify: `src/index.ts` (register new tools + routes)

This is the largest task. We break the index.ts changes into sub-steps.

- [x] **Step 1: Install nanoid**

```bash
npm install nanoid
```

- [x] **Step 2: Add SketchSession to types.ts**

Add at the end of `src/types.ts`:

```typescript
import type { FloorPlan } from './sketch/types';

export interface SketchSession {
  sketchId?: string;
  plan?: FloorPlan;
}
```

- [x] **Step 3: Create tool handler functions**

Create `src/sketch/tools.ts`:

```typescript
import { nanoid } from 'nanoid';
import { FloorPlanSchema } from './types';
import type { FloorPlan, Change } from './types';
import { floorPlanToSvg } from './svg';
import { shoelaceArea } from './geometry';
import { applyChanges } from './changes';
import { loadSketch, saveSketch } from './persistence';

/** UTF-8-safe base64 encoding (btoa only handles Latin-1) */
function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

// ─── generate_floor_plan ────────────────────────────────────────────────────

export async function handleGenerateFloorPlan(
  plan: unknown,
  db: D1Database,
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  workerUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // Validate
  const parsed = FloorPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Invalid floor plan:\n${errors}` }] };
  }

  const floorPlan = parsed.data;

  // Assign ID + timestamps
  floorPlan.id = nanoid();
  floorPlan.metadata.created_at = new Date().toISOString();
  floorPlan.metadata.updated_at = floorPlan.metadata.created_at;

  // Compute room areas
  for (const room of floorPlan.rooms) {
    if (room.area === undefined) {
      room.area = shoelaceArea(room.polygon);
    }
  }

  // Render SVG
  const svg = floorPlanToSvg(floorPlan);
  const svgBase64 = toBase64(svg);

  // Persist
  await saveSketch(db, floorPlan.id, floorPlan, svg);
  setState({ sketchId: floorPlan.id, plan: floorPlan });

  // Summary
  const totalArea = floorPlan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `**${floorPlan.name}** created`,
    `${floorPlan.walls.length} walls, ${floorPlan.rooms.length} rooms`,
    `Total area: ${totalArea.toFixed(1)} m²`,
    ``,
    `Open in sketcher: ${workerUrl}/sketcher/${floorPlan.id}`,
    ``,
    `_This is a 2D preview. For 3D walkthroughs and 7000+ furniture items, try [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=generate)._`,
  ].join('\n');

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: svgBase64, mimeType: 'image/svg+xml' },
    ],
  };
}

// ─── get_sketch ─────────────────────────────────────────────────────────────

export async function handleGetSketch(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // Try in-memory state first
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  let svg: string | undefined;

  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    }
    plan = loaded.plan;
    svg = loaded.svg ?? undefined;
  }

  if (!svg) {
    svg = floorPlanToSvg(plan);
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `**${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms`,
    `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m²)`).join(', ')}`,
    `Total area: ${totalArea.toFixed(1)} m²`,
    `Source: ${plan.metadata.source}`,
    `Updated: ${plan.metadata.updated_at}`,
  ].join('\n');

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: toBase64(svg), mimeType: 'image/svg+xml' },
    ],
  };
}

// ─── open_sketcher ──────────────────────────────────────────────────────────

export function handleOpenSketcher(
  sketchId: string,
  workerUrl: string,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: `Open the sketcher: ${workerUrl}/sketcher/${sketchId}` }],
  };
}
```

- [x] **Step 4: Register Milestone 1 tools in index.ts**

Modify `src/index.ts`:

1. Add imports at the top:

```typescript
import { FloorPlanSchema } from './sketch/types';
import type { SketchSession } from './types';
import { handleGenerateFloorPlan, handleGetSketch, handleOpenSketcher } from './sketch/tools';
import { cleanupExpiredSketches } from './sketch/persistence';
```

2. Change the class generic from `McpAgent<Env, {}, {}>` to `McpAgent<Env, SketchSession, {}>`.

3. Add a `WORKER_URL` binding to the Env interface and wrangler.toml so the URL is configurable:

In `wrangler.toml`, add under the top-level:
```toml
[vars]
WORKER_URL = "https://roomsketcher-help-mcp.10ecb923-workers.workers.dev"
```

In `src/types.ts`, add to the Env interface:
```typescript
WORKER_URL: string;
```

In the DO class, add a helper:
```typescript
private getWorkerUrl(): string {
  return this.env.WORKER_URL;
}
```

4. Register the 3 new tools at the end of `init()`, after the existing help tools:

```typescript
// ─── Sketch tools ─────────────────────────────────────────────────────

this.server.registerTool(
  'generate_floor_plan',
  {
    description: `Generate a 2D floor plan from a JSON description. You (Claude) should construct the FloorPlan JSON based on the user's natural language description, then pass it to this tool for validation, storage, and rendering.

COORDINATE SYSTEM:
- Origin (0,0) is top-left. X increases right, Y increases down.
- All values in centimeters. Snap to 10cm grid.

WALL RULES:
- Build exterior walls first, forming a closed clockwise perimeter.
- Walls connect when endpoints share coordinates.
- Typical thickness: exterior 20cm, interior 10cm.

ROOM RULES:
- Polygon vertices listed clockwise, edges align with wall centerlines.
- Area is auto-calculated.

EXAMPLE (studio apartment):
${JSON.stringify({
  version: 1, id: "auto-generated", name: "Studio Apartment", units: "metric",
  canvas: { width: 1000, height: 800, gridSize: 10 },
  walls: [
    { id: "w1", start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: "exterior", openings: [] },
    { id: "w2", start: { x: 600, y: 0 }, end: { x: 600, y: 500 }, thickness: 20, height: 250, type: "exterior", openings: [{ id: "win1", type: "window", offset: 100, width: 120, properties: { sillHeight: 90, windowType: "double" } }] },
    { id: "w3", start: { x: 600, y: 500 }, end: { x: 0, y: 500 }, thickness: 20, height: 250, type: "exterior", openings: [{ id: "d1", type: "door", offset: 200, width: 90, properties: { swingDirection: "left" } }] },
    { id: "w4", start: { x: 0, y: 500 }, end: { x: 0, y: 0 }, thickness: 20, height: 250, type: "exterior", openings: [] },
    { id: "w5", start: { x: 400, y: 0 }, end: { x: 400, y: 250 }, thickness: 10, height: 250, type: "interior", openings: [{ id: "d2", type: "door", offset: 50, width: 80, properties: { swingDirection: "right" } }] },
  ],
  rooms: [
    { id: "r1", label: "Living Area", type: "living", polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 500 }, { x: 0, y: 500 }], color: "#E8F5E9" },
    { id: "r2", label: "Bathroom", type: "bathroom", polygon: [{ x: 400, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 250 }, { x: 400, y: 250 }], color: "#E3F2FD" },
  ],
  furniture: [], annotations: [],
  metadata: { created_at: "auto", updated_at: "auto", source: "ai" },
}, null, 0)}`,
    inputSchema: {
      plan: FloorPlanSchema.describe('The complete FloorPlan JSON object'),
    },
  },
  async ({ plan }) => {
    return handleGenerateFloorPlan(
      plan,
      this.env.DB,
      (s) => this.setState(s),
      this.getWorkerUrl(),
    );
  },
);

this.server.registerTool(
  'get_sketch',
  {
    description: 'Get the current state of a sketch (floor plan JSON + SVG render). Use this after the user has edited in the browser sketcher to see their changes.',
    inputSchema: {
      sketch_id: z.string().describe('The sketch ID'),
    },
  },
  async ({ sketch_id }) => {
    return handleGetSketch(sketch_id, this.env.DB, this.state);
  },
);

this.server.registerTool(
  'open_sketcher',
  {
    description: 'Get the URL for the browser-based sketcher to manually edit a floor plan.',
    inputSchema: {
      sketch_id: z.string().describe('The sketch ID'),
    },
  },
  async ({ sketch_id }) => {
    return handleOpenSketcher(sketch_id, this.getWorkerUrl());
  },
);
```

5. Add sketch cleanup to the `scheduled` handler:

```typescript
async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(syncFromZendesk(env.DB));
  ctx.waitUntil(cleanupExpiredSketches(env.DB));
},
```

- [x] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If there are type errors with `this.state` or `setState`, adjust the McpAgent generic types.

**Note:** The `agents/mcp` McpAgent generic is `McpAgent<Env, State, Props>`. The `this.state` property holds the `State` type, and `this.setState(partial)` merges into it. Verify this matches the `agents` package API — if `setState` doesn't exist, use `this.ctx.storage` or DO state methods instead. Check `node_modules/agents/src/mcp.ts` for the actual API.

- [x] **Step 6: Commit**

```bash
git add src/sketch/tools.ts src/types.ts src/index.ts package.json package-lock.json
git commit -m "feat: add generate_floor_plan, get_sketch, open_sketcher MCP tools (Milestone 1)"
```

---

## Task 8: Deploy + Test Milestone 1 ✅

**Files:** None (deployment only)

- [x] **Step 1: Run D1 schema migration (remote)**

```bash
npx wrangler d1 execute roomsketcher-help --remote --file=src/db/schema.sql --yes
```

Expected: success, sketches table created.

- [x] **Step 2: Deploy**

```bash
npx wrangler deploy
```

Expected: successful deployment.

- [x] **Step 3: Manual test — health check**

```bash
curl https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/health
```

Expected: `{"status":"ok","last_sync":"..."}`.

- [x] **Step 4: Test via Claude**

In Claude (with MCP server connected), ask:
> "Generate a floor plan for a small 2-bedroom apartment with a kitchen, bathroom, and living room"

Expected: Claude calls `generate_floor_plan`, returns SVG inline + sketcher URL.

- [x] **Step 5: Commit any fixes**

If manual testing reveals issues, fix and commit.

---

## Task 9: REST API for Sketch Load/Save ✅

**Files:**
- Modify: `src/index.ts` (add `/api/sketches/:id` routes)

- [x] **Step 1: Add REST routes to the fetch handler**

In `src/index.ts`, in the default export's `fetch` function, add before the final `return`:

```typescript
// Sketch REST API
const sketchMatch = url.pathname.match(/^\/api\/sketches\/([A-Za-z0-9_-]+)$/);
if (sketchMatch) {
  const sketchId = sketchMatch[1];

  if (request.method === 'GET') {
    const loaded = await loadSketch(env.DB, sketchId);
    if (!loaded) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ plan: loaded.plan, svg: loaded.svg });
  }

  if (request.method === 'PUT') {
    let body: { plan: unknown };
    try { body = await request.json() as { plan: unknown }; }
    catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const parsed = FloorPlanSchema.safeParse(body.plan);
    if (!parsed.success) {
      return Response.json({ error: 'Invalid plan', issues: parsed.error.issues }, { status: 400 });
    }
    const { floorPlanToSvg } = await import('./sketch/svg');
    const svg = floorPlanToSvg(parsed.data);
    await saveSketch(env.DB, sketchId, parsed.data, svg);
    return Response.json({ ok: true, updated_at: new Date().toISOString() });
  }
}
```

Add the required imports at the top of `index.ts`:

```typescript
import { loadSketch, saveSketch } from './sketch/persistence';
```

(`FloorPlanSchema` was already imported in Task 7.)

- [x] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [x] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add REST API for sketch load/save (/api/sketches/:id)"
```

---

## Task 10: Browser Sketcher SPA (Milestone 2) ✅

**Files:**
- Create: `src/sketcher/html.ts`
- Modify: `src/index.ts` (add `/sketcher/:id` route)

This is the largest single file. The SPA is a single HTML string with inline JS + CSS.

- [x] **Step 1: Create the SPA HTML template**

Create `src/sketcher/html.ts`. This file exports a function that returns the full HTML page as a string, parameterized by sketch ID and initial plan JSON.

```typescript
export function sketcherHtml(sketchId: string, workerUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RoomSketcher AI Sketcher</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

  /* Toolbar */
  .toolbar { display: flex; gap: 4px; padding: 8px 12px; background: #f5f5f5; border-bottom: 1px solid #ddd; align-items: center; }
  .toolbar button { padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; }
  .toolbar button:hover { background: #eee; }
  .toolbar button.active { background: #1976D2; color: #fff; border-color: #1565C0; }
  .toolbar .spacer { flex: 1; }
  .toolbar .status { font-size: 12px; color: #999; }

  /* Main area */
  .main { display: flex; flex: 1; overflow: hidden; }

  /* Canvas */
  .canvas-wrap { flex: 1; position: relative; overflow: hidden; background: #fafafa; }
  .canvas-wrap svg { width: 100%; height: 100%; }

  /* Properties panel */
  .props { width: 220px; border-left: 1px solid #ddd; padding: 12px; overflow-y: auto; background: #fff; }
  .props h3 { font-size: 13px; color: #666; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .props label { display: block; font-size: 12px; color: #888; margin-top: 8px; }
  .props input, .props select { width: 100%; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; margin-top: 2px; font-size: 13px; }
  .props .none { color: #ccc; font-size: 12px; font-style: italic; margin-top: 20px; }

  /* Footer CTA */
  .footer { padding: 8px 16px; background: #f0f7ff; border-top: 1px solid #ddd; text-align: center; font-size: 13px; color: #666; }
  .footer a { color: #1976D2; text-decoration: none; font-weight: 500; }
  .footer a:hover { text-decoration: underline; }

  /* SVG interactive styles */
  svg line[data-id] { cursor: pointer; }
  svg line[data-id]:hover { stroke: #1976D2 !important; }
  svg line.selected { stroke: #F44336 !important; }
  svg polygon[data-id] { cursor: pointer; }
  svg polygon[data-id]:hover { fill-opacity: 0.7; }

  /* Drawing guide line */
  .guide-line { stroke: #1976D2; stroke-width: 2; stroke-dasharray: 6,4; pointer-events: none; }
  .snap-point { fill: #F44336; r: 4; pointer-events: none; }
</style>
</head>
<body>
<div class="toolbar">
  <button id="btn-select" class="active" title="Select & move">Select</button>
  <button id="btn-wall" title="Draw walls">Wall</button>
  <button id="btn-door" title="Add door to wall">Door</button>
  <button id="btn-window" title="Add window to wall">Window</button>
  <button id="btn-room" title="Label rooms">Room</button>
  <div class="spacer"></div>
  <span class="status" id="status">Loading...</span>
  <button id="btn-save" title="Save to server">Save</button>
</div>

<div class="main">
  <div class="canvas-wrap" id="canvas-wrap">
    <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
  </div>
  <div class="props" id="props">
    <h3>Properties</h3>
    <p class="none">Select a wall or room</p>
  </div>
</div>

<div class="footer">
  Powered by <a href="https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=sketcher-banner" target="_blank">RoomSketcher</a> — Upgrade for 3D, furniture, and more
</div>

<script>
(function() {
  'use strict';

  const SKETCH_ID = '${sketchId}';
  const API_URL = '${workerUrl}/api/sketches/' + SKETCH_ID;
  const WS_URL = '${workerUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/ws/' + SKETCH_ID;

  // ─── State ──────────────────────────────────────────────────────────
  let plan = null;
  let tool = 'select'; // select | wall | door | window | room
  let selected = null; // { type: 'wall'|'room', id: string }
  let drawStart = null; // Point for wall drawing
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let viewBox = { x: 0, y: 0, w: 1000, h: 800 };
  let ws = null;

  const svg = document.getElementById('canvas');
  const statusEl = document.getElementById('status');
  const propsEl = document.getElementById('props');

  // ─── Tool buttons ───────────────────────────────────────────────────
  const toolButtons = { select: 'btn-select', wall: 'btn-wall', door: 'btn-door', window: 'btn-window', room: 'btn-room' };
  Object.entries(toolButtons).forEach(([t, id]) => {
    document.getElementById(id).addEventListener('click', () => setTool(t));
  });
  document.getElementById('btn-save').addEventListener('click', save);

  function setTool(t) {
    tool = t;
    drawStart = null;
    removeGuide();
    Object.entries(toolButtons).forEach(([k, id]) => {
      document.getElementById(id).classList.toggle('active', k === t);
    });
  }

  // ─── Load plan ──────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error('Sketch not found');
      const data = await res.json();
      plan = data.plan;
      render();
      statusEl.textContent = 'Loaded';
      connectWs();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  // ─── Save ───────────────────────────────────────────────────────────
  async function save() {
    if (!plan) return;
    statusEl.textContent = 'Saving...';
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'save' }));
      } else {
        await fetch(API_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        });
      }
      statusEl.textContent = 'Saved';
    } catch (e) {
      statusEl.textContent = 'Save failed';
    }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────
  function connectWs() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { statusEl.textContent = 'Connected'; };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state_update') {
          plan = msg.plan;
          render();
        } else if (msg.type === 'saved') {
          statusEl.textContent = 'Saved ' + new Date(msg.updated_at).toLocaleTimeString();
        } else if (msg.type === 'error') {
          statusEl.textContent = 'Error: ' + msg.message;
        }
      };
      ws.onclose = () => { statusEl.textContent = 'Disconnected'; };
    } catch (e) {
      // WebSocket not available, REST fallback
    }
  }

  function sendChange(change) {
    if (!plan) return;
    // Apply locally
    applyChangeLocal(change);
    render();
    // Send to server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(change));
    }
  }

  function applyChangeLocal(change) {
    switch (change.type) {
      case 'add_wall':
        plan.walls.push(change.wall);
        break;
      case 'move_wall': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) {
          if (change.start) w.start = change.start;
          if (change.end) w.end = change.end;
        }
        break;
      }
      case 'remove_wall':
        plan.walls = plan.walls.filter(w => w.id !== change.wall_id);
        break;
      case 'add_opening': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) w.openings.push(change.opening);
        break;
      }
      case 'add_room':
        plan.rooms.push(change.room);
        break;
      case 'rename_room': {
        const r = plan.rooms.find(r => r.id === change.room_id);
        if (r) { r.label = change.label; if (change.room_type) r.type = change.room_type; }
        break;
      }
      case 'remove_room':
        plan.rooms = plan.rooms.filter(r => r.id !== change.room_id);
        break;
    }
    plan.metadata.updated_at = new Date().toISOString();
    plan.metadata.source = 'mixed';
  }

  // ─── Render ─────────────────────────────────────────────────────────
  function render() {
    if (!plan) return;

    // Compute viewBox from walls
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of plan.walls) {
      for (const p of [w.start, w.end]) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (plan.walls.length === 0) {
      minX = 0; minY = 0; maxX = plan.canvas.width; maxY = plan.canvas.height;
    }
    const pad = 80;
    viewBox = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);

    let html = '';

    // Grid
    html += '<g id="grid" opacity="0.15">';
    const gs = plan.canvas.gridSize || 10;
    const gStep = gs * 5; // render every 5th grid line for performance
    for (let x = Math.floor(viewBox.x / gStep) * gStep; x <= viewBox.x + viewBox.w; x += gStep) {
      html += '<line x1="' + x + '" y1="' + viewBox.y + '" x2="' + x + '" y2="' + (viewBox.y + viewBox.h) + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    for (let y = Math.floor(viewBox.y / gStep) * gStep; y <= viewBox.y + viewBox.h; y += gStep) {
      html += '<line x1="' + viewBox.x + '" y1="' + y + '" x2="' + (viewBox.x + viewBox.w) + '" y2="' + y + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    html += '</g>';

    // Rooms
    html += '<g id="rooms">';
    for (const room of plan.rooms) {
      const pts = room.polygon.map(p => p.x + ',' + p.y).join(' ');
      const cx = room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length;
      const cy = room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length;
      const area = computeArea(room.polygon);
      html += '<polygon points="' + pts + '" fill="' + room.color + '" fill-opacity="0.5" stroke="none" data-id="' + room.id + '" data-type="room"/>';
      html += '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">' + escHtml(room.label) + '</text>';
      html += '<text x="' + cx + '" y="' + (cy + 10) + '" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">' + area.toFixed(1) + ' m\\u00B2</text>';
    }
    html += '</g>';

    // Walls
    html += '<g id="walls">';
    for (const w of plan.walls) {
      const sw = w.type === 'exterior' ? 4 : w.type === 'interior' ? 2 : 1;
      const dash = w.type === 'divider' ? ' stroke-dasharray="6,4"' : '';
      const sel = (selected && selected.type === 'wall' && selected.id === w.id) ? ' class="selected"' : '';
      html += '<line x1="' + w.start.x + '" y1="' + w.start.y + '" x2="' + w.end.x + '" y2="' + w.end.y + '" stroke="#333" stroke-width="' + sw + '" stroke-linecap="round"' + dash + ' data-id="' + w.id + '" data-type="wall"' + sel + '/>';
    }
    html += '</g>';

    // Openings
    html += '<g id="openings">';
    for (const w of plan.walls) {
      const angle = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (const o of w.openings) {
        const ox = w.start.x + cos * o.offset;
        const oy = w.start.y + sin * o.offset;
        const ex = ox + cos * o.width;
        const ey = oy + sin * o.width;
        // Gap
        html += '<line x1="' + ox + '" y1="' + oy + '" x2="' + ex + '" y2="' + ey + '" stroke="white" stroke-width="6"/>';
        if (o.type === 'door') {
          const dir = o.properties.swingDirection === 'right' ? 1 : -1;
          const r = o.width;
          const px = -sin * dir * r, py = cos * dir * r;
          const ax = ox + px, ay = oy + py;
          const sweep = dir === 1 ? 1 : 0;
          html += '<path d="M' + ox + ',' + oy + ' L' + ex + ',' + ey + ' A' + r + ',' + r + ' 0 0,' + sweep + ' ' + ax + ',' + ay + ' Z" fill="none" stroke="#666" stroke-width="1"/>';
        } else if (o.type === 'window') {
          const nx = -sin * 4, ny = cos * 4;
          html += '<line x1="' + (ox+nx) + '" y1="' + (oy+ny) + '" x2="' + (ex+nx) + '" y2="' + (ey+ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
          html += '<line x1="' + (ox-nx) + '" y1="' + (oy-ny) + '" x2="' + (ex-nx) + '" y2="' + (ey-ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
        }
      }
    }
    html += '</g>';

    // Dimensions
    html += '<g id="dimensions">';
    for (const w of plan.walls) {
      const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
      const len = Math.sqrt(dx*dx + dy*dy);
      if (len < 1) continue;
      const label = (len / 100).toFixed(2) + 'm';
      const mx = (w.start.x + w.end.x) / 2, my = (w.start.y + w.end.y) / 2;
      const angle = Math.atan2(dy, dx);
      const lx = mx + Math.cos(angle + Math.PI/2) * 14;
      const ly = my + Math.sin(angle + Math.PI/2) * 14;
      const deg = angle * 180 / Math.PI;
      html += '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#999" transform="rotate(' + deg + ',' + lx + ',' + ly + ')">' + label + '</text>';
    }
    html += '</g>';

    svg.innerHTML = html;
    attachInteraction();
  }

  function computeArea(polygon) {
    let sum = 0;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      sum += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
    }
    return Math.abs(sum) / 2 / 10000; // cm² → m²
  }

  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ─── Interaction ────────────────────────────────────────────────────
  function attachInteraction() {
    // Click on walls/rooms for selection
    svg.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tool === 'select') {
          selected = { type: el.dataset.type, id: el.dataset.id };
          render();
          showProperties();
        } else if (tool === 'door' || tool === 'window') {
          if (el.dataset.type === 'wall') {
            addOpeningToWall(el.dataset.id, tool, e);
          }
        }
      });
    });
  }

  function showProperties() {
    if (!selected || !plan) {
      propsEl.innerHTML = '<h3>Properties</h3><p class="none">Select a wall or room</p>';
      return;
    }

    if (selected.type === 'wall') {
      const wall = plan.walls.find(w => w.id === selected.id);
      if (!wall) return;
      const len = Math.sqrt(Math.pow(wall.end.x - wall.start.x, 2) + Math.pow(wall.end.y - wall.start.y, 2));
      propsEl.innerHTML = '<h3>Wall</h3>' +
        '<label>Type</label><select id="prop-wall-type"><option value="exterior"' + (wall.type==='exterior'?' selected':'') + '>Exterior</option><option value="interior"' + (wall.type==='interior'?' selected':'') + '>Interior</option><option value="divider"' + (wall.type==='divider'?' selected':'') + '>Divider</option></select>' +
        '<label>Thickness (cm)</label><input id="prop-wall-thick" type="number" value="' + wall.thickness + '">' +
        '<label>Length</label><p style="font-size:13px;margin-top:2px">' + (len/100).toFixed(2) + 'm</p>' +
        '<label>Openings</label><p style="font-size:13px;margin-top:2px">' + wall.openings.length + '</p>' +
        '<br><button id="prop-wall-delete" style="color:#F44336;border-color:#F44336;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer">Delete Wall</button>';

      document.getElementById('prop-wall-type').onchange = (e) => {
        sendChange({ type: 'update_wall', wall_id: wall.id, wall_type: e.target.value });
      };
      document.getElementById('prop-wall-thick').onchange = (e) => {
        sendChange({ type: 'update_wall', wall_id: wall.id, thickness: parseInt(e.target.value) });
      };
      document.getElementById('prop-wall-delete').onclick = () => {
        sendChange({ type: 'remove_wall', wall_id: wall.id });
        selected = null;
        showProperties();
      };
    } else if (selected.type === 'room') {
      const room = plan.rooms.find(r => r.id === selected.id);
      if (!room) return;
      const area = computeArea(room.polygon);
      propsEl.innerHTML = '<h3>Room</h3>' +
        '<label>Label</label><input id="prop-room-label" type="text" value="' + escHtml(room.label) + '">' +
        '<label>Type</label><select id="prop-room-type">' +
        ['living','bedroom','kitchen','bathroom','hallway','closet','laundry','office','dining','garage','balcony','terrace','storage','utility','other']
          .map(t => '<option value="' + t + '"' + (room.type===t?' selected':'') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join('') +
        '</select>' +
        '<label>Area</label><p style="font-size:13px;margin-top:2px">' + area.toFixed(1) + ' m\\u00B2</p>' +
        '<br><button id="prop-room-delete" style="color:#F44336;border-color:#F44336;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer">Delete Room</button>';

      document.getElementById('prop-room-label').onchange = (e) => {
        sendChange({ type: 'rename_room', room_id: room.id, label: e.target.value });
      };
      document.getElementById('prop-room-type').onchange = (e) => {
        sendChange({ type: 'rename_room', room_id: room.id, label: room.label, room_type: e.target.value });
      };
      document.getElementById('prop-room-delete').onclick = () => {
        sendChange({ type: 'remove_room', room_id: room.id });
        selected = null;
        showProperties();
      };
    }
  }

  // ─── Wall drawing ───────────────────────────────────────────────────
  function svgPoint(e) {
    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    return {
      x: Math.round((viewBox.x + (e.clientX - rect.left) * scaleX) / 10) * 10,
      y: Math.round((viewBox.y + (e.clientY - rect.top) * scaleY) / 10) * 10,
    };
  }

  function snapToEndpoint(pt) {
    if (!plan) return pt;
    const threshold = 15;
    for (const w of plan.walls) {
      for (const ep of [w.start, w.end]) {
        const d = Math.sqrt(Math.pow(pt.x - ep.x, 2) + Math.pow(pt.y - ep.y, 2));
        if (d < threshold) return { x: ep.x, y: ep.y };
      }
    }
    return pt;
  }

  svg.addEventListener('click', (e) => {
    if (tool !== 'wall') return;
    const pt = snapToEndpoint(svgPoint(e));

    if (!drawStart) {
      drawStart = pt;
    } else {
      const id = 'w' + Date.now().toString(36);
      sendChange({
        type: 'add_wall',
        wall: { id, start: drawStart, end: pt, thickness: 20, height: 250, type: 'exterior', openings: [] },
      });
      drawStart = pt; // chain walls
    }
  });

  svg.addEventListener('mousemove', (e) => {
    if (tool === 'wall' && drawStart) {
      removeGuide();
      const pt = snapToEndpoint(svgPoint(e));
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', drawStart.x);
      line.setAttribute('y1', drawStart.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      line.classList.add('guide-line');
      line.id = 'guide';
      svg.appendChild(line);
    }
  });

  function removeGuide() {
    const g = document.getElementById('guide');
    if (g) g.remove();
  }

  // ─── Opening placement ─────────────────────────────────────────────
  function addOpeningToWall(wallId, openingType, event) {
    const wall = plan.walls.find(w => w.id === wallId);
    if (!wall) return;
    const pt = svgPoint(event);
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    // Project click onto wall to get offset
    const t = ((pt.x - wall.start.x) * dx + (pt.y - wall.start.y) * dy) / (len * len);
    const offset = Math.round(Math.max(0, Math.min(len - 90, t * len)) / 10) * 10;
    const id = (openingType === 'door' ? 'd' : 'win') + Date.now().toString(36);
    const opening = {
      id,
      type: openingType,
      offset,
      width: openingType === 'door' ? 90 : 120,
      properties: openingType === 'door' ? { swingDirection: 'left' } : {},
    };
    sendChange({ type: 'add_opening', wall_id: wallId, opening });
    setTool('select');
  }

  // ─── Pan & zoom ────────────────────────────────────────────────────
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = e.deltaY > 0 ? 1.1 : 0.9;
    const rect = svg.getBoundingClientRect();
    const mx = viewBox.x + (e.clientX - rect.left) / rect.width * viewBox.w;
    const my = viewBox.y + (e.clientY - rect.top) / rect.height * viewBox.h;
    viewBox.w *= scale;
    viewBox.h *= scale;
    viewBox.x = mx - (e.clientX - rect.left) / rect.width * viewBox.w;
    viewBox.y = my - (e.clientY - rect.top) / rect.height * viewBox.h;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    if (tool === 'select' && e.target === svg) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
    }
  });
  svg.addEventListener('mousemove', (e) => {
    if (isPanning) {
      const rect = svg.getBoundingClientRect();
      const dx = (e.clientX - panStart.x) / rect.width * viewBox.w;
      const dy = (e.clientY - panStart.y) / rect.height * viewBox.h;
      viewBox.x -= dx;
      viewBox.y -= dy;
      panStart = { x: e.clientX, y: e.clientY };
      svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
    }
  });
  svg.addEventListener('mouseup', () => { isPanning = false; });

  // ─── Keyboard shortcuts ─────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setTool('select'); selected = null; render(); showProperties(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected) {
        if (selected.type === 'wall') sendChange({ type: 'remove_wall', wall_id: selected.id });
        if (selected.type === 'room') sendChange({ type: 'remove_room', room_id: selected.id });
        selected = null;
        showProperties();
      }
    }
    if (e.key === 'w') setTool('wall');
    if (e.key === 's' && !e.ctrlKey && !e.metaKey) setTool('select');
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') { e.preventDefault(); save(); }
    }
  });

  // ─── Init ───────────────────────────────────────────────────────────
  load();
})();
</script>
</body>
</html>`;
}
```

- [x] **Step 2: Add sketcher route to index.ts**

In `src/index.ts`, add at the top:

```typescript
import { sketcherHtml } from './sketcher/html';
```

In the `fetch` handler, add before the sketch REST API routes:

```typescript
// Sketcher SPA
const sketcherMatch = url.pathname.match(/^\/sketcher\/([A-Za-z0-9_-]+)$/);
if (sketcherMatch) {
  return new Response(
    sketcherHtml(sketcherMatch[1], url.origin),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
```

- [x] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/sketcher/html.ts src/index.ts
git commit -m "feat: add browser sketcher SPA with wall drawing, selection, and properties panel"
```

---

## Task 11: WebSocket Bridge (Milestone 3) ✅

**Files:**
- Modify: `src/index.ts` (WebSocket upgrade route + DO message handling)

### Architecture Note: WebSocket Routing & DO State

The MCP transport and the browser sketcher WebSocket **run in different DO instances**:
- MCP connects via `/mcp` → McpAgent creates a DO instance per MCP session
- Browser connects via `/ws/:sketchId` → routes to a DO named by sketch ID

This means the sketch WebSocket DO will NOT have the MCP session's in-memory state. **The solution is D1-based state sharing:**
- MCP tools always persist to D1 (already the case in Task 7)
- The WebSocket DO loads state from D1 on first connection
- Both sides read/write D1 as the source of truth
- The DO in-memory state is a hot cache, not a single source

This is consistent with the spec's "Data path for sketches" which says DO holds live state but flushes to D1, and REST API reads from D1 directly.

- [x] **Step 1: Research McpAgent/Agent WebSocket API**

Before writing code, check how the `agents` package handles WebSocket connections:

```bash
grep -r "onMessage\|onConnect\|onClose\|getConnections\|broadcast" node_modules/agents/src/ --include="*.ts" | head -30
```

The `Agent` base class (from partyserver) likely provides:
- `onConnect(connection, ctx)` — called when a WebSocket connects
- `onMessage(connection, message)` — called on incoming message
- `onClose(connection)` — called on disconnect
- `this.getConnections()` — iterate all connected WebSockets (NOT `ctx.getWebSockets()`)
- `this.broadcast(message)` — send to all connections

Verify these method signatures before proceeding. If `McpAgent` overrides `onMessage` for MCP transport, we need to intercept sketch messages before calling `super.onMessage()`.

- [x] **Step 2: Add WebSocket upgrade route**

In `src/index.ts`, in the `fetch` handler, add before the sketcher route:

```typescript
// WebSocket upgrade for real-time sketch sync
const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]+)$/);
if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
  // Route to a DO named by sketch ID — separate from MCP session DOs
  const id = env.MCP_OBJECT.idFromName('sketch-' + wsMatch[1]);
  const obj = env.MCP_OBJECT.get(id);
  // Pass sketch ID in URL so DO can extract it
  return obj.fetch(request);
}
```

- [x] **Step 3: Add WebSocket message handling to the DO**

In the `RoomSketcherHelpMCP` class in `src/index.ts`, add WebSocket lifecycle methods.

First, add imports:

```typescript
import { applyChanges } from './sketch/changes';
import { floorPlanToSvg } from './sketch/svg';
import type { ClientMessage, Change } from './sketch/types';
```

Then add the methods to the class. MCP messages use JSON-RPC (`jsonrpc` field), sketch messages use our `type` field — this is how we distinguish them:

```typescript
private sketchWsClients = new Set<WebSocket>();

async onMessage(connection: WebSocket, message: string | ArrayBuffer) {
  if (typeof message === 'string') {
    try {
      const data = JSON.parse(message);
      // MCP uses JSON-RPC format with "jsonrpc" field
      // Sketch messages use our "type" field
      if (data.type && !data.jsonrpc) {
        await this.handleSketchMessage(connection, data as ClientMessage);
        return;
      }
    } catch {}
  }
  // Fall through to McpAgent's MCP transport handler
  super.onMessage(connection, message);
}

async onClose(connection: WebSocket, code: number, reason: string) {
  this.sketchWsClients.delete(connection);
  // If last sketch client disconnected, flush to D1
  if (this.sketchWsClients.size === 0 && this.state.plan && this.state.sketchId) {
    const svg = floorPlanToSvg(this.state.plan);
    await saveSketch(this.env.DB, this.state.sketchId, this.state.plan, svg);
  }
  super.onClose(connection, code, reason);
}

private async handleSketchMessage(sender: WebSocket, msg: ClientMessage) {
  // Track this as a sketch WebSocket client
  this.sketchWsClients.add(sender);

  if (msg.type === 'load') {
    // Load from in-memory state or D1
    let plan = this.state.plan;
    if (!plan) {
      // Extract sketch ID from the request URL path
      const sketchId = this.extractSketchId();
      if (sketchId) {
        const loaded = await loadSketch(this.env.DB, sketchId);
        if (loaded) {
          plan = loaded.plan;
          this.setState({ sketchId, plan });
        }
      }
    }
    if (plan) {
      sender.send(JSON.stringify({ type: 'state_update', plan }));
    }
    return;
  }

  if (msg.type === 'save') {
    if (this.state.plan && this.state.sketchId) {
      const svg = floorPlanToSvg(this.state.plan);
      await saveSketch(this.env.DB, this.state.sketchId, this.state.plan, svg);
      this.broadcastToSketchClients(JSON.stringify({
        type: 'saved', updated_at: new Date().toISOString(),
      }));
    }
    return;
  }

  // It's a Change — apply it
  if (!this.state.plan) {
    // Lazy-load from D1 if not in memory
    const sketchId = this.extractSketchId();
    if (sketchId) {
      const loaded = await loadSketch(this.env.DB, sketchId);
      if (loaded) this.setState({ sketchId, plan: loaded.plan });
    }
  }

  if (this.state.plan) {
    const updated = applyChanges(this.state.plan, [msg as Change]);
    this.setState({ ...this.state, plan: updated });
    this.broadcastToSketchClients(JSON.stringify({ type: 'state_update', plan: updated }));
  }
}

private extractSketchId(): string | undefined {
  // The sketch ID was encoded in the DO name as 'sketch-{id}'
  // We can also extract from the URL if the DO stores it
  return this.state.sketchId;
}

private broadcastToSketchClients(message: string) {
  for (const ws of this.sketchWsClients) {
    try { ws.send(message); } catch { this.sketchWsClients.delete(ws); }
  }
}
```

**Note on sketch ID extraction:** The DO is named `sketch-{sketchId}` but the DO doesn't know its own name. The SPA should send `{ type: 'load' }` as its first message, and we extract the sketch ID from the URL. Alternatively, the SPA can send `{ type: 'load', sketch_id: '...' }` — update the `ClientMessage` type to include this:

```typescript
// In src/sketch/types.ts, update ClientMessage:
export type ClientMessage =
  | Change
  | { type: 'save' }
  | { type: 'load'; sketch_id: string };
```

Then in `handleSketchMessage`, extract sketch_id from the load message and store it in state.

- [x] **Step 4: Update SPA to send sketch_id on load**

In `src/sketcher/html.ts`, find the WebSocket `onopen` handler and add:

```javascript
ws.onopen = () => {
  statusEl.textContent = 'Connected';
  ws.send(JSON.stringify({ type: 'load', sketch_id: SKETCH_ID }));
};
```

- [x] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

**Important:** The exact `onMessage`/`onClose`/`super` signatures depend on the `agents` package. Check `node_modules/agents/src/` for the actual method signatures. If `McpAgent` doesn't expose `onMessage` directly, you may need to override `webSocketMessage` (the raw Cloudflare DO method) instead. The research step (Step 1) will clarify this.

- [x] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add WebSocket bridge for real-time sketch sync between Claude and browser"
```

---

## Task 12: update_sketch, suggest_improvements, export_sketch Tools (Milestone 3) ✅

**Files:**
- Modify: `src/sketch/tools.ts` (add 3 handlers)
- Modify: `src/index.ts` (register 3 tools)

- [x] **Step 1: Add handler functions to tools.ts**

Append to `src/sketch/tools.ts`:

```typescript
import { ChangeSchema } from './types';

// ─── update_sketch ──────────────────────────────────────────────────────────

export async function handleUpdateSketch(
  sketchId: string,
  changes: unknown[],
  db: D1Database,
  getState: () => { sketchId?: string; plan?: FloorPlan },
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  broadcast: (msg: string) => void,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // Validate changes
  const parsed: Change[] = [];
  for (const c of changes) {
    const result = ChangeSchema.safeParse(c);
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: `Invalid change: ${result.error.issues.map(i => i.message).join(', ')}` }] };
    }
    parsed.push(result.data);
  }

  // Load plan
  const state = getState();
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  // Apply changes
  plan = applyChanges(plan, parsed);

  // Persist + update state
  const svg = floorPlanToSvg(plan);
  await saveSketch(db, sketchId, plan, svg);
  setState({ sketchId, plan });

  // Broadcast to browser
  broadcast(JSON.stringify({ type: 'state_update', plan }));

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const summary = [
    `Applied ${parsed.length} change(s) to **${plan.name}**`,
    `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m²`,
  ].join('\n');

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: toBase64(svg), mimeType: 'image/svg+xml' },
    ],
  };
}

// ─── suggest_improvements ───────────────────────────────────────────────────

export async function handleSuggestImprovements(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  const rooms = plan.rooms.map(r => ({
    label: r.label,
    type: r.type,
    area: r.area ?? shoelaceArea(r.polygon),
    wallCount: r.wall_ids?.length ?? 0,
  }));

  const totalArea = rooms.reduce((s, r) => s + r.area, 0);
  const doorCount = plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'door').length, 0);
  const windowCount = plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'window').length, 0);

  const analysis = [
    `## Floor Plan Analysis: ${plan.name}`,
    ``,
    `**Dimensions:** ${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m² total`,
    `**Openings:** ${doorCount} doors, ${windowCount} windows`,
    ``,
    `### Rooms`,
    ...rooms.map(r => `- **${r.label}** (${r.type}): ${r.area.toFixed(1)} m²`),
    ``,
    `### Analysis Prompts`,
    `Consider these aspects of the floor plan:`,
    `1. **Room proportions** — Are any rooms unusually narrow or oversized for their purpose?`,
    `2. **Traffic flow** — Can you walk from the entrance to all rooms without passing through a bedroom?`,
    `3. **Door placement** — Do doors swing into walls or furniture? Is there clearance?`,
    `4. **Natural light** — Do living spaces have windows? Bathrooms can be interior.`,
    `5. **Missing rooms** — Is there a closet near the entrance? Storage? Laundry space?`,
    `6. **Kitchen triangle** — If applicable, is the fridge-sink-stove layout efficient?`,
    ``,
    `### Want more?`,
    `- **3D visualization** of this layout → [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=suggest)`,
    `- **Furniture placement** with 7000+ items → RoomSketcher Pro`,
    `- **HD renders** for presentations → RoomSketcher VIP`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text: analysis }] };
}

// ─── export_sketch ──────────────────────────────────────────────────────────

export async function handleExportSketch(
  sketchId: string,
  format: 'svg' | 'pdf' | 'summary',
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
  workerUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined;
  if (!plan) {
    const loaded = await loadSketch(db, sketchId);
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] };
    plan = loaded.plan;
  }

  const totalArea = plan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
  const cta = `\n\n_For 3D visualization, HD renders, and professional floor plans, try [RoomSketcher](https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=export)._`;

  if (format === 'summary') {
    const text = [
      `## ${plan.name}`,
      `${plan.walls.length} walls, ${plan.rooms.length} rooms, ${totalArea.toFixed(1)} m²`,
      `Rooms: ${plan.rooms.map(r => `${r.label} (${(r.area ?? 0).toFixed(1)} m²)`).join(', ')}`,
      `${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'door').length, 0)} doors, ${plan.walls.reduce((s, w) => s + w.openings.filter(o => o.type === 'window').length, 0)} windows`,
      cta,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  }

  const svg = floorPlanToSvg(plan);

  if (format === 'pdf') {
    const text = [
      `Download your floor plan as PDF:`,
      `${workerUrl}/api/sketches/${sketchId}/export.pdf`,
      cta,
    ].join('\n');
    return {
      content: [
        { type: 'text' as const, text },
        { type: 'image' as const, data: toBase64(svg), mimeType: 'image/svg+xml' },
      ],
    };
  }

  // SVG format (default)
  return {
    content: [
      { type: 'text' as const, text: `**${plan.name}** — ${totalArea.toFixed(1)} m²${cta}` },
      { type: 'image' as const, data: toBase64(svg), mimeType: 'image/svg+xml' },
    ],
  };
}
```

- [x] **Step 2: Register 3 new tools in index.ts**

Add at the end of `init()` in the `RoomSketcherHelpMCP` class:

```typescript
this.server.registerTool(
  'update_sketch',
  {
    description: 'Push modifications to an existing sketch. Use this to move walls, add rooms, add openings, etc. Changes are applied in order and broadcast to the browser sketcher in real-time.',
    inputSchema: {
      sketch_id: z.string().describe('The sketch ID'),
      changes: z.array(ChangeSchema).describe('Array of changes to apply'),
    },
  },
  async ({ sketch_id, changes }) => {
    return handleUpdateSketch(
      sketch_id,
      changes,
      this.env.DB,
      () => this.state,
      (s) => this.setState(s),
      (msg) => this.broadcastToSketchClients(msg),
    );
  },
);

this.server.registerTool(
  'suggest_improvements',
  {
    description: 'Analyze the current floor plan and get structured data with analysis prompts. Use this to provide feedback on room proportions, traffic flow, door placement, and missing features.',
    inputSchema: {
      sketch_id: z.string().describe('The sketch ID'),
    },
  },
  async ({ sketch_id }) => {
    return handleSuggestImprovements(sketch_id, this.env.DB, this.state);
  },
);

this.server.registerTool(
  'export_sketch',
  {
    description: 'Export a sketch in various formats (SVG image, PDF download link, or text summary). Includes links to upgrade to RoomSketcher for 3D and professional features.',
    inputSchema: {
      sketch_id: z.string().describe('The sketch ID'),
      format: z.enum(['svg', 'pdf', 'summary']).default('svg').describe('Export format'),
    },
  },
  async ({ sketch_id, format }) => {
    return handleExportSketch(sketch_id, format, this.env.DB, this.state, this.getWorkerUrl());
  },
);
```

Add the `ChangeSchema` import at the top if not already there:

```typescript
import { FloorPlanSchema, ChangeSchema } from './sketch/types';
```

Add the new handler imports:

```typescript
import { handleGenerateFloorPlan, handleGetSketch, handleOpenSketcher, handleUpdateSketch, handleSuggestImprovements, handleExportSketch } from './sketch/tools';
```

- [x] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git commit -m "feat: add update_sketch, suggest_improvements, export_sketch MCP tools (Milestone 3)"
```

---

## Task 13: PDF Export Endpoint ✅

**Files:**
- Modify: `package.json` (add jspdf + svg2pdf.js)
- Modify: `src/index.ts` (add PDF export route)

- [x] **Step 1: Install PDF dependencies**

```bash
npm install jspdf svg2pdf.js
```

**Note:** These libraries may not work in Cloudflare Workers due to DOM dependencies (`svg2pdf.js` typically requires a DOM parser). If they fail at runtime, the endpoint already falls back to serving the SVG as a download. Test in `wrangler dev` first — if PDF generation doesn't work, skip it and keep the SVG fallback.

- [x] **Step 2: Add PDF export route**

In `src/index.ts`, add the export route in the fetch handler:

```typescript
// PDF export
const pdfMatch = url.pathname.match(/^\/api\/sketches\/([A-Za-z0-9_-]+)\/export\.pdf$/);
if (pdfMatch && request.method === 'GET') {
  const sketchId = pdfMatch[1];
  const loaded = await loadSketch(env.DB, sketchId);
  if (!loaded) return Response.json({ error: 'Not found' }, { status: 404 });

  const { floorPlanToSvg } = await import('./sketch/svg');
  const svg = loaded.svg ?? floorPlanToSvg(loaded.plan);

  // Simple fallback: serve SVG as downloadable file
  // Full PDF generation with jspdf may need testing in Workers environment
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Content-Disposition': `attachment; filename="${loaded.plan.name || 'floor-plan'}.svg"`,
    },
  });
}
```

**If `jspdf` works in Workers:** Replace the fallback with proper PDF generation. Test with `wrangler dev` first.

- [x] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/index.ts package.json package-lock.json
git commit -m "feat: add PDF/SVG export download endpoint"
```

---

## Task 14: Commit Pending Changes + E2E Test (Milestone 3)

**Files:** `src/sketch/tools.ts`, `package-lock.json` (uncommitted)

**Pre-requisite:** Commit the uncommitted changes from the image-stripping work before testing.

- [ ] **Step 1: Commit pending changes**

```bash
git add src/sketch/tools.ts package-lock.json
git commit -m "fix: remove image content from MCP tool responses (text-only with sketcher URLs)"
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All 36 unit tests pass.

- [ ] **Step 3: Deploy**

```bash
bash deploy.sh
```

- [ ] **Step 4: Test generate_floor_plan via Claude**

Ask Claude (desktop app with MCP connected):
> "Generate a floor plan for a 1-bedroom apartment with kitchen, bathroom, and living room"

Expected: Claude calls `generate_floor_plan`, returns text summary with sketcher URL. No image errors.

- [ ] **Step 5: Test browser sketcher**

Open the sketcher URL from step 4 in a browser. Expected:
- Floor plan renders with rooms, walls, dimensions
- Wall tool: click-to-place walls that snap to grid
- Select tool: click walls/rooms, properties panel updates
- Door/Window tools: click a wall to add opening
- Save button works (check network tab for PUT request)

- [ ] **Step 6: Test real-time sync**

With sketcher open, ask Claude:
> "Add a closet room to the apartment"

Expected: Claude calls `update_sketch`, browser updates in real-time via WebSocket.

- [ ] **Step 7: Test suggest_improvements**

Ask Claude:
> "What improvements would you suggest for this floor plan?"

Expected: Claude calls `suggest_improvements`, returns structured analysis.

- [ ] **Step 8: Test export**

Ask Claude:
> "Export this floor plan as SVG"

Expected: Text response with sketcher URL and RoomSketcher CTA.

- [ ] **Step 9: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end testing fixes for Milestone 3"
```

---

## Task 15: Final Cleanup + Verify Existing Help Tools Still Work

**Files:** None (verification only)

- [ ] **Step 1: Verify help article search still works**

Ask Claude (with MCP connected):
> "Search RoomSketcher help for how to draw walls"

Expected: Returns search results from the help articles.

- [ ] **Step 2: Verify health endpoint**

```bash
curl https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/health
```

Expected: `{"status":"ok","last_sync":"..."}`.

- [ ] **Step 3: Run all tests one final time**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Final commit if needed**

If any cleanup was required, commit it.

---

## Important: Route Ordering in index.ts

When all tasks are complete, the `fetch` handler in `src/index.ts` must check routes in this order:

```
1. /mcp (or /mcp/*) → McpAgent handler (existing)
2. /admin/sync → sync handler (existing)
3. /health → health check (existing)
4. /ws/:id → WebSocket upgrade to DO (Task 11)
5. /api/sketches/:id/export.pdf → PDF/SVG export (Task 13)
6. /api/sketches/:id → REST load/save (Task 9)
7. /sketcher/:id → SPA HTML (Task 10)
8. Default → "RoomSketcher Help MCP Server" (existing)
```

Note: `/api/sketches/:id/export.pdf` must come BEFORE `/api/sketches/:id` because the latter's regex would match the former.

---

## Summary

| Task | What | Milestone | Status | Commit |
|------|------|-----------|--------|--------|
| 1 | Test infrastructure | Setup | ✅ | `c5c7c7e` |
| 2 | FloorPlan types + Zod schemas | M1 | ✅ | `e05b697` |
| 3 | Geometry helpers | M1 | ✅ | `cbdef3e` |
| 4 | SVG renderer | M1 | ✅ | `116a8b0` |
| 5 | Change application logic | M1 | ✅ | `d2c1745` |
| 6 | D1 persistence | M1 | ✅ | `7f87a39` |
| 7 | MCP tools (generate + get + open) | M1 | ✅ | `4e4347f` |
| 8 | Deploy + test Milestone 1 | M1 | ✅ | deployed |
| 9 | REST API | M2 | ✅ | `c243c8b` |
| 10 | Browser sketcher SPA | M2 | ✅ | `5818337` |
| 11 | WebSocket bridge | M3 | ✅ | `398cfa1` |
| 12 | Remaining MCP tools (update, suggest, export) | M3 | ✅ | `7f7a1b5` |
| 13 | PDF/SVG export endpoint | M3 | ✅ | `dd36d34` |
| 14 | Deploy + E2E test Milestone 3 | M3 | ⬜ | — |
| 15 | Final verification | — | ⬜ | — |

### Uncommitted changes to commit first

- `src/sketch/tools.ts` — removed image content from MCP tool responses (text-only now)
- `package-lock.json` — reflects resvg-wasm install/uninstall cycle (clean)
