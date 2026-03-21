# Merge Pipeline Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CV merge pipeline composable via a step registry, add bbox filtering to eliminate false rooms, add distance-transform wall fill strategy, and add column detection as diagnostic metadata.

**Architecture:** The merge module (`cv/merge.py`) gains a step registry with pre-cluster and post-cluster phases. The existing `cluster_rooms()` becomes one step. New steps (bbox filtering, column detection) slot in around it. A new strategy (`distance_wall_fill`) is added to `cv/strategies.py`. Pipeline orchestration in `cv/pipeline.py` builds a `MergeContext` and calls `run_merge_pipeline()` instead of `cluster_rooms()` directly.

**Tech Stack:** Python 3.11, OpenCV (cv2), NumPy, pytest

**Spec:** `docs/superpowers/specs/2026-03-21-merge-pipeline-enhancements-design.md`

---

### Task 1: MergeContext and MergeStepResult data structures

**Files:**
- Modify: `cv-service/cv/merge.py:1-7`
- Test: `cv-service/tests/test_merge.py` (create)

- [ ] **Step 1: Write test for MergeContext creation**

In `cv-service/tests/test_merge.py`:
```python
import cv2
import numpy as np
from cv.merge import MergeContext, MergeStepResult


class TestMergeDataStructures:
    def test_merge_context_creation(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(10, 10, 590, 390), (15, 12, 585, 388)],
        )
        assert ctx.image_shape == (400, 600)
        assert len(ctx.strategy_bboxes) == 2
        assert ctx.consensus_bbox is None
        assert ctx.anchor_strategy is None
        assert ctx.strategy_masks is None
        assert ctx.columns is None

    def test_merge_step_result_creation(self):
        rooms = [{"bbox": (10, 10, 100, 100), "centroid": (60, 60)}]
        removed = [{"bbox": (0, 0, 10, 10), "removal_reason": "test"}]
        meta = {"rooms_removed": 1}
        result = MergeStepResult(rooms=rooms, removed=removed, meta=meta)
        assert len(result.rooms) == 1
        assert len(result.removed) == 1
        assert result.meta["rooms_removed"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestMergeDataStructures -v`
Expected: ImportError — `MergeContext` and `MergeStepResult` don't exist yet.

- [ ] **Step 3: Implement MergeContext and MergeStepResult**

At the top of `cv-service/cv/merge.py`, add imports and data structures after the existing docstring and `import numpy as np`:

```python
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, NamedTuple

log = logging.getLogger(__name__)


@dataclass
class MergeContext:
    """Shared state bag passed through merge pipeline steps."""
    image_shape: tuple[int, int]                          # (height, width)
    strategy_bboxes: list[tuple[int, int, int, int]]      # per-strategy (x0, y0, x1, y1)
    consensus_bbox: tuple[int, int, int, int] | None = None
    anchor_strategy: str | None = None
    strategy_masks: list[dict] | None = None              # [{"strategy": str, "mask": ndarray}]
    columns: list[dict] | None = None


class MergeStepResult(NamedTuple):
    rooms: list[dict]       # rooms after this step
    removed: list[dict]     # rooms filtered out (with "removal_reason")
    meta: dict              # step-specific diagnostics
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestMergeDataStructures -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add MergeContext and MergeStepResult data structures"
```

---

### Task 2: Consensus bbox computation

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write tests for consensus bbox**

Append to `cv-service/tests/test_merge.py`:

```python
from cv.merge import compute_consensus_bbox


class TestConsensusBbox:
    def test_median_of_bboxes(self):
        # 3 bboxes, median should pick the middle values
        bboxes = [
            (10, 20, 500, 380),   # (x0, y0, x1, y1)
            (15, 25, 510, 385),
            (12, 22, 505, 382),
        ]
        result = compute_consensus_bbox(bboxes)
        assert result == (12, 22, 505, 382)

    def test_robust_to_outlier(self):
        # 1 wildly wrong bbox among 5 correct ones
        bboxes = [
            (10, 20, 500, 380),
            (12, 22, 502, 382),
            (11, 21, 501, 381),
            (10, 20, 500, 380),
            (0, 0, 1000, 1000),   # outlier
        ]
        result = compute_consensus_bbox(bboxes)
        # Median of x0: [0,10,10,11,12] → 10
        # Median of y0: [0,20,20,21,22] → 20
        # Median of x1: [500,500,501,502,1000] → 501
        # Median of y1: [380,380,381,382,1000] → 381
        assert result == (10, 20, 501, 381)

    def test_degrades_to_full_image(self):
        # All bboxes are full-image → consensus is full-image
        bboxes = [
            (0, 0, 600, 400),
            (0, 0, 600, 400),
            (0, 0, 600, 400),
        ]
        result = compute_consensus_bbox(bboxes)
        assert result == (0, 0, 600, 400)

    def test_single_bbox(self):
        result = compute_consensus_bbox([(10, 20, 500, 380)])
        assert result == (10, 20, 500, 380)

    def test_empty_returns_none(self):
        result = compute_consensus_bbox([])
        assert result is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestConsensusBbox -v`
