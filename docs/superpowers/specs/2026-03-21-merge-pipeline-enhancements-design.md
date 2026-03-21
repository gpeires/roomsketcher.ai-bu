# Merge Pipeline Enhancements: BBox Filtering, Distance Wall Fill, Column Detection

**Date:** 2026-03-21
**Status:** Draft
**Scope:** cv-service/cv/merge.py, cv-service/cv/strategies.py, cv-service/cv/preprocess.py, cv-service/cv/pipeline.py

## Problem

The multi-strategy merge pipeline produces false rooms from non-floor-plan regions (logos, dimension text, headers like "WEST RESIDENCE CLUB"). These survive through clustering because nothing filters by spatial location. Additionally, thick-walled plans still have room detection gaps that a distance-transform strategy could fill, and column structures in luxury condo plans go undetected.

## Goals

1. **Eliminate false rooms** from logo/text/header regions via floor plan bounding box filtering
2. **Add distance-transform wall fill** strategy to complement `thick_wall_open` for thick-walled plans
3. **Detect structural columns** as diagnostic metadata for future perimeter anchoring
4. **Make the merge pipeline composable** — each enhancement is an independent, optional step in a registry

## Non-Goals

- Column detection does not alter room detection (metadata only)
- No changes to individual strategy implementations (except adding one new strategy)
- No changes to the output JSON schema
- AI consult layers (see Future Extensions)

---

## Design

### Merge Step Registry

The merge module becomes a pipeline of named, composable steps. Each step is a function that transforms rooms and reports diagnostics. Steps can be enabled/disabled via an exclusion set.

#### Data Structures

```python
@dataclass
class MergeContext:
    """Shared state bag passed through merge steps."""
    image_shape: tuple[int, int]          # (height, width)
    strategy_bboxes: list[tuple[int,int,int,int]]  # per-strategy bboxes as (x0, y0, x1, y1)
    consensus_bbox: tuple[int,int,int,int] | None = None  # computed by bbox_filter_pre
    anchor_strategy: str | None = None     # set by pipeline after clustering
    strategy_masks: list[dict] | None = None  # [{"strategy": str, "mask": ndarray}]
    columns: list[dict] | None = None      # populated by column_detect step

class MergeStepResult(NamedTuple):
    rooms: list[dict]       # rooms after this step
    removed: list[dict]     # rooms filtered out (with "removal_reason" field)
    meta: dict              # step-specific diagnostics (timing, counts, etc.)
```

`MergeContext` is a dataclass. Steps read from it and may write to it (e.g., `column_detect` populates `context.columns`).

**Bbox format:** `find_floor_plan_bbox()` returns `(x, y, w, h)`. The pipeline converts to `(x0, y0, x1, y1)` before storing in `strategy_bboxes` so that median computation operates on corner coordinates, not dimensions. Meta output converts back to `(x, y, w, h)` for consistency with the rest of the API.

#### Step Interface — Two Phases

The merge pipeline has two distinct phases with different input shapes:

```python
# Pre-cluster steps operate on per-strategy room lists
PreClusterStep = Callable[
    [list[dict], MergeContext],  # strategy_room_lists, context
    MergeStepResult              # Each dict: {"strategy": str, "rooms": list[dict]}
]

# Post-cluster steps operate on flat room lists
PostClusterStep = Callable[
    [list[dict], MergeContext],  # flat_rooms, context
    MergeStepResult
]

# The cluster step is the boundary — takes pre-cluster shape, returns post-cluster shape
ClusterStep = Callable[
    [list[dict], MergeContext],  # strategy_room_lists in, flat rooms out
    MergeStepResult
]
```

Pre-cluster steps (like `bbox_filter_pre`) receive `[{"strategy": str, "rooms": list[dict]}, ...]` — one entry per strategy. The `cluster` step consumes this shape and produces a flat `list[dict]`. Post-cluster steps receive the flat list.

#### Registry

```python
PRE_CLUSTER_STEPS: dict[str, PreClusterStep] = {
    "bbox_filter_pre":   filter_by_bbox,
}

CLUSTER_STEP: tuple[str, ClusterStep] = ("cluster", cluster_rooms_step)

POST_CLUSTER_STEPS: dict[str, PostClusterStep] = {
    "bbox_filter_post":  filter_clusters_by_bbox,
    "column_detect":     detect_columns_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "column_detect",
]

EXCLUDED_MERGE_STEPS: set[str] = set()  # Empty — all steps on during discovery/testing
```

#### Pipeline Runner

