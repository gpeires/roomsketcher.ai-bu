# Sketch Guidance Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add templates, furniture catalog, smart defaults, enriched tool descriptions, and a configurable CTA system so AI agents produce delightful, furnished floor plans on the first try.

**Architecture:** Additive layer on existing sketch tools. New input schemas (relaxed) feed into `applyDefaults()` which produces strict `FloorPlan` objects. Templates are browsable via two new MCP tools. Furniture renders as labeled SVG rectangles. CTAs are driven by a single config file with session-aware throttling.

**Tech Stack:** TypeScript, Zod, Vitest, Cloudflare Workers, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-18-sketch-guidance-layer-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/sketch/furniture-catalog.ts` | Furniture item catalog: types, ~30 items with standard dimensions |
| `src/sketch/defaults.ts` | `DEFAULTS` config, color palette, `applyDefaults()` function |
| `src/sketch/cta-config.ts` | CTA message templates, trigger config, `pickCTA()` function |
| `src/sketch/templates/studio.json` | Studio apartment template (35-45sqm, furnished) |
| `src/sketch/templates/1br-apartment.json` | 1BR apartment template (50-65sqm, furnished) |
| `src/sketch/templates/2br-apartment.json` | 2BR apartment template (70-90sqm, furnished) |
| `src/sketch/templates/3br-house.json` | 3BR house template (110-140sqm, furnished) |
| `src/sketch/templates/open-plan-loft.json` | Open plan loft template (60-80sqm, furnished) |
| `src/sketch/templates/l-shaped-home.json` | L-shaped home template (90-120sqm, furnished) |
| `src/sketch/defaults.test.ts` | Tests for applyDefaults() |
| `src/sketch/furniture-catalog.test.ts` | Tests for furniture catalog |
| `src/sketch/cta-config.test.ts` | Tests for CTA selection logic |

### Modified Files

| File | What Changes |
|------|-------------|
| `src/sketch/types.ts` | Add input schemas (`WallInputSchema`, `RoomInputSchema`, `OpeningInputSchema`, `FloorPlanInputSchema`, `FurnitureItemInputSchema`), add 3 furniture change types to `ChangeSchema` |
| `src/sketch/changes.ts` | Handle `add_furniture`, `move_furniture`, `remove_furniture` |
| `src/sketch/geometry.ts` | Add `pointInPolygon()` |
| `src/sketch/svg.ts` | Add `renderFurniture()`, insert between rooms and walls in z-order |
| `src/sketch/tools.ts` | Enriched descriptions, two-phase validation with `applyDefaults()`, new `suggest_improvements` output, CTA integration |
| `src/index.ts` | Register `list_templates` and `get_template` tools, update `generate_floor_plan` inputSchema to use `FloorPlanInputSchema` |
| `src/types.ts` | Add `CTA_VARIANT` to `Env`, add `SessionCTAState` to `SketchSession` |
| `docs/arch/main/ARCH.md` | New sections documenting template catalog, furniture, CTA system, smart defaults |

---

## Task 1: Furniture Change Types in Schema

**Files:**
- Modify: `src/sketch/types.ts:117-128`
- Test: `src/sketch/types.test.ts`

- [ ] **Step 1: Write failing tests for furniture change types**

Add to `src/sketch/types.test.ts`:

```typescript
it('validates add_furniture change', () => {
  const change = {
    type: 'add_furniture',
    furniture: {
      id: 'f1',
      type: 'bed-double',
      position: { x: 100, y: 100 },
      rotation: 0,
      width: 160,
      depth: 200,
      label: 'Bed',
    },
  }
  const result = ChangeSchema.safeParse(change)
  expect(result.success).toBe(true)
})

it('validates move_furniture change', () => {
  const change = {
    type: 'move_furniture',
    furniture_id: 'f1',
    position: { x: 200, y: 200 },
  }
  const result = ChangeSchema.safeParse(change)
  expect(result.success).toBe(true)
})