Expected: ImportError — `compute_consensus_bbox` doesn't exist.

- [ ] **Step 3: Implement compute_consensus_bbox**

Add to `cv-service/cv/merge.py` after the data structures:

```python
def compute_consensus_bbox(
    bboxes: list[tuple[int, int, int, int]],
) -> tuple[int, int, int, int] | None:
    """Compute consensus floor plan bbox from per-strategy bboxes.

    Takes median of each coordinate (x0, y0, x1, y1) across all strategies.
    Median is robust to outlier strategies that produce bad bboxes.

    Args:
        bboxes: List of (x0, y0, x1, y1) tuples.

    Returns:
        Consensus bbox as (x0, y0, x1, y1), or None if empty.
    """
    if not bboxes:
        return None
    arr = np.array(bboxes)
    median = np.median(arr, axis=0).astype(int)
    return (int(median[0]), int(median[1]), int(median[2]), int(median[3]))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestConsensusBbox -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add compute_consensus_bbox with median-based computation"
```

---

### Task 3: Pre-cluster bbox filter step (filter_by_bbox)

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write tests for filter_by_bbox**

Append to `cv-service/tests/test_merge.py`:

```python
from cv.merge import filter_by_bbox


def _make_room(centroid, bbox=None, area_px=1000):
    """Helper: create a minimal room dict for testing."""
    cx, cy = centroid
    if bbox is None:
        bbox = (cx - 50, cy - 50, 100, 100)
    return {
        "bbox": bbox,
        "area_px": area_px,
        "centroid": centroid,
        "mask": np.zeros((10, 10), dtype=np.uint8),
        "polygon": [(cx - 50, cy - 50), (cx + 50, cy - 50),
                     (cx + 50, cy + 50), (cx - 50, cy + 50)],
    }


class TestFilterByBbox:
    def test_removes_rooms_outside_bbox(self):
        # Consensus bbox covers center of image
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(50, 50, 550, 350)] * 3,
        )
        strategy_rooms = [
            {
                "strategy": "raw",
                "rooms": [
                    _make_room((300, 200)),   # inside
                    _make_room((10, 10)),      # outside — top-left corner
                ],
            },
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        # Should keep 1 room, remove 1
        total_kept = sum(len(e["rooms"]) for e in result.rooms)
        assert total_kept == 1
        assert len(result.removed) == 1
        assert result.removed[0]["removal_reason"] == "outside_floor_plan_bbox"

    def test_keeps_rooms_inside_bbox(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 3,  # full image
        )
        strategy_rooms = [
            {
                "strategy": "raw",
                "rooms": [_make_room((300, 200)), _make_room((100, 100))],
            },
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        total_kept = sum(len(e["rooms"]) for e in result.rooms)
        assert total_kept == 2
        assert len(result.removed) == 0

    def test_sets_consensus_bbox_on_context(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(50, 50, 550, 350), (55, 55, 545, 345)],
        )
        strategy_rooms = [{"strategy": "raw", "rooms": []}]
        filter_by_bbox(strategy_rooms, ctx)
        assert ctx.consensus_bbox is not None

    def test_preserves_strategy_structure(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
        )
        strategy_rooms = [
            {"strategy": "raw", "rooms": [_make_room((300, 200))]},
            {"strategy": "otsu", "rooms": [_make_room((100, 100))]},
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        assert len(result.rooms) == 2
        assert result.rooms[0]["strategy"] == "raw"
        assert result.rooms[1]["strategy"] == "otsu"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestFilterByBbox -v`
Expected: ImportError — `filter_by_bbox` doesn't exist.

- [ ] **Step 3: Implement filter_by_bbox**

Add to `cv-service/cv/merge.py`:

