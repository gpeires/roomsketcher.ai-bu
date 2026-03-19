# V3 Floor Plan Template Regeneration

> **For agentic workers:** This plan is fully self-contained. You need NO prior context. Execute templates one at a time, visually verify each via screenshot, then move to the next. Use `mcp__roomsketcher-help__generate_floor_plan` to generate, then write the JSON to the template file. Deploy via `./deploy.sh` after all 6 are done.

**Goal:** Regenerate all 6 floor plan templates to professional quality, fixing all v2 visual issues.

**Background:** These templates are served by a Cloudflare Workers MCP server. v1 was unusable, v2 fixed room sizes but still has visual bugs (furniture clipping walls, overlapping items, wrong rotations, cramped kitchens). v3 applies professional design patterns from 100+ RoomSketcher gallery examples.

---

## System Conventions

### Coordinate System
- Origin (0,0) is **top-left**
- X increases **rightward**, Y increases **downward**
- All values in **centimeters**, snapped to **10cm grid**
- Canvas padding: ~100cm around the floor plan edges

### Wall Conventions
- Exterior walls: **20cm thick**, height 270cm
- Interior walls: **12cm thick**, height 270cm
- Walls defined by start/end points (centerline)
- Openings use `offset` = distance from wall start point along the wall

### Door Sizes & Swing
- Front door: **90cm** wide
- Interior doors: **80cm**
- Bathroom doors: **70cm**
- `swingDirection`: "left" or "right" — determines which side the hinge is on
- `swingAngle`: always **90** (quarter circle arc)
- **Critical:** Door swing must NOT overlap furniture. Plan furniture placement around door arcs.
- Bathroom doors should conceptually swing outward (into hallway, not into bathroom)

### Window Sizes
- Living/bedroom: **120-150cm** wide
- Bathroom: **60cm** wide
- `sillHeight`: 90cm standard, 70cm for floor-to-ceiling style
- Windows only on **exterior walls**, centered on wall segments when possible

### Room Colors (fixed palette)
```
living:   #E8F5E9  (light green)
bedroom:  #E3F2FD  (light blue)
kitchen:  #FFF3E0  (light orange)
bathroom: #E0F7FA  (light cyan)
hallway:  #F5F5F5  (light gray)
dining:   #FFF8E1  (light yellow)
office:   #F3E5F5  (light purple)
closet:   #ECEFF1  (very light gray)
```

### Room Types (valid enum values)
`living`, `bedroom`, `kitchen`, `bathroom`, `hallway`, `closet`, `laundry`, `office`, `dining`, `garage`, `balcony`, `terrace`, `storage`, `utility`, `other`

---

## Furniture Catalog (all 25 types)

Use ONLY these types. The `type` field must match exactly.

| Type | Label | Width | Depth | Room Types |
|------|-------|-------|-------|------------|
| `bed-double` | Bed | 160 | 200 | bedroom |
| `bed-single` | Bed | 90 | 200 | bedroom |
| `nightstand` | Nightstand | 50 | 40 | bedroom |
| `wardrobe` | Wardrobe | 120 | 60 | bedroom, closet |
| `dresser` | Dresser | 100 | 50 | bedroom |
| `sofa-3seat` | Sofa | 220 | 90 | living |
| `coffee-table` | Coffee Table | 120 | 60 | living |
| `tv-unit` | TV Unit | 150 | 40 | living |
| `armchair` | Armchair | 80 | 80 | living |
| `bookshelf` | Bookshelf | 80 | 30 | living, office |
| `kitchen-counter` | Counter | 240 | 60 | kitchen |
| `kitchen-sink` | Sink | 60 | 60 | kitchen |
| `fridge` | Fridge | 70 | 70 | kitchen |
| `stove` | Stove | 60 | 60 | kitchen |
| `dining-table` | Table | 160 | 90 | kitchen, dining |
| `dining-chair` | Chair | 45 | 45 | kitchen, dining |
| `toilet` | Toilet | 40 | 65 | bathroom |
| `bath-sink` | Sink | 60 | 45 | bathroom |
| `bathtub` | Bathtub | 170 | 75 | bathroom |
| `shower` | Shower | 90 | 90 | bathroom |
| `desk` | Desk | 140 | 70 | office |
| `office-chair` | Chair | 55 | 55 | office |
| `sideboard` | Sideboard | 160 | 45 | dining |
| `shoe-rack` | Shoe Rack | 80 | 30 | hallway |
| `coat-hook` | Coat Hook | 60 | 10 | hallway |

