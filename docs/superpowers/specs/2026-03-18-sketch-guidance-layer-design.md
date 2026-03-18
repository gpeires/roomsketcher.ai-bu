# Sketch Guidance Layer — Design Spec

> Additive guidance layer on top of existing sketch tools. Provides templates, smart defaults, furniture, enriched prompting, and a configurable CTA system so AI agents produce delightful floor plans fast — while preserving full low-level freedom.

## Context

The current `generate_floor_plan` tool exposes a rich schema but gives the agent minimal guidance: one example, no defaults, no furniture, no standard dimensions. Agents spend tokens on coordinate math instead of making plans feel right. The result is technically valid but lifeless floor plans.

This spec adds a guidance layer that makes the happy path fast and beautiful, while keeping the low-level tools untouched for full creative freedom.

### Goals

1. Agents produce realistic, well-proportioned floor plans on the first try
2. Every floor plan includes furniture (rooms feel lived-in, not empty)
3. The upgrade path to full RoomSketcher is obvious and enticing
4. A/B testable messaging for conversion optimization
5. Collaborative AI + human editing loop works naturally

### Non-Goals

- 3D rendering (future phase)
- Drag-and-drop furniture in browser sketcher (future phase)
- Room auto-detection from wall topology (future phase)
- Replacing the existing low-level tool interface

---

## 1. Template Catalog

### Overview

Six floor plan templates the agent uses as starting points. The agent silently picks the closest match, adapts to the user's request, and presents the finished result. The user never sees template names or knows one was used.

### Templates

| Template ID | Rooms | Approx Size | Key Features |
|-------------|-------|-------------|--------------|
| `studio` | 1 + bathroom | 35-45 sqm | Open plan, single exterior wall loop |
| `1br-apartment` | 3 (living, bed, bath) | 50-65 sqm | Hallway entry, interior walls |
| `2br-apartment` | 5 (living, 2 bed, bath, kitchen) | 70-90 sqm | L-shaped hallway, open kitchen option |
| `3br-house` | 7+ (living, 3 bed, 2 bath, kitchen) | 110-140 sqm | Rectangular footprint, corridor |
| `open-plan-loft` | 2 (main space, bathroom) | 60-80 sqm | Minimal interior walls, large windows |
| `l-shaped-home` | 5+ | 90-120 sqm | Two wings at 90deg, non-rectangular |

### Template Contents

Each template is a complete, valid FloorPlan JSON file including:

- All walls with proper connections (endpoints share coordinates)
- All rooms with polygons aligned to wall centerlines
- Doors on every room, windows on exterior walls
- Furniture pre-placed from the furniture catalog (Section 2)
- Standard color palette applied by room type
- Comment annotations explaining dimension/placement choices

### Storage

Templates live in `src/sketch/templates/` as individual JSON files:

```
src/sketch/templates/
  studio.json
  1br-apartment.json
  2br-apartment.json
  3br-house.json
  open-plan-loft.json
  l-shaped-home.json
```

### MCP Registration

Two new MCP tools in `src/index.ts`:

- **`list_templates`** — Returns the template catalog (ID, description, room count, approx size). No parameters. The agent calls this to find the closest match to the user's request.
- **`get_template`** — Takes a `template_id` string, returns the full FloorPlan JSON. The agent uses this as a starting point, adapts it, then passes the modified JSON to `generate_floor_plan`.

Additionally, `generate_floor_plan` gains an optional `template` parameter. When provided, the tool loads the template JSON, allowing the agent to skip the separate `get_template` call for simple cases.

Why tools instead of MCP Prompts: Prompts are client-initiated (invoked from UI menus in Claude Desktop, Cursor, etc.), not agent-initiated. The agent cannot programmatically call `prompts/get` mid-conversation. Tools are the correct primitive for agent-browsable data.

### Agent Workflow

The enriched `generate_floor_plan` description directs the agent:

> "Always start from the nearest template. Call list_templates, pick the closest match, then adapt dimensions, add/remove rooms, and adjust openings and furniture to match the user's request. Never generate coordinates from a blank canvas."