it('validates remove_furniture change', () => {
  const change = {
    type: 'remove_furniture',
    furniture_id: 'f1',
  }
  const result = ChangeSchema.safeParse(change)
  expect(result.success).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/types.test.ts`
Expected: 3 new tests FAIL — discriminated union doesn't recognize furniture types

- [ ] **Step 3: Add furniture change types to ChangeSchema**

In `src/sketch/types.ts`, add three new entries to the `ChangeSchema` discriminated union (line 117-128), after the `remove_room` entry:

```typescript
z.object({ type: z.literal('add_furniture'), furniture: FurnitureItemSchema }),
z.object({ type: z.literal('move_furniture'), furniture_id: z.string(), position: PointSchema.optional(), rotation: z.number().optional() }),
z.object({ type: z.literal('remove_furniture'), furniture_id: z.string() }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/types.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/types.ts src/sketch/types.test.ts
git commit --no-gpg-sign -m "feat: add furniture change types to ChangeSchema"
```

---

## Task 2: Furniture Changes in applyChanges()

**Files:**
- Modify: `src/sketch/changes.ts:8-79`
- Test: `src/sketch/changes.test.ts`

- [ ] **Step 1: Write failing tests for furniture changes**

Add to `src/sketch/changes.test.ts`:

```typescript
it('adds furniture', () => {
  const plan = makePlan()
  const changes: Change[] = [
    {
      type: 'add_furniture',
      furniture: {
        id: 'f1',
        type: 'bed-double',
        position: { x: 100, y: 100 },
        rotation: 0,
        width: 160,
        depth: 200,
        label: 'Bed',
      },
    },
  ]
  const result = applyChanges(plan, changes)
  expect(result.furniture).toHaveLength(1)
  expect(result.furniture[0].id).toBe('f1')
})

it('moves furniture', () => {
  const plan = makePlan()
  plan.furniture = [
    { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
  ]
  const changes: Change[] = [
    { type: 'move_furniture', furniture_id: 'f1', position: { x: 200, y: 200 }, rotation: 90 },
  ]
  const result = applyChanges(plan, changes)
  expect(result.furniture[0].position).toEqual({ x: 200, y: 200 })
  expect(result.furniture[0].rotation).toBe(90)
})

it('removes furniture', () => {
  const plan = makePlan()
  plan.furniture = [
    { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
  ]
  const changes: Change[] = [{ type: 'remove_furniture', furniture_id: 'f1' }]
  const result = applyChanges(plan, changes)
  expect(result.furniture).toHaveLength(0)
})

it('ignores move_furniture for nonexistent ID', () => {
  const plan = makePlan()
  const changes: Change[] = [
    { type: 'move_furniture', furniture_id: 'nonexistent', position: { x: 999, y: 999 } },
  ]
  const result = applyChanges(plan, changes)
  expect(result.furniture).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/changes.test.ts`
Expected: 4 new tests FAIL — switch statement doesn't handle furniture types

- [ ] **Step 3: Add furniture cases to applyChanges()**

In `src/sketch/changes.ts`:

First, update the shallow clone block (lines 10-15) to include furniture:

```typescript
const result: FloorPlan = {
  ...plan,
  walls: plan.walls.map(w => ({ ...w, openings: [...w.openings] })),
  rooms: [...plan.rooms],
  furniture: [...plan.furniture],
  metadata: { ...plan.metadata, updated_at: new Date().toISOString(), source: 'mixed' },
}
```

Then add three new cases before the closing of the switch (line 74-75):

```typescript
case 'add_furniture':
  result.furniture.push({ ...change.furniture })
  break

case 'move_furniture': {
  const item = result.furniture.find(f => f.id === change.furniture_id)
  if (!item) break
  if (change.position) item.position = change.position
  if (change.rotation !== undefined) item.rotation = change.rotation
  break
}

case 'remove_furniture':
  result.furniture = result.furniture.filter(f => f.id !== change.furniture_id)
  break
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/changes.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/changes.ts src/sketch/changes.test.ts
git commit --no-gpg-sign -m "feat: handle furniture changes in applyChanges()"
```

---

## Task 3: pointInPolygon() in Geometry

**Files:**
- Modify: `src/sketch/geometry.ts`
- Test: `src/sketch/geometry.test.ts`

- [ ] **Step 1: Write failing tests for pointInPolygon**

Add to `src/sketch/geometry.test.ts`:

```typescript
import { pointInPolygon } from './geometry'

describe('pointInPolygon', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ]

  it('returns true for point inside polygon', () => {
    expect(pointInPolygon({ x: 200, y: 200 }, square)).toBe(true)
  })

  it('returns false for point outside polygon', () => {
    expect(pointInPolygon({ x: 500, y: 500 }, square)).toBe(false)
  })

  it('returns true for point just inside top edge', () => {
    // Ray-casting is ambiguous for points exactly on edges, so test slightly inside
    expect(pointInPolygon({ x: 200, y: 1 }, square)).toBe(true)
  })

  it('works with triangle', () => {
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 150, y: 300 },
    ]
    expect(pointInPolygon({ x: 150, y: 100 }, tri)).toBe(true)
    expect(pointInPolygon({ x: 0, y: 300 }, tri)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: FAIL — `pointInPolygon` is not exported

- [ ] **Step 3: Implement pointInPolygon**

Add to `src/sketch/geometry.ts` (ray-casting algorithm):

```typescript
/**
 * Ray-casting point-in-polygon test.
 * Returns true if point is inside the polygon (edge behavior is undefined).
 */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/geometry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/geometry.ts src/sketch/geometry.test.ts
git commit --no-gpg-sign -m "feat: add pointInPolygon() to geometry module"
```

---

## Task 4: Furniture Catalog

**Files:**
- Create: `src/sketch/furniture-catalog.ts`
- Create: `src/sketch/furniture-catalog.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/sketch/furniture-catalog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { FURNITURE_CATALOG, getItemsForRoom } from './furniture-catalog'

describe('FURNITURE_CATALOG', () => {
  it('has at least 25 items', () => {
    expect(FURNITURE_CATALOG.length).toBeGreaterThanOrEqual(25)
  })

  it('every item has required fields', () => {
    for (const item of FURNITURE_CATALOG) {
      expect(item.type).toBeTruthy()
      expect(item.label).toBeTruthy()
      expect(item.defaultWidth).toBeGreaterThan(0)
      expect(item.defaultDepth).toBeGreaterThan(0)
      expect(item.roomTypes.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate types', () => {
    const types = FURNITURE_CATALOG.map(i => i.type)
    expect(new Set(types).size).toBe(types.length)
  })
})

describe('getItemsForRoom', () => {
  it('returns bedroom items for bedroom type', () => {
    const items = getItemsForRoom('bedroom')
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(i => i.type === 'bed-double')).toBe(true)
  })

  it('returns kitchen items for kitchen type', () => {
    const items = getItemsForRoom('kitchen')
    expect(items.some(i => i.type === 'kitchen-counter')).toBe(true)
  })

  it('returns empty array for room type with no items', () => {
    const items = getItemsForRoom('garage')
    // garage has no specific furniture in our catalog
    expect(Array.isArray(items)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/furniture-catalog.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the furniture catalog**

Create `src/sketch/furniture-catalog.ts`:

```typescript
import type { RoomType } from './types'

export interface CatalogItem {
  type: string
  label: string
  defaultWidth: number  // cm
  defaultDepth: number  // cm
  roomTypes: RoomType[]
  svgIcon?: string
  catalogId?: string
}

export const FURNITURE_CATALOG: CatalogItem[] = [
  // Bedroom
  { type: 'bed-double', label: 'Bed', defaultWidth: 160, defaultDepth: 200, roomTypes: ['bedroom'] },
  { type: 'bed-single', label: 'Bed', defaultWidth: 90, defaultDepth: 200, roomTypes: ['bedroom'] },
  { type: 'nightstand', label: 'Nightstand', defaultWidth: 50, defaultDepth: 40, roomTypes: ['bedroom'] },
  { type: 'wardrobe', label: 'Wardrobe', defaultWidth: 120, defaultDepth: 60, roomTypes: ['bedroom', 'closet'] },
  { type: 'dresser', label: 'Dresser', defaultWidth: 100, defaultDepth: 50, roomTypes: ['bedroom'] },

  // Living
  { type: 'sofa-3seat', label: 'Sofa', defaultWidth: 220, defaultDepth: 90, roomTypes: ['living'] },
  { type: 'coffee-table', label: 'Coffee Table', defaultWidth: 120, defaultDepth: 60, roomTypes: ['living'] },
  { type: 'tv-unit', label: 'TV Unit', defaultWidth: 150, defaultDepth: 40, roomTypes: ['living'] },
  { type: 'armchair', label: 'Armchair', defaultWidth: 80, defaultDepth: 80, roomTypes: ['living'] },
  { type: 'bookshelf', label: 'Bookshelf', defaultWidth: 80, defaultDepth: 30, roomTypes: ['living', 'office'] },

  // Kitchen
  { type: 'kitchen-counter', label: 'Counter', defaultWidth: 240, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'kitchen-sink', label: 'Sink', defaultWidth: 60, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'fridge', label: 'Fridge', defaultWidth: 70, defaultDepth: 70, roomTypes: ['kitchen'] },
  { type: 'stove', label: 'Stove', defaultWidth: 60, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'dining-table', label: 'Table', defaultWidth: 160, defaultDepth: 90, roomTypes: ['kitchen', 'dining'] },
  { type: 'dining-chair', label: 'Chair', defaultWidth: 45, defaultDepth: 45, roomTypes: ['kitchen', 'dining'] },

  // Bathroom
  { type: 'toilet', label: 'Toilet', defaultWidth: 40, defaultDepth: 65, roomTypes: ['bathroom'] },
  { type: 'bath-sink', label: 'Sink', defaultWidth: 60, defaultDepth: 45, roomTypes: ['bathroom'] },
  { type: 'bathtub', label: 'Bathtub', defaultWidth: 170, defaultDepth: 75, roomTypes: ['bathroom'] },
  { type: 'shower', label: 'Shower', defaultWidth: 90, defaultDepth: 90, roomTypes: ['bathroom'] },

  // Office
  { type: 'desk', label: 'Desk', defaultWidth: 140, defaultDepth: 70, roomTypes: ['office'] },
  { type: 'office-chair', label: 'Chair', defaultWidth: 55, defaultDepth: 55, roomTypes: ['office'] },

  // Dining
  { type: 'sideboard', label: 'Sideboard', defaultWidth: 160, defaultDepth: 45, roomTypes: ['dining'] },

  // Hallway
  { type: 'shoe-rack', label: 'Shoe Rack', defaultWidth: 80, defaultDepth: 30, roomTypes: ['hallway'] },
  { type: 'coat-hook', label: 'Coat Hook', defaultWidth: 60, defaultDepth: 10, roomTypes: ['hallway'] },
]

export function getItemsForRoom(roomType: RoomType): CatalogItem[] {
  return FURNITURE_CATALOG.filter(item => item.roomTypes.includes(roomType))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/furniture-catalog.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/furniture-catalog.ts src/sketch/furniture-catalog.test.ts
git commit --no-gpg-sign -m "feat: add furniture catalog with ~25 items"
```

---

## Task 5: Furniture SVG Rendering

**Files:**
- Modify: `src/sketch/svg.ts:145-208`
- Test: `src/sketch/svg.test.ts`

- [ ] **Step 1: Write failing test for furniture in SVG**

Add to `src/sketch/svg.test.ts`:

```typescript
it('renders furniture as labeled rectangles', () => {
  const plan = makePlan()
  plan.furniture = [
    { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
  ]
  const svg = floorPlanToSvg(plan)
  expect(svg).toContain('id="furniture"')
  expect(svg).toContain('Bed')
  expect(svg).toContain('data-id="f1"')
})

it('renders furniture between rooms and walls in z-order', () => {
  const plan = makePlan()
  plan.furniture = [
    { id: 'f1', type: 'sofa', position: { x: 100, y: 100 }, rotation: 0, width: 220, depth: 90, label: 'Sofa' },
  ]
  const svg = floorPlanToSvg(plan)
  const roomsIdx = svg.indexOf('id="rooms"')
  const furnitureIdx = svg.indexOf('id="furniture"')
  const wallsIdx = svg.indexOf('id="walls"')
  expect(furnitureIdx).toBeGreaterThan(roomsIdx)
  expect(furnitureIdx).toBeLessThan(wallsIdx)
})

it('applies rotation transform to furniture', () => {
  const plan = makePlan()
  plan.furniture = [
    { id: 'f1', type: 'desk', position: { x: 100, y: 100 }, rotation: 90, width: 140, depth: 70, label: 'Desk' },
  ]
  const svg = floorPlanToSvg(plan)
  expect(svg).toContain('rotate(90')
})
```

Note: the `makePlan()` helper should already exist in `svg.test.ts`. If not, check how the existing tests create plans and use the same pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sketch/svg.test.ts`
Expected: FAIL — no furniture group in SVG output

- [ ] **Step 3: Add renderFurniture() and update floorPlanToSvg()**

Add a new function to `src/sketch/svg.ts`:

```typescript
function renderFurniture(furniture: FloorPlan['furniture']): string {
  return furniture.map(item => {
    const cx = item.position.x + item.width / 2
    const cy = item.position.y + item.depth / 2
    const transform = item.rotation
      ? ` transform="rotate(${item.rotation}, ${cx}, ${cy})"`
      : ''
    const rect = `<rect x="${item.position.x}" y="${item.position.y}" width="${item.width}" height="${item.depth}" ` +
      `fill="#F5F5F5" stroke="#BDBDBD" stroke-width="1"${transform} data-id="${item.id}"/>`
    const label = `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#757575"${transform ? ` transform="rotate(${item.rotation}, ${cx}, ${cy})"` : ''}>${item.label ?? item.type}</text>`
    return rect + '\n    ' + label
  }).join('\n    ')
}
```

Then update `floorPlanToSvg()` to insert the furniture group between rooms and walls:

```typescript
return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" style="background:#fff">
  <g id="rooms">
    ${renderRooms(plan.rooms, plan.units)}
  </g>
  <g id="furniture">
    ${renderFurniture(plan.furniture)}
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
    ${hasWalls ? renderWatermark(bb.maxX, bb.maxY) : ...}
  </g>
</svg>`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/svg.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/svg.ts src/sketch/svg.test.ts
git commit --no-gpg-sign -m "feat: render furniture as labeled rectangles in SVG"
```

---

## Task 6: Smart Defaults — Input Schemas and applyDefaults()

**Files:**
- Modify: `src/sketch/types.ts`
- Create: `src/sketch/defaults.ts`
- Create: `src/sketch/defaults.test.ts`

- [ ] **Step 1: Write failing tests for applyDefaults**

Create `src/sketch/defaults.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { applyDefaults, ROOM_COLORS } from './defaults'
import { FloorPlanSchema } from './types'

describe('applyDefaults', () => {
  it('fills wall thickness from wall type', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior', openings: [] },
        { id: 'w2', start: { x: 0, y: 0 }, end: { x: 0, y: 400 }, type: 'interior', openings: [] },
      ],
      rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.walls[0].thickness).toBe(20)
    expect(result.walls[0].height).toBe(250)
    expect(result.walls[1].thickness).toBe(10)
  })

  it('auto-computes canvas from wall bounding box', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior', openings: [] },
        { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, type: 'exterior', openings: [] },
      ],
      rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    // Bounding box: 0,0 to 600,400 + 100 padding = 800x600 min
    expect(result.canvas.width).toBeGreaterThanOrEqual(700)
    expect(result.canvas.height).toBeGreaterThanOrEqual(500)
    expect(result.canvas.gridSize).toBe(10)
  })

  it('fills room color from room type', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }] },
      ],
      furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.rooms[0].color).toBe(ROOM_COLORS.living)
  })

  it('fills metadata defaults', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [], rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.metadata.source).toBe('ai')
    expect(result.metadata.created_at).toBeTruthy()
    expect(result.metadata.updated_at).toBeTruthy()
  })

  it('does not overwrite explicitly provided values', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      canvas: { width: 2000, height: 1500, gridSize: 20 },
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior', thickness: 30, height: 300, openings: [] },
      ],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], color: '#FF0000' },
      ],
      furniture: [], annotations: [],
      metadata: { created_at: 'custom', updated_at: 'custom', source: 'sketcher' as const },
    }
    const result = applyDefaults(input)
    expect(result.walls[0].thickness).toBe(30)
    expect(result.walls[0].height).toBe(300)
    expect(result.rooms[0].color).toBe('#FF0000')
    expect(result.canvas.width).toBe(2000)
    expect(result.metadata.source).toBe('sketcher')
  })

  it('output validates against strict FloorPlanSchema', () => {
    const input = {
      version: 1, id: 'test', name: 'Test', units: 'metric',
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior', openings: [] },
      ],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }] },
      ],
      furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    const parsed = FloorPlanSchema.safeParse(result)
    expect(parsed.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/defaults.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add input schemas to types.ts**

Add below the existing schemas in `src/sketch/types.ts` (after line 128):

```typescript
// ─── Input schemas (relaxed, for generate_floor_plan tool) ──────────────
// Note: OpeningSchema is reused as-is — its properties fields are already optional.

export const WallInputSchema = z.object({
  id: z.string(),
  start: PointSchema,
  end: PointSchema,
  thickness: z.number().optional(),
  height: z.number().optional(),
  type: z.enum(['exterior', 'interior', 'divider']),
  openings: z.array(OpeningSchema),
})

export const RoomInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: RoomTypeSchema,
  polygon: z.array(PointSchema).min(3),
  wall_ids: z.array(z.string()).optional(),
  color: z.string().optional(),
  area: z.number().optional(),
  floor_material: z.string().optional(),
})

export const FurnitureItemInputSchema = z.object({
  id: z.string(),
  type: z.string(),
  catalog_id: z.string().optional(),
  position: PointSchema,
  rotation: z.number().optional(),
  width: z.number(),
  depth: z.number(),
  label: z.string().optional(),
  material: z.string().optional(),
})

export const FloorPlanInputSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  units: z.enum(['metric', 'imperial']),
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    gridSize: z.number(),
  }).optional(),
  walls: z.array(WallInputSchema),
  rooms: z.array(RoomInputSchema),
  furniture: z.array(FurnitureItemInputSchema),
  annotations: z.array(AnnotationSchema),
  metadata: z.object({
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    source: z.enum(['ai', 'sketcher', 'mixed']).optional(),
  }).optional(),
})
export type FloorPlanInput = z.infer<typeof FloorPlanInputSchema>
```

- [ ] **Step 4: Create defaults.ts**

Create `src/sketch/defaults.ts`:

```typescript
import type { FloorPlan, Wall, Room, FurnitureItem } from './types'
import type { FloorPlanInput } from './types'
import { boundingBox } from './geometry'

export const ROOM_COLORS: Record<string, string> = {
  living: '#E8F5E9',
  bedroom: '#E3F2FD',
  kitchen: '#FFF3E0',
  bathroom: '#E0F7FA',
  hallway: '#F5F5F5',
  office: '#F3E5F5',
  dining: '#FFF8E1',
  garage: '#EFEBE9',
  closet: '#ECEFF1',
  laundry: '#E8EAF6',
  balcony: '#F1F8E9',
  terrace: '#F1F8E9',
  storage: '#ECEFF1',
  utility: '#ECEFF1',
  other: '#FAFAFA',
}

const WALL_THICKNESS: Record<string, number> = {
  exterior: 20,
  interior: 10,
  divider: 5,
}

const DEFAULT_HEIGHT = 250

export function applyDefaults(input: FloorPlanInput): FloorPlan {
  const now = new Date().toISOString()

  // Walls
  const walls: Wall[] = input.walls.map(w => ({
    ...w,
    thickness: w.thickness ?? WALL_THICKNESS[w.type] ?? 10,
    height: w.height ?? DEFAULT_HEIGHT,
    openings: w.openings.map(o => ({
      ...o,
      properties: {
        ...o.properties,
        // Opening defaults could go here if needed
      },
    })),
  }))

  // Rooms
  const rooms: Room[] = input.rooms.map(r => ({
    ...r,
    color: r.color ?? ROOM_COLORS[r.type] ?? '#FAFAFA',
  }))

  // Furniture
  const furniture: FurnitureItem[] = input.furniture.map(f => ({
    ...f,
    rotation: f.rotation ?? 0,
  }))

  // Canvas
  const canvas = input.canvas ?? (() => {
    const bb = boundingBox(walls)
    const pad = 100
    return {
      width: Math.max(bb.maxX - bb.minX + pad * 2, 400),
      height: Math.max(bb.maxY - bb.minY + pad * 2, 400),
      gridSize: 10,
    }
  })()

  // Metadata
  const metadata = {
    created_at: input.metadata?.created_at ?? now,
    updated_at: input.metadata?.updated_at ?? now,
    source: input.metadata?.source ?? 'ai' as const,
  }

  return {
    version: input.version,
    id: input.id,
    name: input.name,
    units: input.units,
    canvas,
    walls,
    rooms,
    furniture,
    annotations: input.annotations,
    metadata,
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sketch/defaults.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sketch/types.ts src/sketch/defaults.ts src/sketch/defaults.test.ts
git commit --no-gpg-sign -m "feat: add input schemas and applyDefaults() for smart defaults"
```

---

## Task 7: CTA Config System

**Files:**
- Create: `src/sketch/cta-config.ts`
- Create: `src/sketch/cta-config.test.ts`
- Modify: `src/types.ts:98-110`

- [ ] **Step 1: Write failing tests for pickCTA**

Create `src/sketch/cta-config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { pickCTA, CTA_CONFIG } from './cta-config'
import type { SessionCTAState } from '../types'

function freshState(): SessionCTAState {
  return { ctasShown: 0, lastCtaAt: 0, toolCallCount: 1 }
}

describe('pickCTA', () => {
  it('returns a CTA for a valid trigger', () => {
    const result = pickCTA('first_generation', freshState(), 'default')
    expect(result).not.toBeNull()
    expect(result!.text).toBeTruthy()
    expect(result!.url).toContain('utm_source=ai-sketcher')
  })

  it('returns null when max CTAs reached', () => {
    const state: SessionCTAState = { ctasShown: 10, lastCtaAt: 0, toolCallCount: 20 }
    const result = pickCTA('first_generation', state, 'default')
    expect(result).toBeNull()
  })

  it('returns null during cooldown period', () => {
    const state: SessionCTAState = { ctasShown: 1, lastCtaAt: 5, toolCallCount: 6 }
    // cooldown is 2, so toolCallCount - lastCtaAt = 1, which is less than cooldown
    const result = pickCTA('first_generation', state, 'default')
    expect(result).toBeNull()
  })

  it('returns null for unknown trigger', () => {
    const result = pickCTA('unknown_trigger', freshState(), 'default')
    expect(result).toBeNull()
  })

  it('filters by variant', () => {
    const result = pickCTA('first_generation', freshState(), 'nonexistent_variant')
    expect(result).toBeNull()
  })
})

describe('CTA_CONFIG', () => {
  it('has triggers for key milestones', () => {
    expect(CTA_CONFIG.triggers['first_generation']).toBeDefined()
    expect(CTA_CONFIG.triggers['export']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/cta-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add SessionCTAState to types.ts**

In `src/types.ts`, add to the `SketchSession` interface and add the new type:

```typescript
export interface SessionCTAState {
  ctasShown: number
  lastCtaAt: number
  toolCallCount: number
}

export interface SketchSession {
  sketchId?: string
  plan?: FloorPlan
  cta?: SessionCTAState
}
```

Also add `CTA_VARIANT` to `Env`:

```typescript
export interface Env {
  DB: D1Database
  MCP_OBJECT: DurableObjectNamespace
  SKETCH_SYNC: DurableObjectNamespace
  WORKER_URL: string
  CTA_VARIANT?: string
}
```

- [ ] **Step 4: Create cta-config.ts**

Create `src/sketch/cta-config.ts`:

```typescript
import type { SessionCTAState } from '../types'

export interface CTAMessage {
  text: string
  url: string
  variant: string
}

export interface CTAConfig {
  triggers: Record<string, CTAMessage[]>
  settings: {
    max_ctas_per_session: number
    cooldown_between_ctas: number
    variant: string
  }
}

const BASE_URL = 'https://roomsketcher.com/signup'
const UTM_BASE = 'utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade'

export const CTA_CONFIG: CTAConfig = {
  triggers: {
    first_generation: [
      {
        text: 'Want to see this in 3D? RoomSketcher lets you walk through your floor plan and furnish it with 7000+ items.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=first-plan`,
        variant: 'default',
      },
    ],
    first_edit: [
      {
        text: 'Love editing your layout? RoomSketcher Pro gives you HD renders, measurements, and professional floor plan styles.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=first-edit`,
        variant: 'default',
      },
    ],
    export: [
      {
        text: 'Need a professional floor plan? RoomSketcher generates HD 2D and 3D floor plans ready for presentations.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=export`,
        variant: 'default',
      },
    ],
    'room:kitchen': [
      {
        text: 'This kitchen would come alive in RoomSketcher — see cabinets, appliances, and lighting rendered in 3D.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=kitchen-3d`,
        variant: 'default',
      },
    ],
    'room:bedroom': [
      {
        text: 'RoomSketcher lets you try different furniture layouts in this bedroom and see them in a 3D walkthrough.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=bedroom-3d`,
        variant: 'default',
      },
    ],
    'room:bathroom': [
      {
        text: 'Visualize tile, fixtures, and lighting in this bathroom with RoomSketcher\'s photorealistic 3D Photos.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=bathroom-3d`,
        variant: 'default',
      },
    ],
    suggest_improvements: [
      {
        text: 'Want to explore these changes in 3D before committing? RoomSketcher Pro includes Live 3D walkthroughs.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=suggest-3d`,
        variant: 'default',
      },
    ],
    furniture_placed: [
      {
        text: 'These furniture items are simple shapes here — in RoomSketcher, you get photorealistic 3D furniture from a library of 7000+ items.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=furniture-3d`,
        variant: 'default',
      },
    ],
  },
  settings: {
    max_ctas_per_session: 3,
    cooldown_between_ctas: 2,
    variant: 'default',
  },
}

export function pickCTA(
  trigger: string,
  state: SessionCTAState,
  activeVariant: string,
): CTAMessage | null {
  const { settings } = CTA_CONFIG

  // Check budget
  if (state.ctasShown >= settings.max_ctas_per_session) return null

  // Check cooldown
  if (state.toolCallCount - state.lastCtaAt < settings.cooldown_between_ctas) return null

  // Find matching CTAs for this trigger
  const candidates = CTA_CONFIG.triggers[trigger]
  if (!candidates || candidates.length === 0) return null

  // Filter by variant
  const match = candidates.find(c => c.variant === activeVariant)
  return match ?? null
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sketch/cta-config.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sketch/cta-config.ts src/sketch/cta-config.test.ts
git commit --no-gpg-sign -m "feat: add configurable CTA system with A/B variant support"
```

---

## Task 8: Two-Phase Validation + Input Schema Swap

**Files:**
- Modify: `src/sketch/tools.ts:1-58`
- Modify: `src/index.ts:210-260`

- [ ] **Step 1: Update imports in tools.ts**

Add to the imports at the top of `src/sketch/tools.ts`:

```typescript
import { FloorPlanSchema, FloorPlanInputSchema, ChangeSchema } from './types'
import { applyDefaults } from './defaults'
import { pointInPolygon } from './geometry'
import { pickCTA } from './cta-config'
import type { SessionCTAState } from '../types'
```

Replace the existing `FloorPlanSchema` import line — it's now imported alongside `FloorPlanInputSchema`.

- [ ] **Step 2: Update handleGenerateFloorPlan for two-phase validation**

Replace the function with the new signature and two-phase validation:

```typescript
export async function handleGenerateFloorPlan(
  plan: unknown,
  db: D1Database,
  setState: (s: { sketchId: string; plan: FloorPlan }) => void,
  workerUrl: string,
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  // Phase 1: Validate against relaxed input schema
  const parsed = FloorPlanInputSchema.safeParse(plan)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')
    return { content: [{ type: 'text' as const, text: `Invalid floor plan:\n${errors}` }] }
  }

  // Phase 2: Apply defaults → strict FloorPlan
  const floorPlan = applyDefaults(parsed.data)

  // Assign ID + timestamps
  floorPlan.id = nanoid()
  floorPlan.metadata.created_at = new Date().toISOString()
  floorPlan.metadata.updated_at = floorPlan.metadata.created_at

  // Compute room areas
  for (const room of floorPlan.rooms) {
    if (room.area === undefined) {
      room.area = shoelaceArea(room.polygon)
    }
  }

  // Render SVG + persist
  const svg = floorPlanToSvg(floorPlan)
  await saveSketch(db, floorPlan.id, floorPlan, svg)
  setState({ sketchId: floorPlan.id, plan: floorPlan })

  // CTA
  const cta = pickCTA('first_generation', ctaState, ctaVariant)
  if (cta) {
    ctaState.ctasShown++
    ctaState.lastCtaAt = ctaState.toolCallCount
    updateCta(ctaState)
  }

  // Summary
  const totalArea = floorPlan.rooms.reduce((sum, r) => sum + (r.area ?? 0), 0)
  const lines = [
    `**${floorPlan.name}** created`,
    `${floorPlan.walls.length} walls, ${floorPlan.rooms.length} rooms, ${floorPlan.furniture.length} furniture items`,
    `Total area: ${totalArea.toFixed(1)} m²`,
    ``,
    `Open in sketcher: ${workerUrl}/sketcher/${floorPlan.id}`,
  ]
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`)
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}
```

- [ ] **Step 3: Update the caller in index.ts**

In `src/index.ts`:

Add import at top:
```typescript
import { FloorPlanInputSchema } from './sketch/types'
```

Change `generate_floor_plan` inputSchema from `FloorPlanSchema` to `FloorPlanInputSchema`.

Update the handler to pass CTA state:
```typescript
async ({ plan }) => {
  const ctaState = this.state.cta ?? { ctasShown: 0, lastCtaAt: 0, toolCallCount: 0 }
  ctaState.toolCallCount++
  return handleGenerateFloorPlan(
    plan,
    this.env.DB,
    (s) => this.setState({ ...s, cta: ctaState }),
    this.getWorkerUrl(),
    this.env.CTA_VARIANT ?? 'default',
    ctaState,
    (cta) => this.setState({ ...this.state, cta }),
  )
},
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git commit -m "feat: two-phase validation with input schemas and applyDefaults()"
```

---

## Task 8b: Enriched Tool Description

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the enriched generate_floor_plan description**

Replace the description string in the `generate_floor_plan` tool registration. The new description contains (refer to spec Section 3 for full text):

1. Workflow directive: "Always start from a template. Call list_templates to find the closest match..."
2. Standard dimensions reference (wall thickness, ceiling height, min room sizes, door/window widths)
3. Color palette by room type (full hex map)
4. Door placement rules
5. Furniture directive
6. One compact example (trimmed studio JSON showing shape only)

This description will be ~4-5KB. Compose it as a template literal string.

- [ ] **Step 2: Update update_sketch description**

Add to the `update_sketch` tool description:
> "After applying changes, consider using suggest_improvements to check the plan and offer the user a next step."

- [ ] **Step 3: Update suggest_improvements description**

Update to reflect the new structured output: "Analyze the current floor plan and return structured spatial, opening, and furniture data with reasoning prompts. Use this to evaluate room proportions, traffic flow, door placement, furniture fit, and overall livability."

- [ ] **Step 4: Wire CTA into update_sketch and export_sketch handlers**

Add CTA parameters to `handleUpdateSketch` and `handleExportSketch` in `src/sketch/tools.ts`:

```typescript
// In handleUpdateSketch — add to function signature:
export async function handleUpdateSketch(
  sketchId: string, changes: Change[], db: D1Database, sketchSyncStub: DurableObjectStub,
  state: { sketchId?: string; plan?: FloorPlan },
  ctaVariant: string, ctaState: SessionCTAState, updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  // ... existing logic ...
  // At the end, before returning:
  const cta = pickCTA('first_edit', ctaState, ctaVariant)
  if (cta) { ctaState.ctasShown++; ctaState.lastCtaAt = ctaState.toolCallCount; updateCta(ctaState) }
  // Append cta to response text if present
}

// In handleExportSketch — add to function signature:
export async function handleExportSketch(
  sketchId: string, format: string, db: D1Database, hostUrl: string,
  state: { sketchId?: string; plan?: FloorPlan },
  ctaVariant: string, ctaState: SessionCTAState, updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  // ... existing logic ...
  const cta = pickCTA('export', ctaState, ctaVariant)
  if (cta) { ctaState.ctasShown++; ctaState.lastCtaAt = ctaState.toolCallCount; updateCta(ctaState) }
}
```

Update callers in `src/index.ts` for both tools — same pattern as generate_floor_plan:

```typescript
// In update_sketch handler:
ctaState.toolCallCount++
return handleUpdateSketch(sketch_id, changes, env.DB, sketchSyncStub, state,
  env.CTA_VARIANT ?? 'default', ctaState, (s) => { /* update session */ })

// In export_sketch handler:
ctaState.toolCallCount++
return handleExportSketch(sketch_id, format, env.DB, hostUrl, state,
  env.CTA_VARIANT ?? 'default', ctaState, (s) => { /* update session */ })
```

**CTA trigger priority (one CTA per tool call max):** Only the primary trigger fires per tool call. In `generate_floor_plan`, the primary trigger is `'first_generation'`. Context triggers like `'furniture_placed'` or `'room:kitchen'` fire only if the primary trigger returned null (already shown or throttled). Use a fallback chain:

```typescript
let cta = pickCTA('first_generation', ctaState, ctaVariant)
if (!cta && floorPlan.furniture.length > 0) {
  cta = pickCTA('furniture_placed', ctaState, ctaVariant)
}
if (!cta) {
  const roomTypes = plan.rooms.map(r => r.type)
  for (const rt of roomTypes) {
    cta = pickCTA(`room:${rt}`, ctaState, ctaVariant)
    if (cta) break
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/sketch/tools.ts
git commit -m "feat: enriched tool descriptions and full CTA wiring"
```

---

## Task 9: Opinionated suggest_improvements Output

**Files:**
- Modify: `src/sketch/tools.ts:151-201`

- [ ] **Step 1: Rewrite handleSuggestImprovements**

Replace the current implementation with one that outputs structured plan data + reasoning prompts per the spec. Key additions:
- Import `pointInPolygon` from geometry
- Compute room dimensions from polygon bounding boxes
- Assign furniture to rooms using point-in-polygon
- Compute opening counts per room
- Output the structured format from spec Section 6
- Replace hardcoded CTA with `pickCTA('suggest_improvements', ...)`

```typescript
export async function handleSuggestImprovements(
  sketchId: string,
  db: D1Database,
  state: { sketchId?: string; plan?: FloorPlan },
  ctaVariant: string,
  ctaState: SessionCTAState,
  updateCta: (s: SessionCTAState) => void,
): Promise<ToolResult> {
  let plan: FloorPlan | undefined = state.sketchId === sketchId ? state.plan : undefined
  if (!plan) {
    const loaded = await loadSketch(db, sketchId)
    if (!loaded) return { content: [{ type: 'text' as const, text: `Sketch ${sketchId} not found.` }] }
    plan = loaded.plan
  }

  // Room dimensions from polygon bounding boxes
  const roomData = plan.rooms.map(r => {
    const xs = r.polygon.map(p => p.x)
    const ys = r.polygon.map(p => p.y)
    const w = (Math.max(...xs) - Math.min(...xs)) / 100
    const h = (Math.max(...ys) - Math.min(...ys)) / 100
    const area = r.area ?? shoelaceArea(r.polygon)

    // Furniture in this room
    const roomFurniture = plan!.furniture.filter(f =>
      pointInPolygon(f.position, r.polygon)
    )

    // Openings on walls that border this room (wall endpoint inside or on room polygon)
    let doors = 0
    let windows = 0
    for (const wall of plan!.walls) {
      const startInRoom = pointInPolygon(wall.start, r.polygon)
      const endInRoom = pointInPolygon(wall.end, r.polygon)
      if (startInRoom || endInRoom) {
        for (const o of wall.openings) {
          if (o.type === 'door') doors++
          if (o.type === 'window') windows++
        }
      }
    }

    return { label: r.label, type: r.type, width: w, height: h, area, furniture: roomFurniture, doors, windows }
  })

  const totalArea = roomData.reduce((s, r) => s + r.area, 0)
  const emptyRooms = roomData.filter(r => r.furniture.length === 0).map(r => r.label)

  // Furniture not assigned to any room
  const assignedFurnitureIds = new Set(roomData.flatMap(r => r.furniture.map(f => f.id)))
  const unassigned = plan.furniture.filter(f => !assignedFurnitureIds.has(f.id))

  const lines = [
    `Analysis for "${plan.name}":`,
    '',
    'SPATIAL DATA:',
    ...roomData.map(r => `- ${r.label} (${r.type}): ${r.width.toFixed(1)}m x ${r.height.toFixed(1)}m (${r.area.toFixed(1)}sqm), furniture: ${r.furniture.map(f => f.label ?? f.type).join(', ') || 'none'}`),
    `- Total area: ${totalArea.toFixed(1)}sqm across ${roomData.length} rooms`,
    '',
    'OPENING DATA:',
    ...roomData.map(r => `- ${r.label}: ${r.doors} doors, ${r.windows} windows`),
    '',
    'FURNITURE DATA:',
    ...roomData.map(r => `- ${r.label}: ${r.furniture.length} items`),
    ...(emptyRooms.length > 0 ? [`- Rooms with no furniture: ${emptyRooms.join(', ')}`] : []),
    ...(unassigned.length > 0 ? [`- Unassigned (outside all rooms): ${unassigned.map(f => f.label ?? f.type).join(', ')}`] : []),
    '',
    'REVIEW THESE AREAS (use your architectural knowledge to evaluate):',
    '- Room proportions: Are any rooms too narrow, oversized relative to others, or unusually shaped for their purpose?',
    '- Circulation: Can someone walk naturally from the front door to every room? Are hallways and doorways wide enough for comfortable movement?',
    '- Openings: Does every room have appropriate doors and windows? Do doors swing in practical directions? Is there natural light where needed?',
    '- Furniture: Does the furniture fit comfortably with walking clearance? Are there rooms that feel empty or overcrowded? Is the arrangement functional?',
    '- Light and ventilation: Do kitchens and bathrooms have windows or ventilation paths? Are living spaces well-lit?',
    '- Flow: Does the layout make sense for daily life? Is the kitchen near the dining area? Are bedrooms away from noisy spaces?',
    '- Overall: Does this feel like a place someone would want to live in?',
  ]

  // CTA
  const cta = pickCTA('suggest_improvements', ctaState, ctaVariant)
  if (cta) {
    lines.push('', `_${cta.text} [Try RoomSketcher](${cta.url})_`)
    ctaState.ctasShown++
    ctaState.lastCtaAt = ctaState.toolCallCount
    updateCta(ctaState)
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}
```

- [ ] **Step 2: Update the caller in index.ts to pass CTA state**

Same pattern as Task 8 — pass `ctaVariant`, `ctaState`, and `updateCta` to the handler.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/sketch/tools.ts src/index.ts
git commit --no-gpg-sign -m "feat: opinionated suggest_improvements with structured data + reasoning prompts"
```

---

## Task 10: Template Catalog — Tools and JSON Files

**Files:**
- Create: `src/sketch/templates/studio.json`
- Create: `src/sketch/templates/1br-apartment.json`
- Create: `src/sketch/templates/2br-apartment.json`
- Create: `src/sketch/templates/3br-house.json`
- Create: `src/sketch/templates/open-plan-loft.json`
- Create: `src/sketch/templates/l-shaped-home.json`
- Modify: `src/index.ts`

This is the most creative task — each template must be a valid FloorPlan JSON with realistic proportions, proper wall connections, doors, windows, and furniture.

- [ ] **Step 1: Create studio template**

Create `src/sketch/templates/studio.json` — a 40sqm studio apartment:
- 4 exterior walls forming a rectangle (~700cm x 570cm)
- 1 interior wall separating bathroom
- Front door, bathroom door, 2 windows
- Furniture: sofa, coffee table, TV unit, bed (double), nightstand, toilet, bath-sink, shower, kitchen counter, fridge, stove
- Rooms: Living Area, Bathroom

Validate it passes `FloorPlanSchema.safeParse()`.

- [ ] **Step 2: Create 1br-apartment template**

Create `src/sketch/templates/1br-apartment.json` — a 55sqm 1-bedroom apartment:
- Exterior walls, 2-3 interior walls
- Rooms: Living Room, Bedroom, Bathroom, Hallway
- Front door, 3 interior doors, 3 windows
- Appropriate furniture in each room

- [ ] **Step 3: Create 2br-apartment template**

Create `src/sketch/templates/2br-apartment.json` — a 80sqm 2-bedroom apartment:
- Rooms: Living Room, Kitchen, Bedroom 1, Bedroom 2, Bathroom, Hallway
- L-shaped hallway connecting rooms
- 5 doors, 4+ windows
- Full furniture sets

- [ ] **Step 4: Create 3br-house template**

Create `src/sketch/templates/3br-house.json` — a 120sqm 3-bedroom house:
- Rooms: Living Room, Kitchen, Dining, 3 Bedrooms, 2 Bathrooms, Hallway
- Rectangular footprint, corridor
- 8+ doors, 6+ windows
- Full furniture sets

- [ ] **Step 5: Create open-plan-loft template**

Create `src/sketch/templates/open-plan-loft.json` — a 70sqm open plan:
- Minimal interior walls, just bathroom separated
- Rooms: Main Space, Bathroom
- Large windows
- Furniture defines zones (kitchen area, living area, sleeping area)

- [ ] **Step 6: Create l-shaped-home template**

Create `src/sketch/templates/l-shaped-home.json` — a 100sqm L-shaped layout:
- Two wings at 90 degrees
- 5+ rooms across the two wings
- Demonstrates non-rectangular layouts

- [ ] **Step 7: Validate all templates pass FloorPlanSchema**

Write a quick test or script that loads each JSON file and validates it:

```typescript
import { describe, it, expect } from 'vitest'
import { FloorPlanSchema } from './types'
import studioTpl from './templates/studio.json'
import onebrTpl from './templates/1br-apartment.json'
import twobrTpl from './templates/2br-apartment.json'
import threebrTpl from './templates/3br-house.json'
import loftTpl from './templates/open-plan-loft.json'
import lshapedTpl from './templates/l-shaped-home.json'

const templates: Record<string, unknown> = {
  'studio': studioTpl,
  '1br-apartment': onebrTpl,
  '2br-apartment': twobrTpl,
  '3br-house': threebrTpl,
  'open-plan-loft': loftTpl,
  'l-shaped-home': lshapedTpl,
}

describe('templates', () => {
  for (const [name, json] of Object.entries(templates)) {
    it(`${name} is a valid FloorPlan`, () => {
      const result = FloorPlanSchema.safeParse(json)
      if (!result.success) {
        console.error(name, result.error.issues)
      }
      expect(result.success).toBe(true)
    })

    it(`${name} has furniture`, () => {
      expect((json as any).furniture.length).toBeGreaterThan(0)
    })
  }
})
```

- [ ] **Step 8: Register list_templates and get_template tools in index.ts**

Add to `src/index.ts` in the `init()` method:

```typescript
this.server.registerTool(
  'list_templates',
  {
    description: 'List available floor plan templates. Use this to find a starting point before generating a floor plan. Always start from the nearest template rather than building coordinates from scratch.',
    inputSchema: {},
  },
  async () => {
    const templates = [
      { id: 'studio', description: 'Studio apartment — open plan with bathroom', rooms: '1 + bathroom', size: '35-45 sqm' },
      { id: '1br-apartment', description: '1-bedroom apartment — living, bedroom, bathroom, hallway', rooms: '3 + hallway', size: '50-65 sqm' },
      { id: '2br-apartment', description: '2-bedroom apartment — living, kitchen, 2 bedrooms, bathroom', rooms: '5 + hallway', size: '70-90 sqm' },
      { id: '3br-house', description: '3-bedroom house — living, kitchen, dining, 3 bedrooms, 2 bathrooms', rooms: '7+', size: '110-140 sqm' },
      { id: 'open-plan-loft', description: 'Open plan loft — minimal walls, large windows, zones defined by furniture', rooms: '1 + bathroom', size: '60-80 sqm' },
      { id: 'l-shaped-home', description: 'L-shaped home — two wings at 90 degrees, non-rectangular', rooms: '5+', size: '90-120 sqm' },
    ]
    const text = templates.map(t =>
      `- **${t.id}**: ${t.description} (${t.rooms}, ${t.size})`
    ).join('\n')
    return { content: [{ type: 'text' as const, text }] }
  },
)

this.server.registerTool(
  'get_template',
  {
    description: 'Get a floor plan template by ID. Returns complete FloorPlan JSON you can adapt and pass to generate_floor_plan. Modify dimensions, add/remove rooms, reposition furniture to match the user\'s request.',
    inputSchema: {
      template_id: z.string().describe('Template ID from list_templates (e.g. "2br-apartment")'),
    },
  },
  async ({ template_id }) => {
    // Static imports at top of file (add these to file-level imports):
    // import studioTpl from './sketch/templates/studio.json'
    // import onebrTpl from './sketch/templates/1br-apartment.json'
    // import twobrTpl from './sketch/templates/2br-apartment.json'
    // import threebrTpl from './sketch/templates/3br-house.json'
    // import loftTpl from './sketch/templates/open-plan-loft.json'
    // import lshapedTpl from './sketch/templates/l-shaped-home.json'
    const templates: Record<string, unknown> = {
      'studio': studioTpl,
      '1br-apartment': onebrTpl,
      '2br-apartment': twobrTpl,
      '3br-house': threebrTpl,
      'open-plan-loft': loftTpl,
      'l-shaped-home': lshapedTpl,
    }
    const tpl = templates[template_id]
    if (!tpl) {
      return { content: [{ type: 'text' as const, text: `Unknown template: ${template_id}. Use list_templates to see available options.` }] }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(tpl, null, 2) }] }
  },
)
```

Note: JSON imports in Cloudflare Workers need `resolveJsonModule: true` in `tsconfig.json`. Use static imports (not dynamic `import()`) — dynamic imports wrap JSON in `{ default: {...} }` which would serialize the wrapper object instead of the raw FloorPlan. Static default imports resolve directly to the JSON value.

- [ ] **Step 9: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/sketch/templates/ src/index.ts
git commit --no-gpg-sign -m "feat: add 6 floor plan templates and list_templates/get_template tools"
```

---

## Task 11: Update ARCH.md

**Files:**
- Modify: `docs/arch/main/ARCH.md`

- [ ] **Step 1: Add new sections to ARCH.md**

Add after the "MCP Tools" section:

1. **Template Catalog** section — describes the 6 templates, `list_templates`/`get_template` tools, and the agent workflow
2. **Furniture Catalog (V1)** section — describes the ~25 items, SVG rendering as labeled rectangles, change types
3. **Smart Defaults** section — describes the two-schema approach, applyDefaults(), and the defaults table
4. **CTA System** section — describes cta-config.ts, pickCTA(), A/B variant via env var, session throttling

Update the tool count from 12 to 14 (adding list_templates, get_template).

Update the file structure diagram to include new files.

Update the Change Types table to include the 3 furniture change types.

Move furniture and annotations from "reserved for V2" to "V1 (labeled rectangles)" in the Data Model section.

- [ ] **Step 2: Commit**

```bash
git add docs/arch/main/ARCH.md
git commit --no-gpg-sign -m "docs: update ARCH.md with template catalog, furniture, smart defaults, CTA system"
```

---

## Task 12: Integration Smoke Test

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test locally with wrangler**

Run: `npx wrangler dev --local`
Expected: Server starts without errors. Hit `/health` to verify.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit --no-gpg-sign -m "fix: integration fixes from smoke test"
```