### Furniture Placement Rules
- **position** = top-left corner of the furniture bounding box
- **rotation** = degrees clockwise around the CENTER of the item: `cx = position.x + width/2`, `cy = position.y + depth/2`
- Rotation 0 = item oriented as-is (width along X, depth along Y)
- Rotation 90 = rotated 90° clockwise. The visual footprint swaps: what was width becomes depth and vice versa. But the `width` and `depth` fields stay the same — only `rotation` changes.
- **60cm minimum clearance** between furniture and between furniture and walls (walking paths)
- **80cm clearance** at foot of bed
- Furniture must NOT clip walls or extend outside room boundaries
- Bed headboard against wall opposite the door
- Sofa back against wall, faces TV unit on opposite wall
- Kitchen work triangle: sink, stove, fridge form efficient triangle
- Toilet never directly faces door — offset to the side
- Sink near bathroom door for quick handwashing
- Shower in far corner from bathroom door

### Furniture Rotation Examples
- Bed against NORTH wall (headboard at top): rotation=0, position places it with headboard near y=wall
- Bed against WEST wall (headboard at left): rotation=90
- Sofa against WEST wall (back to wall): rotation=90
- A dining chair on the SOUTH side of a table (facing north/toward table): rotation=180

---

## JSON Schema

Every template must conform to this structure:

```typescript
{
  version: 1,                    // always 1
  id: string,                    // template slug: "studio", "1br-apartment", etc.
  name: string,                  // display name
  units: "metric",               // always metric
  canvas: { width, height, gridSize: 10 },
  walls: Wall[],
  rooms: Room[],
  furniture: FurnitureItem[],
  annotations: [],               // always empty for templates
  metadata: {
    created_at: "2026-03-19T00:00:00Z",
    updated_at: "2026-03-19T00:00:00Z",
    source: "ai"
  }
}

// Wall
{
  id: string,
  start: { x, y },
  end: { x, y },
  thickness: number,     // 20 for exterior, 12 for interior
  height: number,        // 270 standard
  type: "exterior" | "interior" | "divider",
  openings: Opening[]
}

// Opening
{
  id: string,
  type: "door" | "window" | "opening",
  offset: number,        // distance from wall start along the wall
  width: number,         // cm
  properties: {
    swingDirection?: "left" | "right",
    swingAngle?: number,
    sillHeight?: number,
    windowType?: "single" | "double" | "sliding" | "bay"
  }
}

// Room
{
  id: string,
  label: string,
  type: RoomType,
  polygon: Point[],      // at least 3 points, clockwise
  wall_ids: string[],    // references to wall IDs
  color: string          // hex from palette above
}

// FurnitureItem
{
  id: string,
  type: string,          // must match catalog type exactly
  position: { x, y },   // top-left corner
  rotation: number,      // degrees clockwise
  width: number,         // cm (from catalog)
  depth: number,         // cm (from catalog)
  label: string          // display label
}
```

---

## MCP Tool Usage

To generate a floor plan, call:
```
mcp__roomsketcher-help__generate_floor_plan
```
with a `plan` parameter containing the full FloorPlan JSON object.

The tool returns a sketch ID. Use that to verify via:
```
https://roomsketcher.kworq.com/sketcher/{sketch_id}
```

### Visual Verification (MANDATORY)

After generating each template, you MUST visually verify it. Take a screenshot and check for:
1. No furniture clipping walls or overlapping other furniture
2. Door swings don't conflict with furniture
3. All rooms properly labeled and colored
4. Walking paths (60cm+) between furniture
5. Logical room adjacency
6. Balanced visual weight (no huge empty zones next to crammed zones)
7. Kitchen work triangle makes sense
8. Bathroom fixtures properly arranged (toilet not facing door)

If issues are found, fix and regenerate before moving on.

---

## Professional Design Patterns to Apply

### Entry & Circulation
- Front door on south wall (bottom of plan)
- Entry leads to hallway that branches to public (living/kitchen) and private (bedrooms) zones
- Hallways 90-120cm wide, never wider
- Entry closet or shoe rack near front door in 2BR+ plans