```python
def filter_by_bbox(
    strategy_room_lists: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Pre-cluster step: remove rooms whose centroid falls outside consensus bbox.

    Computes consensus bbox from context.strategy_bboxes (median of coordinates),
    then filters each strategy's room list. Preserves the per-strategy structure.
    """
    consensus = compute_consensus_bbox(context.strategy_bboxes)
    if consensus is None:
        return MergeStepResult(rooms=strategy_room_lists, removed=[], meta={"skipped": True})
    context.consensus_bbox = consensus
    x0, y0, x1, y1 = consensus

    filtered = []
    removed = []
    rooms_in = 0
    for entry in strategy_room_lists:
        kept = []
        for room in entry["rooms"]:
            rooms_in += 1
            cx, cy = room["centroid"]
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                kept.append(room)
            else:
                room_copy = dict(room)
                room_copy["removal_reason"] = "outside_floor_plan_bbox"
                room_copy["_strategy"] = entry["strategy"]
                removed.append(room_copy)
        filtered.append({"strategy": entry["strategy"], "rooms": kept})

    meta = {
        "consensus_bbox": (x0, y0, x1 - x0, y1 - y0),  # convert to (x, y, w, h) for output
        "rooms_in": rooms_in,
        "rooms_removed": len(removed),
        "strategies_with_bbox": len(context.strategy_bboxes),
    }
    return MergeStepResult(rooms=filtered, removed=removed, meta=meta)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestFilterByBbox -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add filter_by_bbox pre-cluster merge step"
```

---

### Task 4: Cluster rooms step wrapper

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write test for cluster_rooms_step**

Append to `cv-service/tests/test_merge.py`:

```python
from cv.merge import cluster_rooms_step, cluster_rooms


class TestClusterRoomsStep:
    def test_matches_existing_cluster_rooms(self):
        """Wrapper produces same rooms as existing cluster_rooms()."""
        rooms = [
            _make_room((150, 200), area_px=5000),
            _make_room((450, 200), area_px=5000),
        ]
        strategy_rooms = [
            {"strategy": "raw", "rooms": rooms},
            {"strategy": "otsu", "rooms": rooms},
        ]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
        )

        # Run both
        old_result = cluster_rooms(strategy_rooms, (400, 600))
        step_result = cluster_rooms_step(strategy_rooms, ctx)

        assert len(step_result.rooms) == len(old_result)
        for old, new in zip(old_result, step_result.rooms):
            assert old["centroid"] == new["centroid"]
            assert old["confidence"] == new["confidence"]

    def test_surfaces_giant_room_removals(self):
        """Giant rooms (>50% image area) appear in removed list."""
        giant = _make_room((300, 200), area_px=300000)  # > 50% of 400*600=240000
        normal = _make_room((150, 200), area_px=5000)
        strategy_rooms = [
            {"strategy": "raw", "rooms": [giant, normal]},
        ]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
        )
        result = cluster_rooms_step(strategy_rooms, ctx)
        assert any(r.get("removal_reason") == "giant_room" for r in result.removed)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestClusterRoomsStep -v`
Expected: ImportError — `cluster_rooms_step` doesn't exist.

- [ ] **Step 3: Implement cluster_rooms_step**

Add to `cv-service/cv/merge.py`, after `filter_by_bbox`:

```python
def cluster_rooms_step(
    strategy_room_lists: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Cluster step: wraps existing cluster_rooms() in the merge step interface.

    Surfaces giant-room removals (>50% image area) that cluster_rooms does silently.
    """
    h, w = context.image_shape
    max_area = h * w * 0.5

    # Track giant rooms that cluster_rooms silently drops
    removed = []
    for entry in strategy_room_lists:
        for room in entry["rooms"]:
            if room.get("area_px", 0) > max_area:
                room_copy = dict(room)
                room_copy["removal_reason"] = "giant_room"
                room_copy["_strategy"] = entry["strategy"]
                removed.append(room_copy)

    rooms_in = sum(len(e["rooms"]) for e in strategy_room_lists)
    clustered = cluster_rooms(strategy_room_lists, context.image_shape)

    meta = {
        "rooms_in": rooms_in,
        "clusters_out": len(clustered),
        "giant_rooms_removed": len(removed),
    }
    return MergeStepResult(rooms=clustered, removed=removed, meta=meta)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestClusterRoomsStep -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add cluster_rooms_step wrapper with giant-room tracking"
```

---

### Task 5: Post-cluster bbox filter step

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write tests for filter_clusters_by_bbox**

Append to `cv-service/tests/test_merge.py`:

```python
from cv.merge import filter_clusters_by_bbox


class TestFilterClustersByBbox:
    def test_removes_clusters_outside_bbox(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(50, 50, 550, 350)] * 3,
        )
        ctx.consensus_bbox = (50, 50, 550, 350)
        rooms = [
            {**_make_room((300, 200)), "confidence": 0.9, "found_by": ["raw"], "agreement_count": 5},
            {**_make_room((10, 10)), "confidence": 0.3, "found_by": ["raw"], "agreement_count": 1},
        ]
        result = filter_clusters_by_bbox(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.rooms[0]["centroid"] == (300, 200)
        assert len(result.removed) == 1

    def test_noop_when_no_consensus_bbox(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[],
        )
        rooms = [
            {**_make_room((300, 200)), "confidence": 0.9, "found_by": ["raw"], "agreement_count": 5},
        ]
        result = filter_clusters_by_bbox(rooms, ctx)
        assert len(result.rooms) == 1
        assert len(result.removed) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestFilterClustersByBbox -v`
Expected: ImportError.

- [ ] **Step 3: Implement filter_clusters_by_bbox**

Add to `cv-service/cv/merge.py`:

```python
def filter_clusters_by_bbox(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Post-cluster step: remove clustered rooms outside consensus bbox.

    Safety net for rooms that survived pre-filtering but whose cluster
    representative centroid falls outside the floor plan region.
    """
    if context.consensus_bbox is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    x0, y0, x1, y1 = context.consensus_bbox
    kept = []
    removed = []
    for room in rooms:
        cx, cy = room["centroid"]
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            kept.append(room)
        else:
            room_copy = dict(room)
            room_copy["removal_reason"] = "outside_floor_plan_bbox_post"
            removed.append(room_copy)

    meta = {"rooms_in": len(rooms), "rooms_removed": len(removed)}
    return MergeStepResult(rooms=kept, removed=removed, meta=meta)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestFilterClustersByBbox -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add filter_clusters_by_bbox post-cluster merge step"
```

---

### Task 6: Column detection step

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write tests for detect_columns_step**

Append to `cv-service/tests/test_merge.py`:

```python
import cv2
from cv.merge import detect_columns_step


class TestDetectColumnsStep:
    def _make_grid_mask(self):
        """Create a 400x600 binary mask with a 3x4 grid of small filled squares."""
        mask = np.zeros((400, 600), dtype=np.uint8)
        # 3 rows x 4 cols of 10x10 filled squares at regular 100px spacing
        for row in range(3):
            for col in range(4):
                y, x = 50 + row * 100, 80 + col * 120
                mask[y:y+10, x:x+10] = 255
        # Also add some wall-like lines (should NOT be detected as columns)
        mask[0:5, :] = 255     # horizontal wall
        mask[:, 0:5] = 255     # vertical wall
        return mask

    def test_finds_grid(self):
        mask = self._make_grid_mask()
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_columns_step(rooms, ctx)
        # Rooms passed through unchanged
        assert len(result.rooms) == 1
        assert result.rooms[0]["centroid"] == (300, 200)
        # Columns detected
        assert ctx.columns is not None
        assert result.meta["columns_found"] >= 6  # at least some of the 12 squares

    def test_ignores_elongated_components(self):
        """Elongated (non-square) components should not be detected as columns."""
        mask = np.zeros((400, 600), dtype=np.uint8)
        # Long thin rectangles — wall segments, not columns
        mask[100:102, 100:200] = 255  # 2x100 — very elongated
        mask[200:220, 200:202] = 255  # 20x2 — very elongated
        rooms = []
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_columns_step(rooms, ctx)
        assert result.meta["columns_found"] == 0

    def test_noop_when_no_masks(self):
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
        )
        result = detect_columns_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.meta.get("skipped") is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestDetectColumnsStep -v`
Expected: ImportError.

- [ ] **Step 3: Implement detect_columns_step**

Add to `cv-service/cv/merge.py` (add `import cv2` at top):