```python
def run_merge_pipeline(
    strategy_room_lists: list[dict],
    context: MergeContext,
    pipeline: list[str] | None = None,
    excluded: set[str] | None = None,
) -> tuple[list[dict], dict]:
    """Run the merge pipeline, return (rooms, merge_meta).

    The pipeline has three phases:
    1. Pre-cluster steps: filter per-strategy room lists
    2. Cluster step: collapse per-strategy rooms into flat clustered list
    3. Post-cluster steps: filter/enrich flat room list

    merge_meta includes per-step diagnostics:
    {
        "steps": [
            {"name": "bbox_filter_pre", "time_ms": 2, "rooms_in": 156, "rooms_out": 134, "removed": 22},
            {"name": "cluster", "time_ms": 45, "rooms_in": 134, "rooms_out": 8, "removed": 3, ...},
            ...
        ]
    }
    """
```

The runner iterates the pipeline list, skips excluded steps, times each step, and accumulates the `merge_meta` dict. It tracks the phase transition at the cluster step — input shape changes from per-strategy to flat.

The `cluster` step wrapper surfaces giant-room removals (rooms with `area_px > 50% image`) in `removed` with `removal_reason: "giant_room"`, which the current `cluster_rooms()` does silently.

### Step 1: bbox_filter_pre — Pre-Cluster BBox Filtering

**Input:** Per-strategy room lists (same shape as current `cluster_rooms()` input)
**Output:** Same shape, with rooms outside consensus bbox removed

**Algorithm:**
1. Compute consensus bbox from `context.strategy_bboxes` (already in `(x0, y0, x1, y1)` format):
   - Take **median** of each coordinate across all strategies (robust to outlier strategies)
   - Result: consensus bbox as `(x0, y0, x1, y1)`
   - Store in `context.consensus_bbox`
2. For each strategy's rooms, drop any room whose **centroid** falls outside the consensus bbox
3. Tag removed rooms with `removal_reason: "outside_floor_plan_bbox"`

**Where bboxes come from:** In `analyze_image()`, after computing each strategy's binary mask (step 1, already parallel), call `find_floor_plan_bbox(mask)` for each. Pass the list into `MergeContext.strategy_bboxes`. Zero additional parallelism needed — it's a fast numpy operation (~1ms per mask).

**Meta output:** `{"consensus_bbox": [x,y,w,h], "rooms_removed": 22, "strategies_with_bbox": 22}` (converted back to x,y,w,h for output consistency)

### Step 2: cluster — Room Clustering (existing logic)

Wraps the existing `cluster_rooms()` greedy clustering in the step interface. No behavioral changes to clustering itself.

**Input:** Filtered per-strategy room lists
**Output:** Flat list of clustered rooms with confidence/found_by/agreement_count

### Step 3: bbox_filter_post — Post-Cluster BBox Filtering

**Input:** Clustered rooms (flat list)
**Output:** Rooms with centroids inside consensus bbox

Safety net for rooms that survived pre-filtering (e.g., a false room that matched into a cluster with a borderline centroid). Uses same consensus bbox from context.

**Meta output:** `{"rooms_removed": 1}`

### Step 4: column_detect — Column Detection

**Input:** Clustered rooms (passed through unchanged)
**Output:** Same rooms, unchanged. Populates `context.columns`.

**Algorithm:**
1. Use anchor strategy mask from `context.strategy_masks` (identified by `context.anchor_strategy`, set by the pipeline after clustering)
2. Connected components on binary mask
3. Filter to small, square-ish components:
   - Area: 50-500px (tunable, depends on image resolution)
   - Aspect ratio: 0.7-1.3 (square)
   - Solidity > 0.8 (filled, not hollow)
4. Grid regularity check:
   - Cluster x-coordinates and y-coordinates separately (tolerance: 5px)
   - If >=3 components align on both axes with consistent spacing → grid detected
5. Store column positions in `context.columns`

**Meta output:** `{"columns_found": 12, "grid_detected": true, "grid_spacing_px": [45, 45]}`

**No room filtering.** Metadata only. Future use: perimeter anchoring, structural grid overlay.

---

### New Strategy: distance_wall_fill

Added to `cv-service/cv/strategies.py` as strategy #28.

**Algorithm:**
1. `prepare(image)` → binary wall mask
2. Invert: `inverted = cv2.bitwise_not(binary)` (background=255, walls=0)
3. `dist = cv2.distanceTransform(inverted, cv2.DIST_L2, 5)` — Euclidean distance from each background pixel to nearest wall
4. Threshold: `result = (dist < 8).astype(np.uint8) * 255` — pixels within 8px of a wall become wall
5. Return `StrategyResult(result, is_binary=True)`

**Threshold note:** The 8px value is calibrated for typical floor plan images at 1000-2000px resolution where thick walls are 10-15px wide (gap ~5-8px). At very different resolutions this may need adjustment. For now it's a constant — resolution-adaptive scaling is a future improvement if needed.

**Why this works:** Thick walls rendered as two parallel lines 10-15px apart have a gap of 5-8px between them. Distance transform fills this gap (all interior pixels are <8px from a wall edge) while room interiors (typically 50-200px from walls) stay clear.