### Kitchen Layouts
- Studio/1BR: Single-wall or L-shaped (counter along one or two walls)
- 2BR+: L-shaped or U-shaped
- Work triangle: sink, stove, fridge
- Counter depth always 60cm
- Sink under window when possible
- Counter → sink → stove → fridge in logical sequence

### Living Room
- Sofa faces TV unit, coffee table between
- Sofa against longest wall or floating to define zone
- Armchair at 90° to sofa
- In open-plan: dining between kitchen and living as transition

### Bedrooms
- Bed headboard against wall OPPOSITE the door
- Nightstands flank bed symmetrically (master) or one nightstand (secondary)
- Wardrobe on wall perpendicular to bed, near door
- Master: queen/king (160cm bed-double)
- Secondary: double (160cm) or single (90cm bed-single)
- Kids/3rd bedroom: single bed, desk at window

### Bathrooms
- Sink near door
- Toilet offset from door (never directly facing it)
- Shower/tub in far corner from door
- Door swings outward (into hallway)
- Min clearance: 60cm in front of toilet, 70cm in front of sink

### Size Guidelines
| Type | Total Area | Canvas |
|------|-----------|--------|
| Studio | ~30m² | 800x700 |
| 1BR | ~45m² | 1000x750 |
| 2BR | ~70m² | 1200x850 |
| 3BR | ~100m² | 1500x960 |
| Loft | ~60m² | 1100x800 |
| L-Shaped | ~90m² | 1300x1100 |

---

## Template-by-Template Specifications

### 1. Studio Apartment

**File:** `src/sketch/templates/studio.json`
**ID:** `studio`
**Target:** ~30m², 2 rooms (Living Area + Bathroom)
**Canvas:** 800x700

**v2 Issues to Fix:**
- Front door swing arc is huge, overlaps TV/cabinet area
- Dining chairs right at bathroom wall edge

**v3 Design:**
- Rectangular plan, ~700x570cm interior
- 4 exterior walls + 1 interior wall (bathroom partition)
- Bathroom in one corner (~230x200cm = ~4.6m²), rest is open living
- Front door on south wall, positioned to NOT conflict with furniture
- Single-wall kitchen along south wall (east side of front door)
- Bed zone in northeast corner (bed against north wall, nightstand)
- Living zone in northwest (sofa against west wall facing east, TV unit on opposite wall, coffee table between)
- Bathroom: sink near door, toilet offset, shower in far corner
- Windows: 2 on north wall (one for bed zone, one for living zone)
- Door swing must be small enough to not hit furniture — use swingAngle 90 but position furniture away from arc

**Furniture:**
- bed-double, nightstand (bed zone)
- sofa-3seat, coffee-table, tv-unit (living zone)
- kitchen-counter, fridge, stove (kitchen along south wall)
- toilet, bath-sink, shower (bathroom)

---

### 2. 1BR Apartment

**File:** `src/sketch/templates/1br-apartment.json`
**ID:** `1br-apartment`
**Target:** ~45m², 4 rooms (Living, Bedroom, Hallway, Bathroom)
**Canvas:** 1000x750

**v2 Issues to Fix:**
- Upside-down chair labels (rotation bug)
- Kitchen crammed with overlapping stove/sink/counter
- Sofa pushed to bottom, cut off
- Wardrobe clips south wall of bedroom

**v3 Design:**
- Top half: Living (left, ~500x400) + Bedroom (right, ~400x400)
- Bottom strip: Hallway (left/center, connects to front door) + Bathroom (right, ~200x210)
- Front door on south wall (hallway area)
- Living: sofa against north wall, TV unit on south wall near hallway boundary, coffee table between. L-shaped kitchen in living room corner (counter along west wall + part of south wall). Spread kitchen appliances with space between them.
- Bedroom: bed against north wall (headboard at top), nightstands flanking. Wardrobe on east wall with 60cm clearance from south wall.
- Hallway: shoe rack near front door
- Bathroom: sink near door, toilet offset to side, shower in far corner
- Windows: 2 on north wall (living + bedroom), 1 on east wall (bedroom or bathroom)
- Interior doors: bedroom door in dividing wall, bathroom door, hallway-to-living opening or door