```python
def detect_columns_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Post-cluster step: detect structural columns in the floor plan.

    Finds small, filled, square-ish components that may represent columns.
    Checks for grid regularity. Populates context.columns. Does NOT filter rooms.
    """
    if (context.strategy_masks is None or context.anchor_strategy is None):
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    anchor_mask = None
    for s in context.strategy_masks:
        if s["strategy"] == context.anchor_strategy:
            anchor_mask = s["mask"]
            break
    if anchor_mask is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    h, w = anchor_mask.shape
    total_px = h * w
    # Scale area thresholds relative to image size
    # At 600x400 (240k px): min=24, max=1200
    # At 2000x1500 (3M px): min=300, max=15000
    min_area = max(20, int(total_px * 0.0001))
    max_area = max(500, int(total_px * 0.005))

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        anchor_mask, connectivity=8
    )

    candidates = []
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area or area > max_area:
            continue
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        if aspect > 1.3:  # not square enough (spec: 0.7-1.3 aspect range)
            continue
        # Solidity check: actual area vs bounding box area
        bb_area = cw * ch
        solidity = area / bb_area if bb_area > 0 else 0
        if solidity < 0.8:
            continue
        cx, cy = centroids[i]
        candidates.append({
            "centroid": (int(cx), int(cy)),
            "bbox": (
                int(stats[i, cv2.CC_STAT_LEFT]),
                int(stats[i, cv2.CC_STAT_TOP]),
                int(cw), int(ch),
            ),
            "area_px": int(area),
            "solidity": round(solidity, 2),
        })

    # Grid regularity check
    grid_detected = False
    grid_spacing = None
    if len(candidates) >= 3:
        xs = sorted(c["centroid"][0] for c in candidates)
        ys = sorted(c["centroid"][1] for c in candidates)
        grid_detected, grid_spacing = _check_grid_regularity(xs, ys)

    context.columns = candidates

    meta = {
        "columns_found": len(candidates),
        "grid_detected": grid_detected,
        "grid_spacing_px": grid_spacing,
    }
    return MergeStepResult(rooms=rooms, removed=[], meta=meta)


def _check_grid_regularity(xs: list[int], ys: list[int]) -> tuple[bool, list[int] | None]:
    """Check if x and y coordinates form a regular grid pattern.

    Returns (grid_detected, spacing) where spacing is [x_spacing, y_spacing] in px.
    """
    def _find_spacing(coords: list[int], tolerance: int = 10) -> int | None:
        if len(coords) < 3:
            return None
        # Cluster nearby coordinates (within tolerance)
        clusters = []
        for c in coords:
            placed = False
            for cl in clusters:
                if abs(c - cl[-1]) <= tolerance:
                    cl.append(c)
                    placed = True
                    break
            if not placed:
                clusters.append([c])
        if len(clusters) < 3:
            return None
        # Check spacing between cluster centers
        centers = sorted(sum(cl) / len(cl) for cl in clusters)
        diffs = [centers[i+1] - centers[i] for i in range(len(centers) - 1)]
        if not diffs:
            return None
        median_diff = sorted(diffs)[len(diffs) // 2]
        if median_diff < 10:
            return None
        # Check consistency: all spacings within 30% of median
        consistent = all(abs(d - median_diff) / median_diff < 0.3 for d in diffs)
        return int(median_diff) if consistent else None

    x_spacing = _find_spacing(xs)
    y_spacing = _find_spacing(ys)
    if x_spacing is not None and y_spacing is not None:
        return True, [x_spacing, y_spacing]
    return False, None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestDetectColumnsStep -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add detect_columns_step merge step with grid detection"
```

---

### Task 7: Merge pipeline runner and registry

**Files:**
- Modify: `cv-service/cv/merge.py`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write tests for run_merge_pipeline**

Append to `cv-service/tests/test_merge.py`:

```python
from cv.merge import (
    run_merge_pipeline, DEFAULT_MERGE_PIPELINE, EXCLUDED_MERGE_STEPS,
    PRE_CLUSTER_STEPS, POST_CLUSTER_STEPS, CLUSTER_STEP,
)


class TestMergePipeline:
    def _make_strategy_data(self):
        """Create realistic strategy room data for 2 strategies with 2 rooms each."""
        rooms = [
            _make_room((150, 200), area_px=5000),
            _make_room((450, 200), area_px=5000),
        ]
        return [
            {"strategy": "raw", "rooms": rooms, "count": 2},
            {"strategy": "otsu", "rooms": rooms, "count": 2},
        ]

    def test_runs_all_steps(self):
        strategy_rooms = self._make_strategy_data()
        mask = np.zeros((400, 600), dtype=np.uint8)
        mask[0:20, :] = 255  # wall
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        rooms, meta = run_merge_pipeline(strategy_rooms, ctx)
        assert len(rooms) >= 1
        assert "steps" in meta
        step_names = [s["name"] for s in meta["steps"]]
        assert "bbox_filter_pre" in step_names
        assert "cluster" in step_names
        assert "bbox_filter_post" in step_names
        assert "column_detect" in step_names

    def test_excludes_steps(self):
        strategy_rooms = self._make_strategy_data()
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
        )
        rooms, meta = run_merge_pipeline(
            strategy_rooms, ctx,
            excluded={"bbox_filter_pre", "column_detect"},
        )
        step_names = [s["name"] for s in meta["steps"]]
        assert "bbox_filter_pre" not in step_names
        assert "column_detect" not in step_names
        assert "cluster" in step_names

    def test_step_meta_has_timing(self):
        strategy_rooms = self._make_strategy_data()
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
        )
        _, meta = run_merge_pipeline(strategy_rooms, ctx)
        for step in meta["steps"]:
            assert "time_ms" in step
            assert "name" in step

    def test_registry_populated(self):
        assert "bbox_filter_pre" in PRE_CLUSTER_STEPS
        assert CLUSTER_STEP[0] == "cluster"
        assert "bbox_filter_post" in POST_CLUSTER_STEPS
        assert "column_detect" in POST_CLUSTER_STEPS

    def test_default_pipeline_order(self):
        assert DEFAULT_MERGE_PIPELINE == [
            "bbox_filter_pre", "cluster", "bbox_filter_post", "column_detect",
        ]

    def test_excluded_merge_steps_empty(self):
        assert len(EXCLUDED_MERGE_STEPS) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestMergePipeline -v`
