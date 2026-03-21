# Multi-Strategy CV Pipeline — Design Spec

**Date**: 2026-03-20
**Status**: Approved for implementation
**Goal**: Transform the CV pipeline from single-strategy winner selection to multi-strategy room merging, then feed richer CV data into the AI pipeline for enrichment and gap-filling.

## Guiding Principles

1. **Quality first, optimize later** — run all 26 strategies, no shortcuts. The CV service runs on a cheap Hetzner box; cost is negligible. Optimization (Phase 2) comes after merging is proven.
2. **CV is the backbone, AI enriches** — CV provides geometry (walls, rooms, polygons). AI provides semantics (labels, fixture identification, validation). Don't ask AI to do geometry.
3. **Build on top, don't refactor** — the existing AI pipeline (`src/ai/orchestrator.ts`, `merge.ts`, `validate.ts`, `specialists.ts`) is well-designed. It just needs better CV input and a working connection to Workers AI.
4. **Protect the small model** — Llama 3.2 11B vision is not a frontier model. Don't dump 15 noisy rooms at it. Filter CV output into confidence tiers so AI sees clean, focused input.

---

## Architecture Overview

```
Image Input
    |
    v
[CV Service — Phase 1: Wall-Level Merging]
  Run all 26 strategies in parallel (ThreadPoolExecutor)
  Each strategy -> binary wall mask
  merge_wall_masks() -> OR top strategy masks -> unified wall mask
  Clean up (filter_components, morphological close)
  Run room/wall/opening detection ONCE on merged mask
  assemble_rooms() -> clean rectangular room specs + confidence
  -> CVResult with confidence scores
    |
    v
[Worker Orchestrator — existing + Phase 3 fix]
  tierRooms(cvResult) -> split into high/medium/low confidence
  AI specialists see: original image + high/medium rooms as structured hints
  Low-confidence rooms held as "hint bank"
    |
    v
[AI Gather — existing, parallel]
  Room Namer, Layout Describer, Symbol Spotter, Dimension Reader
  Each specialist SEES the original color image (vision model)
  Each specialist RECEIVES clean room list as structured context
  (Fix: Workers AI payload format bug)
    |
    v
[AI Merge — existing]
  Enrich CV rooms with AI labels/fixtures
  Add AI-only rooms
  Promote low-confidence CV rooms if AI corroborates
  Confidence scoring from multi-source agreement
    |
    v
[AI Validate — existing]
  Feedback loop, up to 2 passes
    |
    v
PipelineOutput (rooms with labels, confidence, sources)
```

---

## Phase 1: Wall-Level Multi-Strategy Merging

### What changes

Replace `pick_winner()` in `cv-service/cv/pipeline.py` with wall-level merging. Instead of picking one strategy's rooms, we merge wall masks from multiple strategies, then run room detection once on the combined mask.

### Current behavior

`analyze_image()` runs two pipelines in parallel (raw + enhanced), picks the one with more rooms via `pick_winner()`. Returns a single `CVResult`.

### New behavior

`analyze_image()` runs all 26 strategies to produce binary wall masks, merges the best masks at the pixel level, then runs the full detection pipeline (rooms, walls, openings, OCR, scale) once on the merged result. The merge happens at the most fundamental level — walls — so combined masks can close gaps and create room enclosures that no single strategy found alone.

### Algorithm

**Step 1 — Run all strategies in parallel.**
Each strategy function returns a `StrategyResult(image, is_binary)`. For strategies with `is_binary=False`, run through `prepare()` to get a binary wall mask. Result: 26 binary wall masks.

**Step 2 — Rank strategies.**
Run quick room detection (`detect_rooms()`) on each individual mask to get `rooms_detected` count. Rank descending.

**Step 3 — Select top N masks for merging.**
Take the top strategies by rooms_detected. Skip strategies that found 0 rooms (they contribute only noise). The number of strategies to include is dynamic — all strategies that found >= 1 room participate in the merge.

**Step 4 — Merge wall masks (bitwise OR).**
OR the selected binary masks together. This unions all detected walls — strategy A's walls fill gaps in strategy B's walls.

**Step 5 — Clean the merged mask.**
- `morphologyEx(MORPH_CLOSE)` to seal small gaps created by OR noise
- `filter_components()` to remove noise blobs (same existing logic)
- This is critical — raw OR of many masks will be noisy. Cleaning produces a wall mask that's more complete than any single strategy but not cluttered with artifacts.

**Step 6 — Run full pipeline once on merged mask.**
Call `_run_pipeline()` with the merged+cleaned binary mask:
- `detect_walls()` → wall segments
- `detect_rooms()` → room polygons
- `detect_openings()` → doors/windows
- `extract_text_regions()` → OCR on original color image (not the mask)
- `_calibrate_scale()` → cm-per-pixel
- `build_floor_plan_input()` → structured room specs