The agent adapts by:
1. Scaling dimensions to match requested size
2. Adding/removing rooms
3. Repositioning furniture to fit new dimensions
4. Adjusting openings (doors, windows) for the new layout

---

## 2. Furniture Catalog

### Overview

A catalog of ~30 common furniture items with standard dimensions. Rendered as labeled rectangles in SVG. Templates ship fully furnished.

### Catalog Structure

File: `src/sketch/furniture-catalog.ts`

```typescript
interface CatalogItem {
  type: string           // e.g. "bed-double", "sofa-3seat"
  label: string          // e.g. "Bed", "Sofa"
  defaultWidth: number   // cm
  defaultDepth: number   // cm
  roomTypes: RoomType[]  // which rooms this item belongs in
  svgIcon?: string       // future: top-down SVG icon
  catalogId?: string     // future: link to RoomSketcher product catalog
}
```

### Initial Catalog (~30 items)

| Room Type | Items |
|-----------|-------|
| Bedroom | bed (double), bed (single), nightstand x2, wardrobe, dresser |
| Living | sofa (3-seat), coffee table, TV unit, armchair, bookshelf |
| Kitchen | counter, sink, fridge, stove/oven, dining table, chairs |
| Bathroom | toilet, sink/vanity, bathtub, shower, mirror |
| Office | desk, office chair, bookshelf |
| Dining | dining table, chairs x4-6, sideboard |
| Hallway | shoe rack, coat hook |

### Standard Dimensions

All dimensions in centimeters:

| Item | Width | Depth |
|------|-------|-------|
| Bed (double) | 160 | 200 |
| Bed (single) | 90 | 200 |
| Nightstand | 50 | 40 |
| Wardrobe | 120 | 60 |
| Dresser | 100 | 50 |
| Sofa (3-seat) | 220 | 90 |
| Coffee table | 120 | 60 |
| TV unit | 150 | 40 |
| Armchair | 80 | 80 |
| Bookshelf | 80 | 30 |
| Kitchen counter | 240 | 60 |
| Sink (kitchen) | 60 | 60 |
| Fridge | 70 | 70 |
| Stove/oven | 60 | 60 |
| Dining table | 160 | 90 |
| Dining chair | 45 | 45 |
| Toilet | 40 | 65 |
| Sink/vanity | 60 | 45 |
| Bathtub | 170 | 75 |
| Shower | 90 | 90 |
| Desk | 140 | 70 |
| Office chair | 55 | 55 |
| Sideboard | 160 | 45 |
| Shoe rack | 80 | 30 |

### SVG Rendering

Furniture renders as labeled rectangles in `floorPlanToSvg()`:

- Light gray fill (#F5F5F5) with a subtle border (#BDBDBD)
- Item label centered inside in small text
- Rotation applied via SVG transform
- Z-order (complete): rooms -> furniture -> walls -> openings -> dimensions -> watermark
  - Openings must render above walls for white gap lines to work correctly

### Furniture Change Types

Three new change types added to the `ChangeSchema` discriminated union in `types.ts`:

| Change | Fields |
|--------|--------|
| `add_furniture` | furniture item object (uses `FurnitureItemSchema`) |
| `move_furniture` | furniture_id, position?, rotation? |
| `remove_furniture` | furniture_id |

These enable:
- The `update_sketch` tool to add/move/remove furniture after initial generation
- The WebSocket protocol to transmit furniture changes from the browser sketcher
- Future drag-and-drop furniture in the browser UI

`applyChanges()` in `changes.ts` is extended to handle these three new types.

### Extension Points

- `svgIcon` field: future top-down icons replace rectangles
- `catalogId` field: link to RoomSketcher product catalog for upsell ("see this in 3D")
- `material` field (already in schema): future texture/color variants

---

## 3. Enriched Tool Descriptions

### `generate_floor_plan` Description

The description becomes a compact cheat sheet. It contains principles, not full templates.

**Contents:**

1. **Workflow directive:**
   > "Always start from a template. Call list_templates to find the closest match, then adapt dimensions, rooms, openings, and furniture. Never generate coordinates from a blank canvas."

2. **Standard dimensions reference:**
   - Exterior walls: 20cm thick. Interior: 10cm. Divider: 5cm.
   - Ceiling height: 250cm
   - Minimum room sizes: bedroom 9sqm, bathroom 4sqm, kitchen 6sqm, living room 15sqm
   - Hallway minimum width: 100cm
   - Standard door: 80cm. Bathroom door: 70cm. Front door: 90cm.
   - Standard window: 120cm. Kitchen: 100cm. Bathroom: 60cm.

3. **Color palette by room type:**
   ```
   living: #E8F5E9    bedroom: #E3F2FD    kitchen: #FFF3E0
   bathroom: #E0F7FA  hallway: #F5F5F5    office: #F3E5F5
   dining: #FFF8E1    garage: #EFEBE9     closet: #ECEFF1
   laundry: #E8EAF6   balcony: #F1F8E9    terrace: #F1F8E9
   storage: #ECEFF1   utility: #ECEFF1    other: #FAFAFA
   ```

4. **Door placement rules:**
   > "Every room gets a door. Front door on the longest exterior wall. Bathroom doors swing outward. Bedroom doors swing inward."

5. **Furniture directive:**
   > "Place essential furniture in every room using the furniture catalog. Arrange furniture along walls with 60cm walking clearance between items."

6. **One compact example** (trimmed studio) showing JSON shape only.

**Description size consideration:** The enriched description will be ~4-5KB, sent on every `tools/list` call. This is acceptable for the current tool count. If it becomes a concern, the reference material (dimensions, palette) can be moved to an MCP Resource the agent reads on demand, with the description linking to it.

### `update_sketch` Description

Adds:
> "After applying changes, consider using suggest_improvements to check the plan and offer the user a next step."

### `suggest_improvements` Description

Updated to reflect the new opinionated output format (Section 6).

---

## 4. Smart Defaults

### Fields Made Optional

| Field | Default Logic |
|-------|---------------|
| `wall.thickness` | Lookup: `exterior: 20, interior: 10, divider: 5` |
| `wall.height` | Always `250` |
| `canvas` | Auto-computed: bounding box of all wall endpoints + 100cm padding. `gridSize: 10` |
| `room.color` | Lookup from room type -> color palette map |
| `opening.properties.swingDirection` | `"left"` for exterior doors (swings out), `"right"` for interior |
| `opening.properties.sillHeight` | `90` for windows |
| `opening.properties.windowType` | `"double"` |
| `furniture[].rotation` | `0` |
| `metadata.source` | `"ai"` |
| `metadata.created_at` | Already auto-filled, make optional in schema |
| `metadata.updated_at` | Already auto-filled, make optional in schema |

### Implementation: Two-Schema Approach

The existing `FloorPlanSchema`, `WallSchema`, `RoomSchema` etc. remain **unchanged** — they are the strict runtime/storage schema. All existing code (browser sketcher, changes.ts, svg.ts, persistence.ts) continues to work with fully-typed required fields.

New **input schemas** are added alongside them:

1. `WallInputSchema` — like `WallSchema` but `thickness`, `height` optional
2. `RoomInputSchema` — like `RoomSchema` but `color` optional
3. `OpeningInputSchema` — like `OpeningSchema` but `properties` fields all optional
4. `FloorPlanInputSchema` — uses input sub-schemas, `canvas` and `metadata` optional

These input schemas are used **only** in the `generate_floor_plan` tool's `inputSchema`.

**Two-phase validation:**

1. Validate agent input against `FloorPlanInputSchema` (catches structural errors on the relaxed schema)
2. Run `applyDefaults(input): FloorPlan` — fills all optional fields using the defaults table above, producing a fully-populated `FloorPlan`
3. The result conforms to the strict `FloorPlanSchema` and is safe for storage, SVG rendering, browser sketcher, and WebSocket broadcast

`applyDefaults()` lives in `src/sketch/defaults.ts` with all defaults in a `DEFAULTS` config object at the top for easy modification.

### Impact

- Wall input: 7 required fields -> 4 (`id`, `start`, `end`, `type`)
- Room input: 6 required fields -> 4 (`id`, `label`, `type`, `polygon`)
- Opening input: properties object becomes fully optional
- Canvas input: fully optional (auto-computed from wall bounding box + 100cm padding)
- Metadata input: fully optional (auto-filled)
- **Runtime schema unchanged** — no type errors, no breaking changes anywhere in the codebase

---

## 5. Configurable CTA System

### Structure

File: `src/sketch/cta-config.ts`

```typescript
interface CTAMessage {
  text: string
  url: string
  variant: string  // A/B test variant key
}

interface CTAConfig {
  triggers: Record<string, CTAMessage[]>
  settings: {
    max_ctas_per_session: number
    cooldown_between_ctas: number  // min tool calls between CTAs
    variant: string                // active variant
  }
}
```

### Trigger Types

**Milestone triggers** (fire once per session):
- `first_generation` — after the first floor plan is created
- `first_edit` — after the first `update_sketch` call
- `export` — when the user exports

**Context triggers** (based on content):
- `room:kitchen`, `room:bedroom`, `room:bathroom`, etc.
- `furniture_placed` — when furniture is in the plan
- `suggest_improvements` — after analysis

### CTA Selection

A `pickCTA(trigger: string, sessionState: SessionCTAState): string | null` function:

1. Checks if `max_ctas_per_session` has been reached -> return null
2. Checks if `cooldown_between_ctas` has passed -> return null
3. Filters CTAs by active `variant`
4. Returns the CTA text with URL, or null

### Session State

A lightweight `SessionCTAState` tracked in the DO's `SketchSession`:

```typescript
interface SessionCTAState {
  ctasShown: number
  lastCtaAt: number  // tool call counter
  toolCallCount: number
}
```

### A/B Testing

The active variant is read from `env.CTA_VARIANT` (Cloudflare Workers environment variable), falling back to `settings.variant` in the config file. This means switching variants requires only a `wrangler secret` or dashboard change — no code redeploy.

### Session State Lifetime

`SessionCTAState` is tracked in the MCP DO's `SketchSession` state, which persists in DO SQLite. This means CTA counters persist across conversations with the same DO instance. This is intentional — we don't want to spam a returning user. Counters reset naturally when a new sketch is created (new DO instance).

`toolCallCount` is incremented by a lightweight wrapper in each tool handler (or a shared `withCTA()` higher-order function that wraps tool handlers).

### UTM Structure

All CTA URLs use consistent UTM params:
```
utm_source=ai-sketcher
utm_medium=mcp
utm_campaign=sketch-upgrade
utm_content={trigger-context}  // e.g. "kitchen-3d", "first-plan", "export"
```

---

## 6. Opinionated Suggest Improvements

### Current Behavior

Returns raw analysis prompts for the agent to interpret.

### New Behavior

Returns **structured plan data** plus **reasoning prompts** organized by category. The agent uses its own architectural knowledge to form specific, actionable suggestions — the tool provides the data and the lens, not the conclusions.

### Output Format

```
Analysis for "{plan.name}":

SPATIAL DATA:
- {room.label}: {width}m x {depth}m ({area}sqm), furniture: {items...}
- Hallway: {width}cm wide, {length}m long
- Total area: {total}sqm across {count} rooms
- ...

OPENING DATA:
- {room.label}: {door_count} doors, {window_count} windows
- Front door: {wall}, {width}cm, swings {direction}
- ...

FURNITURE DATA:
- {room.label}: {item_count} items, {coverage}% floor coverage
- Rooms with no furniture: {list}
- ...

REVIEW THESE AREAS (use your architectural knowledge to evaluate):
- Room proportions: Are any rooms too narrow, oversized relative to others, or unusually shaped for their purpose?
- Circulation: Can someone walk naturally from the front door to every room? Are hallways and doorways wide enough for comfortable movement?
- Openings: Does every room have appropriate doors and windows? Do doors swing in practical directions? Is there natural light where needed?
- Furniture: Does the furniture fit comfortably with walking clearance? Are there rooms that feel empty or overcrowded? Is the arrangement functional?
- Light and ventilation: Do kitchens and bathrooms have windows or ventilation paths? Are living spaces well-lit?
- Flow: Does the layout make sense for daily life? Is the kitchen near the dining area? Are bedrooms away from noisy spaces?
- Overall: Does this feel like a place someone would want to live in?
```

The agent reads this data, applies reasoning, and presents 2-4 specific suggestions to the user with proposed fixes.

### Furniture-to-Room Assignment

Furniture items have a `position` but no `room_id`. To report furniture per room, the tool uses point-in-polygon testing against room polygons. The `geometry.ts` module already has `shoelaceArea()` — a `pointInPolygon(point, polygon)` function is added alongside it. Furniture items that fall outside all room polygons are reported separately as "unassigned."

### CTA Integration

After the analysis, `pickCTA("suggest_improvements", sessionState)` is called. If a CTA is returned, it's appended to the output as a contextual nudge.

---

## 7. Files Changed / Created

### New Files

| File | Purpose |
|------|---------|
| `src/sketch/furniture-catalog.ts` | Furniture item catalog with standard dimensions |
| `src/sketch/cta-config.ts` | CTA message templates, trigger config, A/B settings |
| `src/sketch/defaults.ts` | `applyDefaults()` function + DEFAULTS config |
| `src/sketch/templates/studio.json` | Studio apartment template |
| `src/sketch/templates/1br-apartment.json` | 1-bedroom apartment template |
| `src/sketch/templates/2br-apartment.json` | 2-bedroom apartment template |
| `src/sketch/templates/3br-house.json` | 3-bedroom house template |
| `src/sketch/templates/open-plan-loft.json` | Open plan loft template |
| `src/sketch/templates/l-shaped-home.json` | L-shaped home template |

### Modified Files

| File | Changes |
|------|---------|
| `src/sketch/types.ts` | Add input schemas (FloorPlanInputSchema etc.), add furniture change types to ChangeSchema |
| `src/sketch/tools.ts` | Enriched descriptions, default-filling, CTA integration, new suggest_improvements output |
| `src/sketch/svg.ts` | Furniture rendering (labeled rectangles), updated z-order |
| `src/sketch/changes.ts` | Handle add_furniture, move_furniture, remove_furniture changes |
| `src/sketch/geometry.ts` | Add pointInPolygon() for furniture-to-room assignment |
| `src/index.ts` | Register list_templates and get_template tools, optional template param on generate_floor_plan |
| `docs/arch/main/ARCH.md` | New sections: Template Catalog, Furniture Catalog (V1), CTA System, Smart Defaults |

### Unchanged

All existing tool behavior. An agent that sends raw FloorPlan JSON with every field specified works exactly as before. Templates are optional guidance, not required input.

---

## 8. Extension Points (Future Phases)

Documented here and in ARCH.md so future work has a clear path:

### Furniture V2
- Top-down SVG icons replace labeled rectangles
- Link to RoomSketcher product catalog via `catalogId`
- Material/color variants per item
- Drag-and-drop placement in browser sketcher

### 3D Rendering
- Three.js or equivalent in the browser sketcher
- Furniture items rendered as 3D models
- Walk-through mode

### Template Growth
- Community-submitted templates
- Region-specific templates (US vs. European layouts)
- Seasonal/themed templates
- Templates with material finishes

### CTA Evolution
- External A/B test service integration
- Per-user variant assignment
- Conversion tracking pipeline
- Dynamic CTA copy from a CMS

### Collaborative Loop
- State sync fix (ARCH.md known issue) enables reliable coach mode
- After user edits, agent proactively runs suggest_improvements
- Agent watches for version changes in D1, reloads state

---

## 9. Success Criteria

1. An agent given "draw me a 2-bedroom apartment" produces a fully furnished, well-proportioned plan with proper doors, windows, and colors on the first tool call
2. The JSON the agent must construct is ~40% smaller than today due to smart defaults
3. Upgrade CTAs appear at natural moments, not on every interaction, and are configurable without code changes to tool logic
4. `suggest_improvements` returns data the agent can reason about, not canned suggestions
5. All existing tool behavior is preserved — no breaking changes
