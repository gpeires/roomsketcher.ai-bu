# Architectural Furniture Symbols Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain labeled rectangles with proper architectural top-down furniture symbols across both the SVG export and the browser sketcher.

**Architecture:** A single `furnitureSymbol(type, w, h)` function in a new module returns SVG elements for each furniture type, scaled to actual dimensions. Both `svg.ts` (backend export) and `html.ts` (browser sketcher) call this shared function. Symbols use clean line-art style: `fill: none` or `#F5F5F5`, strokes `#555`/`#888`/`#aaa`.

**Tech Stack:** Pure SVG path/shape generation in TypeScript. No external dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/sketch/furniture-symbols.ts` | Create | `furnitureSymbol(type, w, h)` — returns inner SVG elements for each of 25 furniture types |
| `src/sketch/furniture-symbols.test.ts` | Create | Tests that every catalog type produces valid SVG, no empty output, dimensions are used |
| `src/sketch/svg.ts` | Modify (lines 141-153) | Replace `renderFurniture` to use `furnitureSymbol` |
| `src/sketcher/html.ts` | Modify (lines 388-399) | Replace inline rect+text with `furnitureSymbol` call via inline JS equivalent |

**Browser sketcher strategy:** The browser sketcher is a template literal evaluated server-side. It CAN import TS modules. We generate SVG `<symbol>` definitions server-side via `furnitureDefsBlock()` and inject them into the HTML. The client-side render loop uses `<use href="#fs-{type}">` with position/size attributes.

**Stroke scaling:** Symbols use `viewBox="0 0 100 100"` (percentage-based coordinates) with `vector-effect="non-scaling-stroke"` on all stroked elements. This prevents stroke distortion when `<use>` stretches the symbol to non-square dimensions.

**Labels:** Architectural symbols are intentionally unlabeled — the shapes are self-explanatory (pillows = bed, burners = stove, bowl = toilet). The fallback rect for unknown types keeps its text label.

**Selection highlight:** SVG `outline` doesn't work on `<g>` elements. Instead, render a transparent selection rect behind the `<use>` element with `stroke="#D84200" stroke-width="2"` when selected.

---

### Task 1: Create furniture symbol function

**Files:**
- Create: `src/sketch/furniture-symbols.ts`
- Create: `src/sketch/furniture-symbols.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect } from 'vitest'
import { furnitureSymbol, SYMBOL_TYPES } from './furniture-symbols'
import { FURNITURE_CATALOG } from './furniture-catalog'