**Furniture:**
- sofa-3seat, coffee-table, tv-unit (living)
- kitchen-counter, kitchen-sink, fridge, stove (living kitchen area — spread out along walls, not crammed)
- bed-double, nightstand x2, wardrobe (bedroom)
- toilet, bath-sink, shower (bathroom)
- shoe-rack (hallway)

---

### 3. 2BR Apartment

**File:** `src/sketch/templates/2br-apartment.json`
**ID:** `2br-apartment`
**Target:** ~70m², 6 rooms
**Canvas:** 1200x850

**v2 Issues to Fix:**
- Bedroom 2 (16.3m²) BIGGER than Master (15.9m²) — must swap so Master is larger
- Double door front entry — use single 90cm door
- Furniture labels clipped at room edges

**v3 Design:**
- Top row: Master Bedroom (left, ~430x430 = ~18.5m²) + Living Room (center, ~330x430) + Bedroom 2 (right, ~370x430 = ~15.9m²)
- **Master MUST be larger than Bedroom 2** — this is the #1 fix
- Bottom row: Kitchen (left) + Hallway (center, front door here) + Bathroom (right)
- Front door: SINGLE 90cm door on south wall, centered in hallway
- Master: bed-double against north wall, nightstands x2, wardrobe near door
- Bedroom 2: bed-single + nightstand, desk + office-chair (kid's room style)
- Living: sofa, coffee-table, tv-unit
- Kitchen: L-shaped layout, dining table + chairs
- Bathroom: toilet, sink, bathtub (larger bathroom for 2BR)
- Hallway: shoe-rack, coat-hook

**Furniture:**
- bed-double, nightstand x2, wardrobe (master)
- bed-single, nightstand, desk, office-chair (bedroom 2)
- sofa-3seat, coffee-table, tv-unit (living)
- kitchen-counter, fridge, stove, dining-table, dining-chair x2 (kitchen)
- toilet, bath-sink, bathtub (bathroom)
- shoe-rack (hallway)

---

### 4. 3BR House

**File:** `src/sketch/templates/3br-house.json`
**ID:** `3br-house`
**Target:** ~100m², 9 rooms
**Canvas:** 1500x960

**v2 Issues to Fix:**
- Kitchen label cut off
- Fridge rotated oddly
- Bed in Bedroom 3 overlaps into hallway
- Bathroom 1 sink overlaps wall

**v3 Design:**
- Top row: 3 bedrooms across (Bed1 ~450x460, Bed2 ~450x460, Bed3 ~500x460)
- Bottom-left: Living Room (top) + Kitchen (bottom) stacked
- Bottom-center: Dining + Hallway (front door in hallway on south wall)
- Bottom-right: Bathroom 1 (smaller, shared) + Bathroom 2 (larger, near master)
- Bedroom 1 (master): bed-double, nightstands x2, wardrobe — largest bedroom
- Bedroom 2: bed-double, nightstands x2, wardrobe
- Bedroom 3: bed-single, nightstand, desk + office-chair — smallest bedroom
- All furniture must stay WITHIN room boundaries (check bed3 doesn't extend past wall into hallway)
- Kitchen: counter along west wall, stove/fridge spaced out (not crammed), sink near window. All items within kitchen bounds.
- Bathroom fixtures must not overlap walls — leave 20cm margin from wall centerline

**Furniture:**
- bed-double, nightstand x2, wardrobe (bedroom 1)
- bed-double, nightstand x2, wardrobe (bedroom 2)
- bed-single, nightstand, desk, office-chair, wardrobe (bedroom 3)
- sofa-3seat, coffee-table, tv-unit, armchair (living)
- kitchen-counter, kitchen-sink, stove, fridge (kitchen)
- dining-table, dining-chair x4 (dining)
- toilet, bath-sink, shower (bathroom 1)
- toilet, bath-sink, bathtub (bathroom 2)
- shoe-rack (hallway)

---

### 5. Open-Plan Loft

**File:** `src/sketch/templates/open-plan-loft.json`
**ID:** `open-plan-loft`
**Target:** ~60m², 2 rooms (Main Space + Bathroom)
**Canvas:** 1100x800

**v2 Issues to Fix:**
- Upside-down dining chairs on south side of table (need rotation=180 for chairs facing north)

**v3 Design (mostly keep v2, it was the best):**
- Large open L-shaped main space + small bathroom in corner
- Zones: bed (NW), living (center-west), work (NE), kitchen (SW), dining (S-center)
- Large industrial windows (200cm), higher ceiling (300cm)
- Front door on south wall
- Bathroom in SE corner (~200x250cm): toilet, sink, shower
- **Fix chairs:** South-side dining chairs need `rotation: 180` so they face the table (northward)
- North-side chairs: rotation 0 (facing south toward table)

**Furniture:**
- bed-double, nightstand x2, wardrobe (bed zone NW)
- sofa-3seat, coffee-table, tv-unit, armchair (living zone)
- desk, office-chair, bookshelf (work zone NE)
- kitchen-counter, stove, fridge, kitchen-sink (kitchen zone SW)
- dining-table, dining-chair x4 (dining zone S-center)
- toilet, bath-sink, shower (bathroom)

---

### 6. L-Shaped Home

**File:** `src/sketch/templates/l-shaped-home.json`
**ID:** `l-shaped-home`
**Target:** ~90m², 6 rooms
**Canvas:** 1300x1100

**v2 Issues to Fix (WORST template, needs most work):**
- Master bedroom cut off at bottom of viewport
- Bedroom 2 has generic "table/chair/storage" instead of proper bed/wardrobe/desk types
- Bathroom fixtures render as "fixture" — must use proper toilet/bath-sink/shower types
- Hallway has bedroom 2 furniture bleeding into it
- Living area mostly empty, sofa overlapped by door swing
- Overall: complete redesign needed

**v3 Design:**
- L-shape: upper rectangle (700x500) for bedrooms 1+2, lower rectangle extends right (1200x500) for living + kitchen/bath/bedroom3
- Upper-left: Bedroom 1 (master, ~350x500 = ~17.5m²) — bed-double, nightstands x2, wardrobe
- Upper-right: Bedroom 2 (~350x500 = ~17.5m²) — bed-double, nightstands x2, wardrobe
- Lower-left: Living Room (large, ~700x500 = ~35m²) — sofa, coffee-table, tv-unit, armchair, dining-table + chairs
- Lower-right-top: Kitchen (~250x250) — counter, stove, fridge, sink
- Lower-right-middle: Bathroom (~250x250) — toilet, bath-sink, shower (use CORRECT types!)
- Lower-right-bottom: Bedroom 3 (~500x250) — bed-single or bed-double, nightstand, wardrobe
- Front door on south wall of living room
- Hallway concept: the junction where upper and lower rectangles meet serves as circulation
- **All furniture must use correct catalog types** — no generic "fixture" or "storage"
- **All furniture must stay within its room's polygon** — no bleeding across walls
- **Door swings must not overlap sofa or other large furniture**

**Furniture:**
- bed-double, nightstand x2, wardrobe (bedroom 1)
- bed-double, nightstand x2, wardrobe (bedroom 2)
- sofa-3seat, coffee-table, tv-unit, armchair (living)
- dining-table, dining-chair x4 (living/dining area)
- kitchen-counter, kitchen-sink, stove, fridge (kitchen)
- toilet, bath-sink, shower (bathroom)
- bed-double, nightstand, wardrobe (bedroom 3)
- shoe-rack (near front door)

---

## Execution Checklist

- [ ] **Template 1: Studio** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/studio.json`
- [ ] **Template 2: 1BR** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/1br-apartment.json`
- [ ] **Template 3: 2BR** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/2br-apartment.json`
- [ ] **Template 4: 3BR** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/3br-house.json`
- [ ] **Template 5: Loft** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/open-plan-loft.json`
- [ ] **Template 6: L-Shaped** — Design, generate via MCP, screenshot verify, write JSON to `src/sketch/templates/l-shaped-home.json`
- [ ] **Deploy** — Run `./deploy.sh` (NEVER use wrangler directly)
- [ ] **Final verification** — Screenshot all 6 deployed templates

## v2 Sketch IDs (for reference/comparison)

| Template | Sketch ID |
|----------|-----------|
| Studio | k2V_3IplQRKSjHKzFhM5E |
| 1BR | xS7Fh2-xigOa_IkMHUyE4 |
| 2BR | NXrQ1LqAKbCPjEETIMoBN |
| 3BR | nXZR-xbm2UjOUO2B3HlM8 |
| Loft | FGtKAoLTPkq32KYR3vY5G |
| L-Shaped | ajQDtF8MIAcxxCmEQBHy7 |