Expected: ImportError — `run_merge_pipeline` etc. don't exist.

- [ ] **Step 3: Implement registry and run_merge_pipeline**

Add to `cv-service/cv/merge.py`:

```python
# ── Registry ──────────────────────────────────────────────────────────

PRE_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_pre": filter_by_bbox,
}

CLUSTER_STEP: tuple[str, Callable] = ("cluster", cluster_rooms_step)

POST_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_post": filter_clusters_by_bbox,
    "column_detect": detect_columns_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "column_detect",
]

EXCLUDED_MERGE_STEPS: set[str] = set()


def run_merge_pipeline(
    strategy_room_lists: list[dict],
    context: MergeContext,
    pipeline: list[str] | None = None,
    excluded: set[str] | None = None,
) -> tuple[list[dict], dict]:
    """Run the composable merge pipeline.

    Three phases:
    1. Pre-cluster steps: filter per-strategy room lists
    2. Cluster step: collapse to flat room list
    3. Post-cluster steps: filter/enrich flat room list

    Returns (rooms, merge_meta) where merge_meta has per-step diagnostics.
    """
    steps = pipeline or DEFAULT_MERGE_PIPELINE
    skip = excluded if excluded is not None else EXCLUDED_MERGE_STEPS
    meta_steps = []

    cluster_name = CLUSTER_STEP[0]
    current_data = strategy_room_lists  # pre-cluster shape
    clustered = False

    for step_name in steps:
        if step_name in skip:
            continue

        t0 = time.monotonic()

        if step_name == cluster_name:
            fn = CLUSTER_STEP[1]
            result = fn(current_data, context)
            current_data = result.rooms  # shape changes: per-strategy → flat
            clustered = True
        elif not clustered and step_name in PRE_CLUSTER_STEPS:
            fn = PRE_CLUSTER_STEPS[step_name]
            result = fn(current_data, context)
            current_data = result.rooms
        elif clustered and step_name in POST_CLUSTER_STEPS:
            fn = POST_CLUSTER_STEPS[step_name]
            result = fn(current_data, context)
            current_data = result.rooms
        else:
            log.warning("Merge step %s not found or wrong phase, skipping", step_name)
            continue

        elapsed = int((time.monotonic() - t0) * 1000)
        step_meta = {"name": step_name, "time_ms": elapsed, **result.meta}
        meta_steps.append(step_meta)

    return current_data, {"steps": meta_steps}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_merge.py::TestMergePipeline -v`
Expected: 6 passed.

- [ ] **Step 5: Run ALL merge tests to verify nothing is broken**

Run: `cd cv-service && python -m pytest tests/test_merge.py -v`
Expected: All tests pass (data structures + consensus + filter + cluster + post-filter + columns + pipeline).

- [ ] **Step 6: Commit**

```bash
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git commit -m "feat(cv): add merge pipeline runner and step registry"
```

---

### Task 8: Distance wall fill strategy

**Files:**
- Modify: `cv-service/cv/strategies.py:422-481`
- Modify: `cv-service/tests/test_strategies.py`

- [ ] **Step 1: Write tests for distance_wall_fill**

Add to `cv-service/tests/test_strategies.py`, update the registry tests and add new tests:

In `TestStrategyRegistry.test_has_27_strategies`, change `27` → `28`.

In `TestStrategyRegistry.test_expected_names`, add `"distance_wall_fill"` to the expected set.

