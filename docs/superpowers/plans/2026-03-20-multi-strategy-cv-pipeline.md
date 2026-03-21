# Multi-Strategy CV Pipeline — Implementation Plan

**Spec**: `docs/superpowers/specs/2026-03-20-multi-strategy-cv-pipeline-design.md`
**Phases**: 3 (each deployed and tested before starting the next)

---

## Phase 1: Wall-Level Multi-Strategy Merging

### Task 1: Create merge module with wall merging logic

**File**: `cv-service/cv/merge.py` (NEW)

**Step 1** — Write tests first (`cv-service/tests/test_merge.py`):

```python
import numpy as np
import pytest
from cv.merge import merge_wall_masks, score_room_confidence, assemble_rooms


@pytest.fixture
def two_room_mask():
    """400x600 binary mask: outer walls + interior wall = 2 rooms."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, :] = 255; mask[390:400, :] = 255  # top/bottom
    mask[:, 0:10] = 255; mask[:, 590:600] = 255  # left/right
    mask[:, 295:305] = 255  # interior wall
    return mask


@pytest.fixture
def partial_mask_left():
    """Only has the left room's walls."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, :300] = 255; mask[390:400, :300] = 255
    mask[:, 0:10] = 255; mask[:, 290:300] = 255
    return mask


@pytest.fixture
def partial_mask_right():
    """Only has the right room's walls."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, 300:] = 255; mask[390:400, 300:] = 255
    mask[:, 300:310] = 255; mask[:, 590:600] = 255
    return mask


class TestMergeWallMasks:
    def test_or_combines_all_walls(self, partial_mask_left, partial_mask_right):
        """ORing two partial masks should produce a mask with both rooms' walls."""
        strategy_results = [
            {"mask": partial_mask_left, "rooms_detected": 1},
            {"mask": partial_mask_right, "rooms_detected": 1},
        ]
        merged = merge_wall_masks(strategy_results)
        # Merged should have walls from both sides
        assert merged[:, 0:10].sum() > 0    # left wall
        assert merged[:, 590:600].sum() > 0  # right wall
        assert merged[:, 295:310].sum() > 0  # interior wall area

    def test_excludes_zero_room_strategies(self, two_room_mask):
        """Strategies that detected 0 rooms should be excluded from merge."""
        noise = np.random.randint(0, 256, (400, 600), dtype=np.uint8)
        strategy_results = [
            {"mask": two_room_mask, "rooms_detected": 2},
            {"mask": noise, "rooms_detected": 0},
        ]
        merged = merge_wall_masks(strategy_results)
        # Should be similar to just the two_room_mask (noise excluded)
        assert merged.shape == two_room_mask.shape

    def test_merged_mask_is_cleaned(self, two_room_mask):
        """Merged mask should have small noise blobs removed."""
        noisy = two_room_mask.copy()
        noisy[200, 200] = 255  # single pixel noise
        strategy_results = [
            {"mask": noisy, "rooms_detected": 2},
        ]
        merged = merge_wall_masks(strategy_results)
        # Single pixel should be cleaned
        # (filter_components removes tiny blobs)


class TestScoreRoomConfidence:
    def test_high_agreement(self):
        """Room found by 5+ strategies -> 0.9."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [room_polygon], [room_polygon],
            [room_polygon], [room_polygon],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] >= 0.9

    def test_single_strategy(self):
        """Room found by only 1 strategy -> 0.3."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [], [], [], [],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] <= 0.3


class TestAssembleRooms:
    def test_converts_to_rectangles(self):
        """Polygons should be converted to rectangular bounding boxes."""
        rooms = [{"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]}]
        assembled = assemble_rooms(rooms, confidence_scores=[0.7], scale_cm_per_px=1.0)
        assert "width" in assembled[0]
        assert "depth" in assembled[0]
        assert assembled[0]["confidence"] == 0.7
```

**Step 2** — Implement `cv-service/cv/merge.py`:

