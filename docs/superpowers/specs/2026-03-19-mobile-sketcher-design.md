# Mobile Sketcher — Design Spec

## Problem

The browser sketcher SPA (`/sketcher/:id`) is unusable on mobile. The toolbar buttons don't fit, the 220px properties panel consumes ~40% of screen width, and the floor plan is cramped into a small area. There are no touch gesture handlers — only mouse events.

## Scope

**Phase 1 (this spec):** View + light edits on mobile. Users review AI-generated floor plans, tap to select elements (walls, rooms, furniture), view properties, save/download. Touch gestures for pan and pinch-to-zoom. No touch-based drawing or furniture placement.

**Phase 2 (future):** Full touch editing — draw walls, place doors/windows, drag furniture. Long-press context menus, undo.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mobile pattern | Bottom sheet | Maximizes floor plan area; familiar (Google Maps); scales to full editing later |
| Properties location | Inside bottom sheet | Single interaction surface; auto-expands on element tap |
| Breakpoint | `max-width: 768px` | Standard tablet/phone cutoff; desktop layout untouched |
| File changes | `html.ts` only | Single-file SPA — CSS media query + JS touch handlers, no new files |

## Bottom Sheet — Two States

### Collapsed (default)
- Small bar at bottom (~48px + safe area inset) with drag handle + Save and SVG buttons
- Floor plan gets maximum screen height
- This is the default state on page load

### Expanded (~40vh, or ~50% in landscape)
- Triggered by: swipe up on handle, or tapping a floor plan element
- Shows: Select tool (active by default; other tools visible but disabled for Phase 1) + properties for selected element (wall, room, or furniture) + Save/SVG
- Tool buttons displayed as a horizontal scrollable row
- Properties section mirrors desktop sidebar content reformatted for full width
- In landscape orientation, use ~50% height since landscape screens are short

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
- `.bottom-sheet` container with drag handle, tools row, properties section, action buttons
- Sheet shown via `display: block` at mobile breakpoint, hidden on desktop

### Canvas bottom padding
- When bottom sheet is collapsed, the SVG canvas needs `padding-bottom: 48px` (matching collapsed sheet height) so floor plan content is never hidden behind the sheet

### CSS approach
- All mobile styles inside a single `@media (max-width: 768px)` block
- Sheet positioning: `position: fixed; bottom: 0; left: 0; right: 0`
- Transition: `transform: translateY()` with CSS transition for smooth slide
- Two transform positions: collapsed (sheet mostly off-screen, only bar visible) and expanded (40vh visible)

### iPhone safe area handling
- Viewport meta tag updated to: `width=device-width, initial-scale=1.0, viewport-fit=cover`
- Bottom sheet gets `padding-bottom: env(safe-area-inset-bottom)` to avoid home indicator overlap
- This change is safe for non-notched devices (env() returns 0)

### Viewport zoom prevention
- Add `user-scalable=no` to viewport meta on mobile to prevent browser-level pinch-to-zoom conflicting with our custom pinch-to-zoom on the SVG canvas
- Our SVG pinch-to-zoom replaces the browser's native zoom

## Properties Rendering Architecture

`showProperties()` currently writes to `propsEl` (the `.props` sidebar). On mobile, it needs to target the bottom sheet's properties section instead.

**Approach:** Extract the HTML generation from `showProperties()` into a function `renderPropertiesHtml()` that returns an HTML string. Both the desktop `propsEl` and the mobile bottom sheet properties container call this function. On mobile, after writing properties HTML, auto-expand the sheet.

```
renderPropertiesHtml(selected, plan) → HTML string

showProperties():
  html = renderPropertiesHtml(selected, plan)
  if (isMobile()) → write to sheet properties div + expand sheet
  else → write to propsEl (existing behavior)
```

`isMobile()` checks `window.matchMedia('(max-width: 768px)').matches` — stays in sync with the CSS breakpoint.

## Touch Gesture Handling

All touch handlers are Phase 1 features (essential for viewing).

### Single-finger pan
- `touchstart` → record initial touch + current viewBox position
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

### Event binding
Touch handlers for pan/zoom must be bound **once** outside `attachInteraction()` (which re-runs on every `render()` call). Only tap-to-select delegation goes through `attachInteraction()`.

## Prerequisite Fix: viewBox Reset on Render

The current `render()` function recalculates and overwrites `viewBox` on every call (line 324). When a user pans/zooms then taps an element (triggering `render()`), their viewport resets. This is an existing desktop bug but will be very noticeable on mobile where pinch-to-zoom is primary navigation.

**Fix:** Track a `userViewBox` flag. Once the user pans or zooms, set the flag. `render()` should skip viewBox recalculation when the flag is set. Reset the flag only on initial load or when the plan changes from WebSocket (new `state_update`).

## What Does NOT Change

- Desktop layout (all changes behind media query)
- Core rendering logic (`render()` function — except viewBox fix above)
- WebSocket connection and change application
- Server-side code (no changes to any file except `html.ts`)
- Change types and `applyChangeLocal()`
- Keyboard shortcuts (not relevant on mobile)

## Implementation Estimate

- ~120 lines CSS (media query, sheet styles, transitions, safe area, mobile overrides)
- ~150 lines JS (touch handlers, sheet state, drag gesture, properties refactor, viewBox fix)
- All within `html.ts` — no new files

## Testing

- Resize browser to <768px to verify responsive layout
- Chrome DevTools: iPhone SE (375px), iPhone 14 Pro (393px), iPad (768px boundary)
- Touch gesture testing via DevTools touch emulation (pan, pinch, tap)
- Playwright screenshot at 375x667 mobile viewport (per project convention)
- Orientation: verify sheet behavior in both portrait and landscape