In `TestStrategyOutputs.test_binary_strategies_return_mask`, add `"distance_wall_fill"` to the parametrize list.

Add new test class:

```python
class TestDistanceWallFill:
    def test_fills_thick_wall_gap(self):
        """Two parallel wall lines 12px apart should be bridged."""
        img = np.ones((200, 200, 3), dtype=np.uint8) * 255
        # Two parallel horizontal walls, 12px apart
        img[88:93, 20:180] = 0   # top wall line (5px thick)
        img[102:107, 20:180] = 0  # bottom wall line (5px thick)
        # Gap between them: rows 93-101 (9px) — within 8px threshold
        result = STRATEGIES["distance_wall_fill"](img.copy())
        assert result.is_binary is True
        # Check that the gap region is now filled
        gap_region = result.image[95:100, 50:150]
        fill_ratio = np.count_nonzero(gap_region) / gap_region.size
        assert fill_ratio > 0.8, f"Gap not filled: {fill_ratio:.2f}"

    def test_preserves_room_interior(self):
        """Room interiors (far from walls) should stay empty."""
        img = np.ones((400, 600, 3), dtype=np.uint8) * 255
        # Outer walls
        img[0:10, :] = 0
        img[390:400, :] = 0
        img[:, 0:10] = 0
        img[:, 590:600] = 0
        result = STRATEGIES["distance_wall_fill"](img.copy())
        # Center of room should be empty
        center = result.image[180:220, 280:320]
        empty_ratio = 1 - (np.count_nonzero(center) / center.size)
        assert empty_ratio > 0.9, f"Room center not empty: {empty_ratio:.2f}"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_strategies.py::TestDistanceWallFill -v && python -m pytest tests/test_strategies.py::TestStrategyRegistry -v`
Expected: FAIL — `distance_wall_fill` not in registry, count is 27 not 28.

- [ ] **Step 3: Implement _distance_wall_fill and register it**

Add to `cv-service/cv/strategies.py` after `_thick_wall_open` (around line 441):

```python
def _distance_wall_fill(image: np.ndarray) -> StrategyResult:
    """Distance-transform wall fill to bridge thick wall pairs.

    Thick walls rendered as two parallel lines (10-15px apart) have a gap
    that distance transform can fill — all pixels within 8px of a wall edge
    become wall. Room interiors (50-200px from walls) stay clear.

    Complements thick_wall_open: open removes thin noise, distance fill
    bridges thick wall pairs. Different failure modes — the merge compensates.
    """
    binary = prepare(image)
    inverted = cv2.bitwise_not(binary)
    dist = cv2.distanceTransform(inverted, cv2.DIST_L2, 5)
    result = (dist < 8).astype(np.uint8) * 255  # walls (dist=0) + pixels within 8px
    h, w = result.shape
    result = filter_components(result, h * w)
    return StrategyResult(result, is_binary=True)
```

In the `STRATEGIES` dict, add after `"thick_wall_open": _thick_wall_open,`:

```python
    "distance_wall_fill": _distance_wall_fill,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_strategies.py -v`