**Step 7 — Score room confidence.**
For each detected room in the merged result, check which individual strategy masks contributed to it:
- For each room polygon, check overlap with each strategy's individual room detections
- Count how many strategies independently detected a room in that area
- Confidence scoring:
  - Found by 5+ strategies → 0.9
  - Found by 3-4 strategies → 0.7
  - Found by 2 strategies → 0.5
  - Found by 1 strategy only (exists only because of merged walls) → 0.3

**Step 8 — Assemble clean room output.**
`assemble_rooms()` converts the raw room polygons into clean rectangular bounding boxes with:
- Snapped positions (nearest 10px grid)
- Simplified dimensions (width x depth)
- Confidence scores
- `found_by` list (which strategies contributed)
- OCR-assigned labels (from centroid proximity to text regions)

This clean output is what flows to the AI pipeline — not noisy polygons, but structured room specs the small model can reason about.

**Step 9 — Build CVResult.**
Same shape as today, with added fields:
- `rooms[].confidence` (float 0.3-1.0)
- `rooms[].found_by` (list of strategy names)
- `meta.strategies_run` (count)
- `meta.strategies_contributing` (count of strategies that found >= 1 room)
- `meta.merge_stats` (rooms per confidence tier)

### Key design decisions

- **Merge at wall level, not room level.** Walls are the fundamental signal. ORing wall masks can create room enclosures that no single strategy found — this is the key insight. Room-level merging can only combine rooms that already exist; wall-level merging can discover new ones.
- **Only OR strategies that found >= 1 room.** Strategies that found 0 rooms (like lab_a_channel, saturation) contribute only noise to the merged mask. Excluding them keeps the merge clean.
- **Run detection pipeline once, not 26 times.** The full pipeline (walls, rooms, openings, OCR, scale) is expensive. Running it once on the merged mask is much cheaper than running it per-strategy. Individual strategies only need quick room detection for ranking/confidence.
- **OCR runs on the original color image.** Text extraction doesn't depend on the binary mask — it reads labels from the source image. Run once, assign to rooms by centroid proximity.
- **Clean assembly for AI consumption.** The AI model doesn't see raw merged wall data. It sees clean rectangular room specs derived deterministically from the merged geometry. This protects the small model from noise while giving it structured hints to validate against the original image.
- **The output shape is still CVResult.** The AI pipeline consumes it unchanged. Confidence and found_by are new metadata fields that flow through transparently.

### New files / changes

- `cv-service/cv/merge.py` — NEW: `merge_wall_masks()`, `score_room_confidence()`, `assemble_rooms()`
- `cv-service/cv/pipeline.py` — modify `analyze_image()` to use wall-level merging instead of `pick_winner()`. Refactor `_run_pipeline()` to accept a pre-processed binary mask.
- `cv-service/tests/test_merge.py` — NEW: unit tests for wall merging logic
- `cv-service/tests/test_pipeline.py` — update integration tests

### Performance expectations

- 26 strategy preprocessing runs in parallel (ThreadPoolExecutor, max_workers=8): ~15-20s
- 26 quick room detections for ranking: ~10s (parallel)
- 1 full pipeline run on merged mask: ~10-15s
- Total wall time: ~30-45s
- This is acceptable for Phase 1 (quality first). Phase 2 optimizes.

---

## Phase 2: Smart Strategy Selection

### What changes

Add a strategy ranker that eliminates useless/redundant strategies to reduce sweep time.

### When to build

After Phase 1 is deployed and tested. We need real merge data to know which strategies contribute unique rooms.

### Approach

**Static elimination** — remove strategies that never contributed across test images:
- Always useless: `lab_a_channel`, `lab_b_channel`, `saturation`, `top_hat_otsu`, `black_hat`
- These produced 0 rooms on all 3 test images

**Contribution tracking** — after merging, log which strategies contributed unique rooms (rooms not found by the anchor). Over time, build a profile of which strategies matter.

**Target**: Reduce from 26 to ~8-10 strategies. Wall time drops from ~60s to ~20s.

### Not in Phase 2 scope

- Per-image adaptive selection (analyzing image characteristics to pick strategies) — that's a future optimization
- ML-based strategy prediction — overkill for now

---

## Phase 3: AI Pipeline Connection

### What changes

1. Fix the Workers AI payload format bug so specialists actually run
2. Add `tierRooms()` adapter between CV output and AI input
3. Reconcile all tiers after AI merge

### The payload bug

