# Mobile Sketcher — Design Spec

## Problem

The browser sketcher SPA (`/sketcher/:id`) is unusable on mobile. The toolbar buttons don't fit, the 220px properties panel consumes ~40% of screen width, and the floor plan is cramped into a small area. There are no touch gesture handlers — only mouse events.

## Scope

**Phase 1 (this spec):** View + light edits on mobile. Users review AI-generated floor plans, tap to select elements, view properties, save/download. No touch-based drawing or furniture placement.

**Phase 2 (future):** Full touch editing — draw walls, place doors/windows, drag furniture. Pinch-to-zoom, two-finger pan, long-press context menus, undo.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mobile pattern | Bottom sheet | Maximizes floor plan area; familiar (Google Maps); scales to full editing later |
| Properties location | Inside bottom sheet | Single interaction surface; auto-expands on element tap |
| Breakpoint | `max-width: 768px` | Standard tablet/phone cutoff; desktop layout untouched |
| File changes | `html.ts` only | Single-file SPA — CSS media query + JS touch handlers, no new files |

## Bottom Sheet States

### Collapsed (default)
- Small bar at bottom (~48px) with drag handle + Save and SVG buttons
- Floor plan gets maximum screen height
- This is the default state on page load

### Half-Expanded (~40% screen height)
- Triggered by: swipe up on handle, or tapping a floor plan element
- Shows: tool buttons (Select, Wall, Door, Window, Room) + properties for selected element + Save/SVG
- Tool buttons displayed as a horizontal scrollable row
- Properties section identical to desktop sidebar content but reformatted for width

### Interactions
- **Swipe down** on sheet → collapse to bar
- **Tap outside sheet** (on floor plan) → collapse
- **Tap element** → select it + auto-expand sheet to show properties
- Sheet drag uses touch events on the handle area

## Mobile Layout Changes

### Hidden on mobile (`display: none` at `max-width: 768px`)
- `.toolbar` row — tools move into bottom sheet
- `.props` panel — content renders inside bottom sheet
- `.footer` CTA — reclaim vertical space

### New elements (mobile only)
- `.bottom-sheet` container with drag handle, tools section, properties section, action buttons
- Sheet shown via `display: block` at mobile breakpoint, hidden on desktop

### CSS approach
- All mobile styles inside a single `@media (max-width: 768px)` block
- Sheet positioning: `position: fixed; bottom: 0; left: 0; right: 0`
- Transition: `transform: translateY()` with CSS transition for smooth slide
- Three transform values: collapsed (most of sheet off-screen), half-expanded (40vh visible), fully collapsed (only bar visible)

## Touch Gesture Handling

### Single-finger pan
- `touchstart` → record initial touch + viewBox position
- `touchmove` (single finger) → update viewBox by delta (same math as existing `mousemove` pan)
- `touchend` → stop panning
- Only when touch is on the SVG canvas, not on the bottom sheet

### Pinch-to-zoom
- Track two-finger distance on `touchstart`/`touchmove`
- Compute scale factor from distance change
- Zoom centered on midpoint of the two touches (same math as existing `wheel` zoom)

### Tap-to-select
- Detect tap (touchstart + touchend within ~10px and <300ms)
- Delegate to existing click handler logic — find element under touch point
- Auto-expand bottom sheet to show properties

### Conflict avoidance
- Single-finger on sheet handle → sheet drag (not pan)
- Single-finger on SVG → pan
- Two-finger on SVG → zoom
- Tap on element → select (not pan)
- `touch-action: none` on SVG to prevent browser scroll/zoom interference

## What Does NOT Change

- Desktop layout (all changes behind media query)
- Rendering logic (`render()` function)
- WebSocket connection and change application
- Server-side code (no changes to any file except `html.ts`)
- Change types and `applyChangeLocal()`
- Keyboard shortcuts (not relevant on mobile)

## Implementation Estimate

- ~100 lines CSS (media query, sheet styles, transitions, mobile overrides)
- ~80 lines JS (touch handlers, sheet state management, drag gesture, auto-expand)
- All within `html.ts` — no new files

## Testing

- Resize browser to <768px to verify responsive behavior
- Chrome DevTools mobile emulation for touch gestures
- Playwright screenshot comparison at mobile viewport (per project convention)