Expected: All tests pass with 28 strategies.

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/strategies.py cv-service/tests/test_strategies.py
git commit -m "feat(cv): add distance_wall_fill strategy (#28)"
```

---

### Task 9: Wire merge pipeline into analyze_image

**Files:**
- Modify: `cv-service/cv/pipeline.py:1-134`
- Modify: `cv-service/tests/test_pipeline.py`

- [ ] **Step 1: Write test for merge_steps in meta output**

Add to `cv-service/tests/test_pipeline.py`:

```python
def test_pipeline_includes_merge_steps(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    meta = result["meta"]
    assert "merge_steps" in meta
    steps = meta["merge_steps"]["steps"]
    step_names = [s["name"] for s in steps]
    assert "bbox_filter_pre" in step_names
    assert "cluster" in step_names
    assert "bbox_filter_post" in step_names
    assert "column_detect" in step_names
    for step in steps:
        assert "time_ms" in step
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cv-service && python -m pytest tests/test_pipeline.py::test_pipeline_includes_merge_steps -v`
Expected: FAIL — `merge_steps` not in meta.

- [ ] **Step 3: Update analyze_image to use run_merge_pipeline**

Modify `cv-service/cv/pipeline.py`:

**Import change** — replace `from cv.merge import cluster_rooms` with:
```python
from cv.merge import run_merge_pipeline, MergeContext
```

**In `analyze_image()`**, replace step 3 (lines 94-95):
```python
    # Step 3: Cluster rooms across strategies
    clustered = cluster_rooms(strategy_room_data, (h, w))
```

With:
```python
    # Step 3: Compute per-strategy bboxes and run merge pipeline
    strategy_bboxes = []
    for s in strategy_masks:
        x, y, bw, bh = find_floor_plan_bbox(s["mask"])
        strategy_bboxes.append((x, y, x + bw, y + bh))  # convert to (x0, y0, x1, y1)

    anchor_name = max(strategy_room_data, key=lambda s: s["count"])["strategy"]

    merge_context = MergeContext(
        image_shape=(h, w),
        strategy_bboxes=strategy_bboxes,
        strategy_masks=strategy_masks,
        anchor_strategy=anchor_name,
    )
    clustered, merge_meta = run_merge_pipeline(strategy_room_data, merge_context)
```

**In the meta block** (around line 121), add after `result["meta"]["merge_time_ms"] = elapsed_ms`:
```python
    result["meta"]["merge_steps"] = merge_meta
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cv-service && python -m pytest tests/test_pipeline.py::test_pipeline_includes_merge_steps -v`
Expected: PASS.

- [ ] **Step 5: Run ALL pipeline tests**

Run: `cd cv-service && python -m pytest tests/test_pipeline.py -v`
Expected: All tests pass (existing tests unchanged — merge_stats, confidence, found_by all still present).

- [ ] **Step 6: Commit**

```bash
git add cv-service/cv/pipeline.py cv-service/tests/test_pipeline.py
git commit -m "feat(cv): wire merge pipeline runner into analyze_image"
```

---

### Task 10: Update remaining tests and strategy counts

**Files:**
- Modify: `cv-service/tests/test_app.py` (if strategy count referenced)
- Modify: `cv-service/tests/test_sweep.py` (if strategy count referenced)

- [ ] **Step 1: Check for hardcoded strategy counts in other test files**

Run: `cd cv-service && grep -rn "27\|STRATEGIES" tests/ --include="*.py" | grep -v __pycache__`

Update any test that asserts `27` strategies to `28`. Update any expected strategy name sets to include `"distance_wall_fill"`.

- [ ] **Step 2: Run full test suite**

Run: `cd cv-service && python -m pytest -v`
Expected: All tests pass.

- [ ] **Step 3: Commit if changes were needed**

```bash
git add cv-service/tests/
git commit -m "test(cv): update strategy counts 27→28 across test suite"
```

---

### Task 11: Update ARCH.md

**Files:**
- Modify: `docs/arch/main/ARCH.md`

- [ ] **Step 1: Update architecture documentation**

Update the following sections in `docs/arch/main/ARCH.md`:
- Strategy count: 27 → 28, add `distance_wall_fill` to the list
- Merge pipeline section: document the step registry, the four default steps, and the `MergeContext`/`MergeStepResult` data structures
- Column detection: note as diagnostic metadata, not yet used for room filtering
- Known issues: note that bbox filtering addresses the logo/text false room problem

- [ ] **Step 2: Commit**

```bash
git add docs/arch/main/ARCH.md
git commit -m "docs: update ARCH.md with merge pipeline registry, strategy #28, column detection"
```

---

### Task 12: Deploy and verify on real images

**Files:**
- Run: `cv-service/deploy-hetzner.sh`

- [ ] **Step 1: Deploy to Hetzner**

Run: `cd cv-service && ./deploy-hetzner.sh`
Expected: Successful deployment, service healthy.

- [ ] **Step 2: Run sweep on 547 W 47th to verify distance_wall_fill**

Use the MCP `analyze_floor_plan_image` tool or curl the `/sweep` endpoint with the 547 W 47th image URL. Verify `distance_wall_fill` appears in results and produces rooms.

- [ ] **Step 3: Run analyze on 547 W 47th to verify bbox filtering**

Use the `/analyze` endpoint. Check `meta.merge_steps` — verify `bbox_filter_pre` removed rooms. Verify that "WEST RESIDENCE CLUB" and dimension-text rooms are gone from the output.

- [ ] **Step 4: Run analyze on all 4 test images to verify no regression**

Check room counts match or improve vs. baseline:
- 547 W 47th: was 8 rooms
- 520 W 23rd: was 5 rooms
- Plan 3: was 8 rooms
- New plan: was 5 rooms

- [ ] **Step 5: Check column detection output**

In the `/analyze` response for 547 W 47th, check `meta.merge_steps` for the `column_detect` step. Note `columns_found` and `grid_detected` values.