**Complements `thick_wall_open`:** Open removes thin furniture noise. Distance fill bridges thick wall pairs. Different failure modes — open regresses on thin walls, distance fill regresses on plans with narrow corridors. Multi-strategy merge compensates.

---

### Pipeline Integration

Changes to `analyze_image()` in `pipeline.py`:

```python
# After step 1 (parallel strategy masks already computed):
strategy_bboxes = [find_floor_plan_bbox(s["mask"]) for s in strategy_masks]

# Replace step 3 (cluster_rooms call) with:
context = MergeContext(
    image_shape=(h, w),
    strategy_bboxes=strategy_bboxes,
    strategy_masks=strategy_masks,
)
clustered, merge_meta = run_merge_pipeline(strategy_room_data, context)

# merge_meta flows into result["meta"]["merge_steps"]
```

The rest of `analyze_image()` stays the same — anchor selection, `_run_pipeline()` call, confidence attachment.

---

## Testing

### Unit Tests (merge steps)

- `test_bbox_filter_removes_outside_rooms` — rooms outside bbox get filtered
- `test_bbox_filter_keeps_inside_rooms` — rooms inside bbox survive
- `test_consensus_bbox_uses_median` — verify median computation across bboxes
- `test_cluster_step_matches_existing` — wrapper produces same output as current `cluster_rooms()`
- `test_column_detect_finds_grid` — synthetic image with 3x3 grid of squares
- `test_column_detect_ignores_non_square` — elongated components not detected as columns
- `test_merge_pipeline_runs_all_steps` — all steps execute in order, meta captured
- `test_merge_pipeline_excludes_steps` — excluded steps are skipped
- `test_consensus_bbox_degrades_to_full_image` — when all bboxes are full-image, filtering is a no-op
- `test_consensus_bbox_robust_to_outlier` — one wildly wrong bbox among 20 correct ones doesn't shift median

### Unit Tests (strategy)

- `test_distance_wall_fill_registered` — strategy count 27→28
- `test_distance_wall_fill_fills_thick_walls` — synthetic parallel wall lines get bridged
- `test_distance_wall_fill_preserves_rooms` — room interiors stay clear

### Integration

- Run sweep on all 4 test images, verify `distance_wall_fill` produces rooms
- Run analyze on 547 W 47th, verify "WEST RESIDENCE CLUB" and dimension text rooms are gone
- Verify no regression on plan3 and new_plan room counts

---

## Future Extensions

### AI Consult Layer(s) in Merge Pipeline

The merge step registry is designed to accommodate optional AI enrichment steps. A future `ai_room_validation` post-cluster step could:

- **Re-score confidence:** Send each clustered room (cropped from original image) to an AI model for visual plausibility scoring. CV confidence is based on strategy agreement count; AI confidence is based on "does this look like a room?"
- **Reject false positives:** Logo/text regions that survive bbox filtering could be caught by an AI that recognizes non-room content.
- **Enrich labels:** Suggest room labels from visual context (furniture, fixtures) rather than relying solely on Tesseract OCR.

Pipeline position: `bbox_filter_pre → cluster → bbox_filter_post → ai_room_validation → column_detect`

This is distinct from the CF worker's downstream AI merge, which operates on the full floor plan JSON after rooms are already converted to rectangles/polygons. The CV-level AI layer operates earlier — on raw room masks and image crops — and feeds enriched confidence back into the deterministic merge before output formatting.

The registry makes this trivially addable: register the step, keep it in `EXCLUDED_MERGE_STEPS` until ready, compare merge results with/without via the per-step diagnostics. Scope as a separate spec once the deterministic pipeline is stable.

---

## File Changes

| File | Change |
|------|--------|
| `cv/merge.py` | Add `MergeContext`, `MergeStepResult`, `MERGE_STEPS`, `DEFAULT_MERGE_PIPELINE`, `EXCLUDED_MERGE_STEPS`, `run_merge_pipeline()`, `filter_by_bbox()`, `filter_clusters_by_bbox()`, `detect_columns_step()`. Existing `cluster_rooms()` and helpers unchanged, wrapped in `cluster_rooms_step()`. |
| `cv/strategies.py` | Add `_distance_wall_fill()`, register in `STRATEGIES` dict |
| `cv/pipeline.py` | Compute per-strategy bboxes, build `MergeContext`, call `run_merge_pipeline()` instead of `cluster_rooms()` directly, surface `merge_steps` in meta |
| `tests/test_merge.py` | New file — merge step unit tests |
| `tests/test_strategies.py` | Update strategy count 27→28, add to expected names |
| `tests/test_pipeline.py` | Verify merge_steps in meta output |
| `docs/arch/main/ARCH.md` | Update merge pipeline section, strategy count, column detection |