```python
"""Wall-level multi-strategy merging for CV pipeline."""
import cv2
import numpy as np
from cv.preprocess import filter_components


def merge_wall_masks(strategy_results: list[dict]) -> np.ndarray:
    """OR binary wall masks from strategies that detected >= 1 room.

    Args:
        strategy_results: list of {"mask": np.ndarray, "rooms_detected": int, "strategy": str}

    Returns:
        Cleaned merged binary mask.
    """
    # Filter to strategies that found at least 1 room
    contributing = [s for s in strategy_results if s["rooms_detected"] > 0]
    if not contributing:
        # Fallback: use all masks if none found rooms
        contributing = strategy_results

    # OR all contributing masks
    merged = contributing[0]["mask"].copy()
    for s in contributing[1:]:
        merged = cv2.bitwise_or(merged, s["mask"])

    # Clean: close small gaps, remove noise
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    merged = cv2.morphologyEx(merged, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = merged.shape
    merged = filter_components(merged, h * w)

    return merged


def score_room_confidence(
    merged_rooms: list[dict],
    individual_results: list[list],
    image_shape: tuple[int, int],
) -> list[float]:
    """Score each merged room's confidence by cross-strategy agreement.

    For each merged room, count how many individual strategy results
    detected a room overlapping the same area.

    Returns list of confidence scores (0.3-0.9), one per merged room.
    """
    scores = []
    h, w = image_shape
    diagonal = np.sqrt(h**2 + w**2)
    proximity_threshold = diagonal * 0.15  # 15% of image diagonal

    for room in merged_rooms:
        centroid = _polygon_centroid(room["polygon"])
        agreement = 0
        for strategy_rooms in individual_results:
            for sr in strategy_rooms:
                sr_centroid = _polygon_centroid(sr)
                dist = np.sqrt((centroid[0] - sr_centroid[0])**2 +
                               (centroid[1] - sr_centroid[1])**2)
                if dist < proximity_threshold:
                    agreement += 1
                    break  # count each strategy at most once

        if agreement >= 5:
            scores.append(0.9)
        elif agreement >= 3:
            scores.append(0.7)
        elif agreement >= 2:
            scores.append(0.5)
        else:
            scores.append(0.3)

    return scores


def assemble_rooms(
    rooms: list[dict],
    confidence_scores: list[float],
    scale_cm_per_px: float,
    found_by: list[list[str]] | None = None,
) -> list[dict]:
    """Convert raw room polygons to clean rectangular room specs.

    Produces structured output suitable for AI model consumption:
    snapped positions, simplified dimensions, confidence, sources.
    """
    assembled = []
    for i, room in enumerate(rooms):
        poly = np.array(room["polygon"])
        x_min, y_min = poly.min(axis=0)
        x_max, y_max = poly.max(axis=0)

        # Snap to 10px grid
        x = int(round(x_min / 10) * 10)
        y = int(round(y_min / 10) * 10)
        width_px = int(round((x_max - x_min) / 10) * 10)
        depth_px = int(round((y_max - y_min) / 10) * 10)

        assembled.append({
            "label": room.get("label", f"Room {i+1}"),
            "x": x,
            "y": y,
            "width": round(width_px * scale_cm_per_px),
            "depth": round(depth_px * scale_cm_per_px),
            "polygon": room["polygon"],
            "confidence": confidence_scores[i],
            "found_by": found_by[i] if found_by else [],
        })

    return assembled


def _polygon_centroid(polygon):
    """Compute centroid of a polygon (list of (x,y) tuples or similar)."""
    pts = np.array(polygon)
    return pts.mean(axis=0)
```

**Step 3** — Run tests: `cd cv-service && .venv/bin/python -m pytest tests/test_merge.py -v`

### Task 2: Refactor pipeline to use wall-level merging

**File**: `cv-service/cv/pipeline.py`

**Step 1** — Read the current `analyze_image()`, `_run_pipeline()`, and `pick_winner()` functions fully to understand the exact interface.

**Step 2** — Add a new function `_get_strategy_mask(image, strategy_name, strategy_fn)`:
- Runs the strategy function to get `StrategyResult(image, is_binary)`
- If `is_binary=False`, runs `prepare()` on the result to get a binary mask
- Returns the binary wall mask
- This replaces the per-strategy full pipeline run — we only need the mask

**Step 3** — Add `_quick_room_count(binary_mask)`:
- Runs `detect_rooms()` on a binary mask
- Returns just the count (for ranking strategies)
- Lightweight — no walls, openings, OCR

**Step 4** — Rewrite `analyze_image()`:
```python
def analyze_image(image, plan_name="Extracted Floor Plan"):
    # Step 1: Run all strategies in parallel to get binary masks
    strategy_masks = _run_all_strategy_masks(image)  # ThreadPoolExecutor

    # Step 2: Quick room count per strategy (parallel)
    for s in strategy_masks:
        s["rooms_detected"] = _quick_room_count(s["mask"])

    # Step 3: Merge wall masks
    merged_mask = merge_wall_masks(strategy_masks)

    # Step 4: Run full pipeline once on merged mask
    result = _run_pipeline(image, plan_name, binary_override=merged_mask)

    # Step 5: Score confidence per room
    individual_rooms = [_quick_room_detection(s["mask"]) for s in strategy_masks if s["rooms_detected"] > 0]
    confidence_scores = score_room_confidence(result["rooms"], individual_rooms, image.shape[:2])

    # Step 6: Assemble clean rooms
    result["rooms"] = assemble_rooms(result["rooms"], confidence_scores, result["meta"]["scale_cm_per_px"], ...)

    # Step 7: Add merge metadata
    result["meta"]["strategies_run"] = len(strategy_masks)
    result["meta"]["strategies_contributing"] = len([s for s in strategy_masks if s["rooms_detected"] > 0])
    result["meta"]["merge_stats"] = _compute_merge_stats(confidence_scores)

    return result
```

**Step 5** — Refactor `_run_pipeline()` to accept an optional `binary_override` parameter. When provided, skip `prepare()` and use the override mask directly.