describe('furnitureSymbol', () => {
  it('returns non-empty SVG for every catalog type', () => {
    for (const item of FURNITURE_CATALOG) {
      const svg = furnitureSymbol(item.type, item.defaultWidth, item.defaultDepth)
      expect(svg, `${item.type} should produce SVG`).toBeTruthy()
      expect(svg).toContain('<')
    }
  })

  it('scales output to given dimensions', () => {
    const svg = furnitureSymbol('bed-double', 160, 200)
    // Should contain coordinates based on 160x200, not hardcoded
    expect(svg).toContain('160')
    expect(svg).toContain('200')
  })

  it('returns fallback rect for unknown types', () => {
    const svg = furnitureSymbol('unknown-thing', 100, 50)
    expect(svg).toContain('rect')
  })

  it('covers all catalog items', () => {
    const catalogTypes = FURNITURE_CATALOG.map(i => i.type)
    for (const t of catalogTypes) {
      expect(SYMBOL_TYPES).toContain(t)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sketch/furniture-symbols.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `furniture-symbols.ts` with all 25 symbols**

The function takes `(type, w, h)` and returns SVG elements (no wrapping `<g>`) using the item's actual dimensions. Each symbol uses architectural conventions:

```typescript
export const SYMBOL_TYPES: string[] = [/* all 25 types */]

export function furnitureSymbol(type: string, w: number, h: number): string {
  switch (type) {
    case 'bed-double': return bedDouble(w, h)
    case 'bed-single': return bedSingle(w, h)
    // ... all 25 types
    default: return fallbackRect(w, h)
  }
}
```

All symbol functions generate SVG at coordinates 0-100 (percentage of w/h). The `furnitureSymbol(type, w, h)` wrapper scales these to actual dimensions. All stroked elements include `vector-effect="non-scaling-stroke"`.

**Symbol specifications (all use line-art style, stroke="#555", fill="none" or "#F5F5F5"):**

**Bedroom:**
- `bed-double(w,h)`: outer rect(0,0,w,h) + headboard filled rect(0,0,w,h*0.07) fill="#ddd" + two pillow rounded-rects at y=h*0.1, each ~45% of w, rx=h*0.04
- `bed-single(w,h)`: same but one centered pillow ~73% of w
- `nightstand(w,h)`: rect(0,0,w,h) + horizontal drawer line at h*0.5 + small handle circle at center
- `wardrobe(w,h)`: rect(0,0,w,h) + vertical center line + two handle circles offset from center
- `dresser(w,h)`: rect(0,0,w,h) + 3 horizontal drawer lines at 33%/66% + handle circles on each

**Living:**
- `sofa-3seat(w,h)`: outer rect + back rect(0,0,w,h*0.22) fill="#eee" + left arm rect(0,0,w*0.07,h) fill="#eee" + right arm rect(w*0.93,0,w*0.07,h) fill="#eee" + 2 vertical cushion divider lines
- `coffee-table(w,h)`: rect with rx=3 (simple table, no internal detail needed)
- `tv-unit(w,h)`: rect(0,0,w,h) + inner rect inset 15% from sides representing the screen area
- `armchair(w,h)`: outer rect + back rect(0,0,w,h*0.22) fill="#eee" + left arm(0,0,w*0.15,h) + right arm(w*0.85,0,w*0.15,h) + rounded seat cushion inside
- `bookshelf(w,h)`: rect + 4 horizontal shelf lines evenly spaced

**Kitchen:**
- `kitchen-counter(w,h)`: rect(0,0,w,h), simple filled rect stroke only
- `kitchen-sink(w,h)`: outer rect + two rounded basin rects side by side inset 10% + faucet circle at top center
- `fridge(w,h)`: rect(0,0,w,h) + horizontal door-split line at h*0.3 + two handle circles
- `stove(w,h)`: rect(0,0,w,h) + 4 burner circles in 2x2 grid, each with concentric inner circle. Back burners at 30%/70% x, 30% y. Front at 30%/70% x, 70% y.
- `dining-table(w,h)`: rect(0,0,w,h,rx=3) — clean table surface
- `dining-chair(w,h)`: rect(0,0,w,h) seat + thick backrest rect(0,0,w,h*0.18) fill="#ddd"

**Bathroom:**
- `toilet(w,h)`: tank rect(w*0.1,0,w*0.8,h*0.28,rx=3) fill="#eee" + bowl ellipse(cx=w/2,cy=h*0.65,rx=w*0.42,ry=h*0.33) + inner bowl ellipse(cx=w/2,cy=h*0.6,rx=w*0.25,ry=h*0.2) stroke="#aaa"
- `bath-sink(w,h)`: outer rect + basin ellipse(w/2,h*0.6,w*0.35,h*0.3) + faucet circle(w/2,h*0.2,r=h*0.05)
- `bathtub(w,h)`: outer rect(0,0,w,h,rx=5) + inner oval roundedRect inset 8% with rx=w*0.15 + drain circle near one end
- `shower(w,h)`: outer rect(0,0,w,h,rx=3) + center drain circle(w/2,h/2,r=min(w,h)*0.05) + dashed spray ring circle(w/2,h/2,r=min(w,h)*0.17)

**Office:**
- `desk(w,h)`: rect(0,0,w,h) + thin horizontal keyboard-area line at h*0.7, spanning 60% of w centered
- `office-chair(w,h)`: circle(w/2,h*0.55,r=min(w,h)*0.38) for seat + small arc/rect backrest at top

**Dining:**
- `sideboard(w,h)`: rect(0,0,w,h) + 2 vertical door lines at 33%/66% + handle circles

**Hallway:**
- `shoe-rack(w,h)`: rect + 3 horizontal shelf lines
- `coat-hook(w,h)`: rect(0,0,w,h) + 3-4 small circles evenly spaced along center (hook positions)

**Fallback:**
- `fallbackRect(w,h)`: rect(0,0,w,h) fill="#F5F5F5" stroke="#BDBDBD" + centered text with type name

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sketch/furniture-symbols.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sketch/furniture-symbols.ts src/sketch/furniture-symbols.test.ts
git commit --no-gpg-sign -m "feat: add architectural furniture symbol SVG generator"
```

---

### Task 2: Wire symbols into SVG export

**Files:**
- Modify: `src/sketch/svg.ts:141-153`

- [ ] **Step 1: Replace `renderFurniture` to use `furnitureSymbol`**

Labels are intentionally dropped — the architectural shapes are self-explanatory. The fallback for unknown types still renders a text label.

```typescript
import { furnitureSymbol } from './furniture-symbols';

function renderFurniture(furniture: FloorPlan['furniture']): string {
  return furniture.map(item => {
    const cx = item.position.x + item.width / 2;
    const cy = item.position.y + item.depth / 2;
    const transform = item.rotation
      ? ` transform="rotate(${item.rotation}, ${cx}, ${cy})"`
      : '';
    const inner = furnitureSymbol(item.type, item.width, item.depth);
    return `<g${transform} data-id="${item.id}">` +
      `<g transform="translate(${item.position.x}, ${item.position.y})">${inner}</g>` +
      `</g>`;
  }).join('\n    ');
}
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing SVG tests still work)

- [ ] **Step 3: Commit**

```bash
git add src/sketch/svg.ts
git commit --no-gpg-sign -m "feat: use architectural symbols in SVG export"
```

---

### Task 3: Wire symbols into browser sketcher

**Files:**
- Modify: `src/sketch/furniture-symbols.ts` — add `furnitureDefsBlock()` export
- Modify: `src/sketcher/html.ts:388-399` — use `<use>` references
- Modify: `src/sketcher/html.ts` — inject `<defs>` block

The browser sketcher is a template literal string, so we can't import TS at runtime. Strategy: generate SVG `<symbol>` definitions server-side and inject them into the HTML. The render loop then uses `<use href="#fs-{type}">` with position/size attributes.

- [ ] **Step 1: Add `furnitureDefsBlock()` to furniture-symbols.ts**

This function generates an SVG `<defs>` block containing `<symbol>` elements for each type. Each symbol uses `viewBox="0 0 100 100"` (percentage coordinates) so it scales via `width`/`height` on the `<use>` element. All stroked elements use `vector-effect="non-scaling-stroke"` to prevent stroke distortion on non-square items.

```typescript
export function furnitureDefsBlock(): string {
  const symbols = SYMBOL_TYPES.map(type => {
    const inner = furnitureSymbol(type, 100, 100);
    return `<symbol id="fs-${type}" viewBox="0 0 100 100" preserveAspectRatio="none">${inner}</symbol>`;
  }).join('\n');
  return `<defs>${symbols}</defs>`;
}
```

- [ ] **Step 2: Inject defs into HTML template**

In `html.ts`, import `furnitureDefsBlock` and inject it into the SVG element. `html.ts` exports a function that returns a template string — it runs server-side so it CAN import TS modules.

```typescript
import { furnitureDefsBlock } from './sketch/furniture-symbols';

// In the template, the SVG element becomes:
// <svg id="canvas" xmlns="http://www.w3.org/2000/svg">${furnitureDefsBlock()}</svg>
```

- [ ] **Step 3: Replace furniture render loop in HTML**

Replace lines 388-399 in `html.ts`. Instead of drawing rects, use `<use>`. For selection, render a transparent rect with highlight stroke behind the `<use>` (SVG `outline` doesn't work on `<g>` elements):

```javascript
// Furniture
html += '<g id="furniture">';
for (const item of plan.furniture) {
  const rot = item.rotation || 0;
  const cx = item.position.x + item.width / 2;
  const cy = item.position.y + item.depth / 2;
  const transform = rot ? ' transform="rotate(' + rot + ',' + cx + ',' + cy + ')"' : '';
  const sel = (selected && selected.type === 'furniture' && selected.id === item.id);
  const symbolId = 'fs-' + item.type;
  html += '<g' + transform + ' data-id="' + item.id + '" data-type="furniture">';
  if (sel) {
    html += '<rect x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '" fill="none" stroke="#D84200" stroke-width="2"/>';
  }
  html += '<use href="#' + symbolId + '" x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '"/>';
  html += '</g>';
}
html += '</g>';
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Manual verification**

Deploy locally or test with an existing sketch to verify symbols render correctly in the browser sketcher.

- [ ] **Step 6: Commit**

```bash
git add src/sketch/furniture-symbols.ts src/sketcher/html.ts
git commit --no-gpg-sign -m "feat: use architectural symbols in browser sketcher via SVG defs"
```

---

### Task 4: Visual polish and final verification

- [ ] **Step 1: Generate a test floor plan and verify all 25 symbols render**

Use the `generate_floor_plan` MCP tool to create a plan with multiple room types, then open the sketcher URL and visually verify each symbol looks correct.

- [ ] **Step 2: Adjust any symbol proportions that look off**

Common issues: pillow sizes too large/small, burner spacing, toilet bowl proportion. Tweak the multipliers in `furniture-symbols.ts`.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 4: Remove unused `svgIcon` field from CatalogItem**

In `src/sketch/furniture-catalog.ts`, remove `svgIcon?: string` from the `CatalogItem` interface — it's been superseded by `furnitureSymbol()`.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 6: Commit final adjustments**

```bash
git add -u
git commit --no-gpg-sign -m "fix: polish furniture symbol proportions, remove unused svgIcon field"
```
