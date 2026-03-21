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
[CV Service — Phase 1]
  Run all 26 strategies in parallel (ThreadPoolExecutor)
  Each strategy -> _run_pipeline() -> rooms, walls, openings
  merge_strategies() -> single CVResult with confidence scores
    |
    v
[Worker Orchestrator — existing + Phase 3 fix]
  tierRooms(cvResult) -> split into high/medium/low confidence
  AI specialists see high+medium rooms only
  Low-confidence rooms held as "hint bank"
    |
    v
[AI Gather — existing, parallel]
  Room Namer, Layout Describer, Symbol Spotter, Dimension Reader
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

## Phase 1: Multi-Strategy CV Merging

### What changes

Replace `pick_winner()` in `cv-service/cv/pipeline.py` with `merge_strategies()`.

### Current behavior

`analyze_image()` runs two pipelines in parallel (raw + enhanced), picks the one with more rooms via `pick_winner()`. Returns a single `CVResult`.

### New behavior

`analyze_image()` runs all 26 strategies through the full pipeline (not just preprocessing — each gets wall detection, room detection, opening detection, the works). Then `merge_strategies()` unions the room detections across all strategies into a single, richer `CVResult`.

### merge_strategies() algorithm

**Input**: List of per-strategy pipeline results (each has rooms, walls, openings, meta).

**Step 1 — Rank strategies by rooms_detected descending.**

**Step 2 — Select anchor strategy.** The strategy with the highest `rooms_detected` becomes the anchor. Its room polygons are the base output. If tied, prefer `canny_dilate` (most consistent performer across test images).

**Step 3 — Match rooms across strategies.** For each non-anchor strategy's rooms:
- Compute centroid of each room polygon
- Match to anchor rooms by centroid proximity (within 20% of image diagonal) AND IoU overlap > 0.3
- Matched rooms: increment agreement count on the anchor room
- Unmatched rooms: candidate for addition

**Step 4 — Add unique rooms.** Rooms found by non-anchor strategies that don't match any anchor room:
- Add to output with lower base confidence
- Tag with which strategy found them

**Step 5 — Score confidence.**
- Room found by 5+ strategies -> 0.9
- Room found by 3-4 strategies -> 0.7
- Room found by 2 strategies -> 0.5
- Room found by 1 strategy only -> 0.3

**Step 6 — Select polygons.** Use the anchor strategy's polygon for matched rooms. For unique (non-anchor) rooms, use the originating strategy's polygon.

**Step 7 — Merge openings.** Union openings across all strategies, dedupe by proximity.

**Step 8 — Build CVResult.** Same shape as today, but with added fields:
- `rooms[].confidence` (float 0.3-1.0)
- `rooms[].found_by` (list of strategy names)
- `meta.strategies_run` (count)
- `meta.anchor_strategy` (string)
- `meta.merge_stats` (rooms per confidence tier)

### Key design decisions

- **Run all 26 strategies through full pipeline, not just preprocessing.** The sweep endpoint currently only runs preprocessing + room detection. The merge needs full pipeline output (rooms with polygons, walls, openings). This means calling `_run_pipeline()` per strategy, not just the strategy function.
- **OCR runs once on the original color image.** All strategies share the same OCR output. Label-to-room assignment differs because room polygons differ, but text extraction is identical. Run OCR once, assign labels per-strategy based on centroid proximity.
- **Openings merge separately.** Opening detection depends on wall structure, which varies by strategy. Union all detected openings, dedupe by proximity (within 10px).
- **The output shape is still CVResult.** The AI pipeline consumes it unchanged. Confidence and found_by are new metadata fields that flow through transparently.

### New files / changes

- `cv-service/cv/pipeline.py` — add `merge_strategies()`, modify `analyze_image()` to use it instead of `pick_winner()`
- `cv-service/cv/pipeline.py` — add `_match_rooms()` helper for centroid+IoU matching
- `cv-service/cv/pipeline.py` — refactor `_run_pipeline()` to accept a pre-processed binary image (from strategy) instead of always calling `prepare()`
- `cv-service/tests/test_merge.py` — new test file for merge logic
- `cv-service/tests/test_pipeline.py` — update existing pipeline tests

### Performance expectations

- 26 strategies x full pipeline = ~26 * 10-15s on Hetzner with ThreadPoolExecutor(max_workers=8)
- Total wall time: ~45-60s (strategies run in parallel, 8 at a time)
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
  - Two strategies with identical rooms -> rooms get high confidence
  - Two strategies with non-overlapping rooms -> both rooms appear, lower confidence
  - Anchor selection (highest room count wins, canny_dilate breaks ties)
  - IoU matching with various overlap percentages
  - Confidence scoring at each tier boundary
  - Opening deduplication

- **Integration tests** (`test_pipeline.py`):
  - `analyze_image()` returns confidence scores
  - `analyze_image()` returns found_by lists
  - Result has more rooms than any single strategy alone

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