AI specialists in `src/ai/specialists.ts` send images to `@cf/meta/llama-3.2-11b-vision-instruct` via Workers AI. The calls fail (timeout/error). The bug is in how the image bytes are formatted in the request payload. This needs debugging — inspect the actual Workers AI API format requirements and fix the specialist call code.

Investigation steps:
1. Check Workers AI docs for correct image input format (base64 data URI vs raw bytes vs array)
2. Add logging to specialist calls to capture exact error responses
3. Fix payload format
4. Test with a single specialist (room_namer) before enabling all 4

### tierRooms() adapter

Lives in `src/ai/orchestrator.ts`, runs before the gather stage.

**Input**: `CVResult` with confidence-scored rooms from Phase 1.

**Output**: Three tiers:
- **High confidence (0.7+)**: Sent to AI for label enrichment only. These rooms are geometrically solid.
- **Medium confidence (0.5-0.7)**: Sent to AI for validation. "Is this actually a room?"
- **Low confidence (0.3-0.5)**: NOT sent to AI. Held in a "hint bank."

The AI specialists receive `high + medium` rooms. This keeps the input to Llama 3.2 11B focused — typically 6-8 rooms instead of potentially 15+ noisy detections.

### Post-AI reconciliation

After `merge.ts` runs, reconcile with the hint bank:
- If the AI independently detected a room (via layout_describer or room_namer) whose position overlaps a low-confidence CV room in the hint bank, **promote** that room — it's corroborated by both CV and AI
- Promoted rooms get confidence 0.6 (above the low-confidence threshold)
- Remaining hint bank rooms stay excluded from final output

### Changes to existing code

- `src/ai/orchestrator.ts` — add `tierRooms()` before gather stage, add `reconcileHintBank()` after merge stage
- `src/ai/specialists.ts` — fix payload format (the actual bug fix, scope TBD after investigation)
- `src/ai/types.ts` — add `confidence` and `found_by` to `CVRoom` type to match new CV output
- `src/ai/__tests__/` — update tests for tiering and reconciliation

### What stays unchanged

- `src/ai/merge.ts` — the merge logic works as-is. It receives CVResult rooms + specialist outputs and combines them. The rooms just happen to be better now.
- `src/ai/validate.ts` — validation loop works as-is.
- `src/ai/specialists.ts` — specialist prompts stay the same. They don't need to know about confidence tiers.
- The specialist→merge→validate pipeline architecture is unchanged.

---

## Testing Strategy

### Phase 1 tests

- **Unit tests** (`test_merge.py`):
  - `merge_wall_masks()`: OR of two masks contains all walls from both
  - `merge_wall_masks()`: strategies with 0 rooms are excluded
  - `merge_wall_masks()`: merged mask is cleaned (no tiny noise blobs)
  - `score_room_confidence()`: room found by 5 strategies -> 0.9
  - `score_room_confidence()`: room found by 1 strategy -> 0.3
  - `assemble_rooms()`: polygons converted to clean rectangles
  - `assemble_rooms()`: positions snapped to grid

- **Integration tests** (`test_pipeline.py`):
  - `analyze_image()` returns rooms with confidence scores
  - `analyze_image()` returns rooms with found_by lists
  - Merged result detects >= as many rooms as any single strategy (on synthetic test image)

- **Key validation** (manual, on real images):
  - Merged wall mask visually contains more complete walls than any individual mask
  - Rooms detected from merged mask >= rooms from best single strategy

- **Smoke tests** (3 test images, deployed):
  - Plan 1 (547 W 47th): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785`
  - Plan 2 (520 W 23rd, critical): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`
  - Plan 3: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`
  - Success criteria: merged result detects MORE rooms than any single strategy
  - Report: per-image room count (single best strategy vs merged), confidence distribution

### Phase 2 tests

- Static elimination removes the 5 known-useless strategies
- Merge quality doesn't degrade after elimination (same room count on test images)

### Phase 3 tests

- Specialist calls succeed (no timeout/error)
- tierRooms splits correctly at confidence boundaries
- Hint bank promotion works when AI corroborates low-confidence CV room
- End-to-end: full pipeline (CV merge -> tier -> AI gather -> AI merge -> validate) produces labeled rooms with higher confidence than CV-only

---

## Deploy

- CV service: `cd cv-service && bash deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner`
- Worker: `bash deploy.sh`
- Python tests: `cd cv-service && .venv/bin/python -m pytest -v`
- Worker tests: `cd /Users/guy/CODE/roomsketcher-help-mcp && npx vitest run`
- Git commits: `git -c commit.gpgsign=false commit`

---

## What this does NOT include

- Per-image adaptive strategy selection (future)
- ML-based strategy prediction (future)
- New AI specialist models (using existing Llama 3.2 11B)
- Changes to the sketch generation pipeline downstream
- UI/UX changes