**Step 6** — Keep `pick_winner()` and the old raw+enhanced logic available (don't delete) but make `analyze_image()` use the new merge path by default.

**Step 7** — Update existing pipeline tests. Run all tests: `cd cv-service && .venv/bin/python -m pytest -v`

### Task 3: Deploy Phase 1 and smoke test

**Step 1** — Commit all Phase 1 changes.

**Step 2** — Deploy CV service: `cd cv-service && bash deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner`

**Step 3** — Smoke test against all 3 images. Use the `/analyze` endpoint (not `/sweep`):
```bash
curl -s -X POST https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/cv/sweep \
  -H 'Content-Type: application/json' \
  -d '{"image_url": "IMAGE_URL", "name": "Test"}' \
  | python3 -c "import sys,json; ..."
```

Ask the user for image URLs before running smoke tests. Known working URLs:
- Plan 1 (547 W 47th): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785`
- Plan 2 (520 W 23rd, critical): `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`
- Plan 3: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`

**Step 4** — Report results: compare merged room count vs best single strategy per image. Success = merged >= best single strategy on all 3 images.

**Step 5** — If results are good, proceed to Phase 2. If not, debug and iterate.

---

## Phase 2: Smart Strategy Selection

### Task 4: Static elimination of useless strategies

**Step 1** — In `cv-service/cv/merge.py`, add a constant `EXCLUDED_STRATEGIES` listing strategies that produced 0 rooms across all test images:
```python
EXCLUDED_STRATEGIES = {"lab_a_channel", "lab_b_channel", "saturation", "top_hat_otsu", "black_hat"}
```

**Step 2** — In the merge flow, skip excluded strategies before running them. This saves ~5 strategy runs.

**Step 3** — Run tests, verify room counts don't change on test images.

**Step 4** — Commit, deploy, smoke test. Compare to Phase 1 results — room counts should be identical.

---

## Phase 3: AI Pipeline Connection

### Task 5: Debug and fix Workers AI payload format

**Step 1** — Read `src/ai/specialists.ts` fully. Understand exactly how image bytes are sent to Workers AI.

**Step 2** — Read Workers AI documentation for `@cf/meta/llama-3.2-11b-vision-instruct`. Check the correct input format (base64, data URI, raw bytes, array format).

**Step 3** — Add logging to specialist calls to capture the actual error response from Workers AI (not just timeout).

**Step 4** — Fix the payload format. Test with a single specialist (room_namer) first.

**Step 5** — Once room_namer works, enable all 4 specialists. Run tests: `npx vitest run`

**Step 6** — Deploy Worker: `bash deploy.sh`

### Task 6: Add tierRooms() and hint bank reconciliation

**Step 1** — Write tests first in `src/ai/__tests__/orchestrator.test.ts`:
- `tierRooms()` splits rooms by confidence correctly
- High+medium rooms passed to AI, low held back
- `reconcileHintBank()` promotes corroborated low-confidence rooms

**Step 2** — Add `tierRooms()` to `src/ai/orchestrator.ts`:
```typescript
function tierRooms(cvResult: CVResult): {
  forAI: CVRoom[];      // high (0.7+) + medium (0.5-0.7)
  hintBank: CVRoom[];   // low (0.3-0.5)
} {
  const forAI = cvResult.rooms.filter(r => (r.confidence ?? 1) >= 0.5);
  const hintBank = cvResult.rooms.filter(r => (r.confidence ?? 1) < 0.5);
  return { forAI, hintBank };
}
```

**Step 3** — Add `reconcileHintBank()`:
```typescript
function reconcileHintBank(
  mergedRooms: MergedRoom[],
  hintBank: CVRoom[],
  imageSize: [number, number],
): MergedRoom[] {
  // For each AI-detected room, check if it overlaps a hint bank room
  // If so, promote the hint bank room with confidence 0.6
  // Return mergedRooms + promoted rooms
}
```

**Step 4** — Wire into orchestrator's `runPipeline()`:
- After CV result received: `const { forAI, hintBank } = tierRooms(cvResult)`
- Pass `forAI` rooms to specialists (modify the CVResult passed to gather stage)
- After merge stage: `reconcileHintBank(mergedResult, hintBank, imageSize)`

**Step 5** — Update `src/ai/types.ts`: add `confidence` and `found_by` to `CVRoom` type.

**Step 6** — Run tests: `npx vitest run`

### Task 7: Deploy Phase 3 and end-to-end test

**Step 1** — Deploy both services:
- Worker: `bash deploy.sh`
- CV service: `cd cv-service && bash deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner`

**Step 2** — End-to-end smoke test: trigger full pipeline (CV merge -> tier -> AI gather -> AI merge -> validate) against test images.

**Step 3** — Report: rooms detected, labels assigned, confidence scores, which specialists succeeded.

---

## Key Commands Reference

- Python tests: `cd cv-service && .venv/bin/python -m pytest -v`
- Worker tests: `cd /Users/guy/CODE/roomsketcher-help-mcp && npx vitest run`
- Deploy Worker: `bash deploy.sh`
- Deploy CV service: `cd cv-service && bash deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner`
- Git commits: `git -c commit.gpgsign=false commit`
- Always ask user for image URLs before smoke testing — don't guess from memory
