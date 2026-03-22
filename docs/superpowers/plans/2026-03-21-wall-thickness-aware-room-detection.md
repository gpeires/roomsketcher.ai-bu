# Wall-Thickness-Aware Room Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken column detector with structural element detection via distance transform, then refine room polygons using wall thickness data so rooms accurately reflect inner wall faces — including protrusions, alcoves, and column indents.

**Architecture:** New `detect_structural_elements_step` replaces `detect_columns_step` in the merge pipeline's post-cluster phase. A new `refine_polygons_step` follows it. Both use the anchor strategy's binary mask via `MergeContext.anchor_mask`. Data classes `StructuralElement` and `ThicknessProfile` carry thickness data through the pipeline. Phase 2 (not in this plan) will pass thickness downstream to the sketch generator.

**Tech Stack:** Python 3.11, OpenCV (cv2), numpy, FastAPI, Pydantic, pytest

**Spec:** `docs/superpowers/specs/2026-03-21-wall-thickness-aware-room-detection-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `cv-service/cv/merge.py` | Add data classes, structural detection step, polygon refinement step, update registry |
| Modify | `cv-service/cv/pipeline.py:102-107` | Pass `anchor_mask` into `MergeContext` |
| Modify | `cv-service/app.py:33-45` | Add `WallThickness` and `StructuralElementOutput` Pydantic models |
| Modify | `cv-service/tests/test_merge.py` | Replace column detection tests, add structural + refinement tests |
| Modify | `cv-service/tests/test_pipeline.py:48-57` | Update step name assertions |

---

### Task 1: Update MergeContext with new fields

**Files:**
- Modify: `cv-service/cv/merge.py:18-26`
- Modify: `cv-service/cv/pipeline.py:102-107`
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write failing test — MergeContext has new fields**

In `cv-service/tests/test_merge.py`, add at the bottom of the imports (line 11) and a new test:

```python
# Add to imports at line 6-11:
# After existing imports, verify the new names are importable

# New test class:
class TestMergeContextFields:
    def test_has_anchor_mask(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
            anchor_mask=mask,
        )
        assert ctx.anchor_mask is not None
        assert ctx.anchor_mask.shape == (100, 100)

    def test_has_thickness_profile(self):
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
        )
        assert ctx.thickness_profile is None

    def test_has_structural_backend(self):
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
        )
        assert ctx.structural_backend == "distance_transform"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestMergeContextFields -v
```

Expected: `TypeError` — `anchor_mask` is not a valid field.

- [ ] **Step 3: Add data classes and update MergeContext**

In `cv-service/cv/merge.py`, replace lines 18-26 with:

```python
@dataclass
class StructuralElement:
    """A detected structural element (column, thick wall, or perimeter)."""
    kind: str                          # "column" | "thick_wall" | "perimeter"
    centroid: tuple[int, int]          # pixel position
    bbox: tuple[int, int, int, int]   # x, y, w, h
    area_px: int
    thickness_px: float               # measured full thickness (2x distance transform value)
    aspect_ratio: float


@dataclass
class ThicknessProfile:
    """Wall thickness analysis result from structural detection."""
    elements: list[StructuralElement]
    thin_wall_px: float               # median thin-wall full thickness
    thick_wall_px: float              # median thick-element full thickness
    grid_detected: bool = False
    grid_spacing_px: list[int] | None = None


@dataclass
class MergeContext:
    """Shared state bag passed through merge pipeline steps."""
    image_shape: tuple[int, int]
    strategy_bboxes: list[tuple[int, int, int, int]]
    consensus_bbox: tuple[int, int, int, int] | None = None
    anchor_strategy: str | None = None
    anchor_mask: np.ndarray | None = None
    strategy_masks: list[dict] | None = None
    columns: list[dict] | None = None               # deprecated: use thickness_profile
    thickness_profile: ThicknessProfile | None = None
    structural_backend: str = "distance_transform"
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestMergeContextFields -v
```

Expected: 3 passed.

- [ ] **Step 5: Update pipeline.py to pass anchor_mask**

In `cv-service/cv/pipeline.py`, modify the MergeContext construction at lines 102-107. The anchor_mask lookup (currently at line 115) needs to happen earlier:

```python
    anchor_name = max(strategy_room_data, key=lambda s: s["count"])["strategy"]
    anchor_mask = next(s["mask"] for s in strategy_masks if s["strategy"] == anchor_name)

    merge_context = MergeContext(
        image_shape=(h, w),
        strategy_bboxes=strategy_bboxes,
        strategy_masks=strategy_masks,
        anchor_strategy=anchor_name,
        anchor_mask=anchor_mask,
    )
    clustered, merge_meta = run_merge_pipeline(strategy_room_data, merge_context)
```

Remove the duplicate `anchor_mask` lookup at line 115 — it's now on `merge_context.anchor_mask`. Update the usage at line 118:

```python
    anchor_mask = merge_context.anchor_mask
```

- [ ] **Step 6: Run full test suite to verify no regressions**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass (172+).

- [ ] **Step 7: Commit**

```bash
cd cv-service && git add cv/merge.py cv/pipeline.py tests/test_merge.py
git -c commit.gpgsign=false commit -m "feat(cv): add StructuralElement, ThicknessProfile, anchor_mask to MergeContext"
```

---

### Task 2: Implement detect_structural_elements_step (Backend A — distance transform)

**Files:**
- Modify: `cv-service/cv/merge.py:229-328` (replace detect_columns_step and _check_grid_regularity)
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write failing tests for structural detection**

Replace `TestDetectColumnsStep` in `cv-service/tests/test_merge.py` (lines 306-351) with:

```python
class TestDetectStructuralElements:
    def _make_thick_wall_mask(self):
        """Mask with thin walls (2px) and thick walls (12px) and a column (10x10)."""
        mask = np.zeros((400, 600), dtype=np.uint8)
        # Thin walls (2px wide)
        mask[50:52, 50:550] = 255        # horizontal thin wall
        mask[50:350, 50:52] = 255        # vertical thin wall
        mask[50:350, 548:550] = 255      # vertical thin wall
        mask[348:350, 50:550] = 255      # horizontal thin wall
        # Thick wall (12px wide)
        mask[190:202, 50:300] = 255      # horizontal thick wall
        # Column (10x10 solid square, connected to thick wall)
        mask[185:207, 295:310] = 255     # column at junction
        return mask

    def test_detects_thick_elements(self):
        mask = self._make_thick_wall_mask()
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            anchor_mask=mask,
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_structural_elements_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert ctx.thickness_profile is not None
        assert ctx.thickness_profile.thin_wall_px > 0
        assert ctx.thickness_profile.thick_wall_px > ctx.thickness_profile.thin_wall_px
        assert len(ctx.thickness_profile.elements) >= 1
        # At least one element should be a thick_wall or column
        kinds = {e.kind for e in ctx.thickness_profile.elements}
        assert kinds & {"thick_wall", "column"}

    def test_thin_only_mask_finds_no_thick_elements(self):
        """A mask with only 2px thin walls should find no structural elements."""
        mask = np.zeros((400, 600), dtype=np.uint8)
        mask[100:102, 50:550] = 255
        mask[200:202, 50:550] = 255
        mask[50:350, 50:52] = 255
        mask[50:350, 548:550] = 255
        rooms = [_make_room((300, 150))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            anchor_mask=mask,
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_structural_elements_step(rooms, ctx)
        assert ctx.thickness_profile is not None
        assert len(ctx.thickness_profile.elements) == 0
        assert ctx.thickness_profile.thin_wall_px > 0

    def test_noop_when_no_anchor_mask(self):
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)])
        result = detect_structural_elements_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.meta.get("skipped") is True

    def test_backward_compat_metadata_keys(self):
        """Step still emits columns_found and grid_detected for backward compat."""
        mask = self._make_thick_wall_mask()
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            anchor_mask=mask,
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_structural_elements_step(rooms, ctx)
        assert "columns_found" in result.meta
        assert "grid_detected" in result.meta
```

- [ ] **Step 2: Update imports in test_merge.py**

Replace `detect_columns_step` with `detect_structural_elements_step` in the import block at lines 6-11:

```python
from cv.merge import (
    MergeContext, MergeStepResult, compute_consensus_bbox, filter_by_bbox,
    cluster_rooms_step, filter_clusters_by_bbox, detect_structural_elements_step,
    run_merge_pipeline, DEFAULT_MERGE_PIPELINE, EXCLUDED_MERGE_STEPS,
    PRE_CLUSTER_STEPS, POST_CLUSTER_STEPS, CLUSTER_STEP,
)
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestDetectStructuralElements -v
```

Expected: `ImportError` — `detect_structural_elements_step` doesn't exist.

- [ ] **Step 4: Implement detect_structural_elements_step**

In `cv-service/cv/merge.py`, replace `detect_columns_step` (lines 229-291) and `_check_grid_regularity` (lines 294-328) with:

```python
def _find_thin_wall_peak(distances: np.ndarray) -> float:
    """Find the dominant thin-wall half-thickness from the distance transform histogram.

    The distance transform of wall pixels gives half-thickness at each point.
    Thin walls produce a strong peak at low values (typically 1-3px).
    Returns the peak half-thickness value.
    """
    # Only consider wall pixels with distance > 0
    wall_distances = distances[distances > 0]
    if len(wall_distances) == 0:
        return 1.0

    # Histogram with 1px bins up to reasonable max
    max_dist = min(int(wall_distances.max()) + 1, 50)
    hist, bin_edges = np.histogram(wall_distances, bins=max_dist, range=(0.5, max_dist + 0.5))

    if len(hist) == 0:
        return 1.0

    # The thin-wall peak is the most common distance value
    peak_bin = int(np.argmax(hist))
    return bin_edges[peak_bin] + 0.5  # center of bin


def detect_structural_elements_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Detect structural elements (columns, thick walls) via distance transform.

    Replaces detect_columns_step. Uses distance transform on the anchor mask
    to measure wall thickness, then classifies thick regions as columns or
    thick walls based on shape.
    """
    anchor_mask = context.anchor_mask
    if anchor_mask is None:
        # Fallback: try to find anchor mask from strategy_masks
        if context.strategy_masks and context.anchor_strategy:
            for s in context.strategy_masks:
                if s["strategy"] == context.anchor_strategy:
                    anchor_mask = s["mask"]
                    break
        if anchor_mask is None:
            return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    h, w = anchor_mask.shape
    total_px = h * w

    # Distance transform: each wall pixel gets its distance to the nearest room pixel.
    # This gives half-thickness at each point along the wall.
    dist = cv2.distanceTransform(anchor_mask, cv2.DIST_L2, 5)

    # Find the thin-wall baseline
    thin_half = _find_thin_wall_peak(dist)
    thin_full = thin_half * 2

    # Threshold: pixels with distance > 2× the thin-wall peak are "thick"
    thick_threshold = thin_half * 2
    thick_mask = (dist > thick_threshold).astype(np.uint8) * 255

    # Connected components on thick regions
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        thick_mask, connectivity=8
    )

    elements: list[StructuralElement] = []
    min_area = max(20, int(total_px * 0.0001))

    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        cx, cy = int(centroids[i][0]), int(centroids[i][1])
        bx = int(stats[i, cv2.CC_STAT_LEFT])
        by = int(stats[i, cv2.CC_STAT_TOP])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        aspect = max(bw, bh) / max(min(bw, bh), 1)

        # Measure thickness: max distance value within this blob
        blob_mask = (labels == i)
        max_thickness = float(dist[blob_mask].max()) * 2  # full thickness

        # Junction false-positive filter: if this blob is small and sits at
        # a junction of thin walls, it's a natural thickness spike, not a
        # structural element. Check by counting how many thin-wall segments
        # connect to the blob's bounding box perimeter.
        if area < max(2000, int(total_px * 0.005)):
            # Sample the original wall mask around the blob's bbox perimeter
            margin = 3
            y0 = max(0, by - margin)
            y1 = min(h, by + bh + margin)
            x0 = max(0, bx - margin)
            x1 = min(w, bx + bw + margin)
            # Count wall pixels on the 4 edges of the expanded bbox
            edges_wall = 0
            if y0 > 0:
                edges_wall += int(np.sum(anchor_mask[y0, x0:x1] > 0))
            if y1 < h:
                edges_wall += int(np.sum(anchor_mask[y1 - 1, x0:x1] > 0))
            if x0 > 0:
                edges_wall += int(np.sum(anchor_mask[y0:y1, x0] > 0))
            if x1 < w:
                edges_wall += int(np.sum(anchor_mask[y0:y1, x1 - 1] > 0))
            perimeter_len = 2 * (x1 - x0) + 2 * (y1 - y0)
            wall_ratio = edges_wall / max(perimeter_len, 1)
            # If >60% of the perimeter touches walls, this is a junction, not a column
            if wall_ratio > 0.6 and aspect < 2.0:
                continue

        # Classify
        if area > total_px * 0.2:
            kind = "perimeter"
        elif aspect < 3 and area < max(5000, int(total_px * 0.01)):
            kind = "column"
        else:
            kind = "thick_wall"

        elements.append(StructuralElement(
            kind=kind,
            centroid=(cx, cy),
            bbox=(bx, by, bw, bh),
            area_px=area,
            thickness_px=max_thickness,
            aspect_ratio=round(aspect, 2),
        ))

    # Compute median thick-wall thickness
    thick_thicknesses = [e.thickness_px for e in elements if e.kind != "perimeter"]
    thick_wall_px = float(np.median(thick_thicknesses)) if thick_thicknesses else thin_full

    # Grid detection (reuse logic from old _check_grid_regularity)
    column_elements = [e for e in elements if e.kind == "column"]
    grid_detected = False
    grid_spacing = None
    if len(column_elements) >= 3:
        xs = sorted(e.centroid[0] for e in column_elements)
        ys = sorted(e.centroid[1] for e in column_elements)
        grid_detected, grid_spacing = _check_grid_regularity(xs, ys)

    profile = ThicknessProfile(
        elements=elements,
        thin_wall_px=thin_full,
        thick_wall_px=thick_wall_px,
        grid_detected=grid_detected,
        grid_spacing_px=grid_spacing,
    )
    context.thickness_profile = profile

    # Backward-compat: also set context.columns
    context.columns = [
        {"centroid": e.centroid, "bbox": e.bbox, "area_px": e.area_px}
        for e in column_elements
    ]

    meta = {
        "columns_found": len(column_elements),
        "grid_detected": grid_detected,
        "grid_spacing_px": grid_spacing,
        "structural_elements": len(elements),
        "thin_wall_px": round(thin_full, 1),
        "thick_wall_px": round(thick_wall_px, 1),
    }
    return MergeStepResult(rooms=rooms, removed=[], meta=meta)
```

Keep `_check_grid_regularity` as-is (lines 294-328) — it's still used for grid detection on column elements.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestDetectStructuralElements -v
```

Expected: 4 passed.

- [ ] **Step 6: Update registry — replace column_detect with structural_detect**

In `cv-service/cv/merge.py`, update the registry (lines 410-420):

```python
POST_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_post": filter_clusters_by_bbox,
    "structural_detect": detect_structural_elements_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "structural_detect",
]
```

- [ ] **Step 7: Update registry and pipeline tests**

In `cv-service/tests/test_merge.py`, update `TestMergePipeline`:

- `test_runs_all_steps` (line 379): change `"column_detect"` to `"structural_detect"`
- `test_excludes_steps` (line 384): change `"column_detect"` to `"structural_detect"`
- `test_registry_populated` (line 402): change `"column_detect"` to `"structural_detect"`
- `test_default_pipeline_order` (line 405): change to `["bbox_filter_pre", "cluster", "bbox_filter_post", "structural_detect"]`

In `cv-service/tests/test_pipeline.py`, line 57: change `"column_detect"` to `"structural_detect"`

- [ ] **Step 8: Run full test suite**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
cd cv-service && git add cv/merge.py tests/test_merge.py tests/test_pipeline.py
git -c commit.gpgsign=false commit -m "feat(cv): replace column_detect with structural element detection via distance transform"
```

---

### Task 3: Implement refine_polygons_step

**Files:**
- Modify: `cv-service/cv/merge.py` (add new step after structural_detect)
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write failing tests for polygon refinement**

Add to `cv-service/tests/test_merge.py`:

```python
class TestRefinePolygonsStep:
    def _make_thick_wall_merged_mask(self):
        """Two rooms separated by a 16px thick wall.

        Without refinement, contour tracing sees this as one room because
        the thick wall has room-colored pixels on both sides that connect
        around the wall ends.

        Room A: left half (cols 0-240)
        Thick wall: cols 240-256 (16px wide)
        Room B: right half (cols 256-500)
        Thin outer walls: 2px
        """
        mask = np.zeros((300, 500), dtype=np.uint8)
        # Outer walls (2px)
        mask[0:2, :] = 255
        mask[298:300, :] = 255
        mask[:, 0:2] = 255
        mask[:, 498:500] = 255
        # Thick interior wall (16px) — with gaps at top and bottom so rooms connect
        mask[20:280, 240:256] = 255
        return mask

    def test_splits_merged_rooms(self):
        mask = self._make_thick_wall_merged_mask()
        # Create a single merged room that spans both sides
        merged_room = {
            "centroid": (250, 150),
            "bbox": (2, 2, 496, 296),
            "area_px": 140000,
            "confidence": 0.9,
            "found_by": ["raw", "otsu"],
            "polygon": [(2, 2), (498, 2), (498, 298), (2, 298)],
        }
        profile = ThicknessProfile(
            elements=[StructuralElement(
                kind="thick_wall",
                centroid=(248, 150),
                bbox=(240, 20, 16, 260),
                area_px=4160,
                thickness_px=16.0,
                aspect_ratio=16.25,
            )],
            thin_wall_px=2.0,
            thick_wall_px=16.0,
        )
        ctx = MergeContext(
            image_shape=(300, 500),
            strategy_bboxes=[(0, 0, 500, 300)],
            anchor_mask=mask,
            thickness_profile=profile,
        )
        result = refine_polygons_step([merged_room], ctx)
        # Should split into 2 rooms
        assert len(result.rooms) >= 2
        # Largest split room inherits original confidence/found_by
        largest = max(result.rooms, key=lambda r: r["area_px"])
        assert largest["confidence"] == 0.9
        assert "raw" in largest["found_by"]
        # Smaller split rooms get split_from and confidence 0.5
        others = [r for r in result.rooms if r is not largest]
        for r in others:
            assert r["confidence"] == 0.5
            assert "split_from" in r

    def test_preserves_rooms_on_thin_wall_mask(self):
        """Rooms separated by thin walls should not be affected."""
        mask = np.zeros((300, 500), dtype=np.uint8)
        mask[0:2, :] = 255
        mask[298:300, :] = 255
        mask[:, 0:2] = 255
        mask[:, 498:500] = 255
        mask[:, 248:250] = 255  # 2px thin interior wall
        room_a = {
            "centroid": (125, 150), "bbox": (2, 2, 246, 296),
            "area_px": 70000, "confidence": 0.9, "found_by": ["raw"],
            "polygon": [(2, 2), (248, 2), (248, 298), (2, 298)],
        }
        room_b = {
            "centroid": (375, 150), "bbox": (250, 2, 248, 296),
            "area_px": 70000, "confidence": 0.9, "found_by": ["raw"],
            "polygon": [(250, 2), (498, 2), (498, 298), (250, 298)],
        }
        profile = ThicknessProfile(
            elements=[],
            thin_wall_px=2.0,
            thick_wall_px=2.0,
        )
        ctx = MergeContext(
            image_shape=(300, 500),
            strategy_bboxes=[(0, 0, 500, 300)],
            anchor_mask=mask,
            thickness_profile=profile,
        )
        result = refine_polygons_step([room_a, room_b], ctx)
        assert len(result.rooms) == 2

    def test_noop_when_no_profile(self):
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)])
        result = refine_polygons_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.meta.get("skipped") is True

    def test_lost_room_preserved(self):
        """If refinement loses a room, original polygon is kept as fallback."""
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[:] = 255  # All wall — no room space
        room = {
            "centroid": (50, 50), "bbox": (10, 10, 80, 80),
            "area_px": 1000, "confidence": 0.7, "found_by": ["raw"],
            "polygon": [(10, 10), (90, 10), (90, 90), (10, 90)],
        }
        profile = ThicknessProfile(
            elements=[StructuralElement(
                kind="thick_wall", centroid=(50, 50),
                bbox=(0, 0, 100, 100), area_px=10000,
                thickness_px=50.0, aspect_ratio=1.0,
            )],
            thin_wall_px=2.0,
            thick_wall_px=50.0,
        )
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
            anchor_mask=mask,
            thickness_profile=profile,
        )
        result = refine_polygons_step([room], ctx)
        # Room should be preserved (fallback)
        assert len(result.rooms) >= 1
```

- [ ] **Step 2: Update imports**

Add `refine_polygons_step, StructuralElement, ThicknessProfile` to the import block in `tests/test_merge.py`.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestRefinePolygonsStep -v
```

Expected: `ImportError` — `refine_polygons_step` doesn't exist.

- [ ] **Step 4: Implement refine_polygons_step**

Add to `cv-service/cv/merge.py`, after `detect_structural_elements_step`:

```python
def refine_polygons_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Refine room polygons using wall thickness data.

    Dilates thick wall regions in the wall mask so room contours follow the
    inner face of thick walls. This can split merged rooms and preserve
    protrusions/alcoves created by structural elements.
    """
    if context.anchor_mask is None or context.thickness_profile is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    profile = context.thickness_profile
    if not profile.elements:
        return MergeStepResult(rooms=rooms, removed=[], meta={
            "skipped": False, "reason": "no_thick_elements", "rooms_in": len(rooms),
        })

    anchor_mask = context.anchor_mask.copy()
    h, w = anchor_mask.shape
    min_room_area = int(h * w * 0.005)

    # Build dilation mask: only dilate in regions around structural elements
    # Dilate by half the thick wall width (spec: thick_wall_px / 2)
    dilation_amount = max(1, int(profile.thick_wall_px / 2))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                                       (dilation_amount * 2 + 1, dilation_amount * 2 + 1))

    # Create a region mask covering structural element bboxes (with padding)
    region_mask = np.zeros((h, w), dtype=np.uint8)
    pad = dilation_amount * 2
    for elem in profile.elements:
        bx, by, bw, bh = elem.bbox
        y0 = max(0, by - pad)
        y1 = min(h, by + bh + pad)
        x0 = max(0, bx - pad)
        x1 = min(w, bx + bw + pad)
        region_mask[y0:y1, x0:x1] = 255

    # Dilate the wall mask, but only apply changes in structural regions
    dilated = cv2.dilate(anchor_mask, kernel, iterations=1)
    refined_mask = anchor_mask.copy()
    structural_region = region_mask > 0
    refined_mask[structural_region] = dilated[structural_region]

    # Re-trace room contours on the refined mask
    # Close door gaps (same logic as rooms.py detect_rooms)
    gap_size = max(15, min(80, max(h, w) // 10))
    v_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap_size))
    closed = cv2.morphologyEx(refined_mask, cv2.MORPH_CLOSE, v_kern, iterations=1)
    h_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (gap_size, 1))
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, h_kern, iterations=1)

    inv = cv2.bitwise_not(closed)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(inv, connectivity=4)

    # Collect refined room contours
    refined_rooms: list[dict] = []
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_room_area:
            continue
        rx = int(stats[i, cv2.CC_STAT_LEFT])
        ry = int(stats[i, cv2.CC_STAT_TOP])
        rw = int(stats[i, cv2.CC_STAT_WIDTH])
        rh = int(stats[i, cv2.CC_STAT_HEIGHT])
        rcx, rcy = int(centroids[i][0]), int(centroids[i][1])

        # Skip exterior background
        touches_border = rx == 0 or ry == 0 or (rx + rw) >= w or (ry + rh) >= h
        if touches_border and area > (h * w * 0.3):
            continue

        # Extract polygon
        room_mask = (labels == i).astype(np.uint8) * 255
        contours, _ = cv2.findContours(room_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        epsilon = 0.015 * perimeter
        approx = cv2.approxPolyDP(largest, epsilon, True)
        polygon = [(int(pt[0][0]), int(pt[0][1])) for pt in approx]

        refined_rooms.append({
            "centroid": (rcx, rcy),
            "bbox": (rx, ry, rw, rh),
            "area_px": int(area),
            "polygon": polygon,
        })

    # Match refined rooms to originals — allows multiple refined rooms per original (splits)
    max_match_dist = max(h, w) * 0.3
    # For each refined room, find the closest original by centroid
    matches: dict[int, list[dict]] = {}  # orig_idx -> list of refined rooms
    unmatched_refined: list[dict] = []

    for refined in refined_rooms:
        rcx, rcy = refined["centroid"]
        best_idx = -1
        best_dist = float("inf")
        for j, orig in enumerate(rooms):
            ocx, ocy = orig.get("centroid", (0, 0))
            if isinstance(ocx, float):
                ocx, ocy = int(ocx), int(ocy)
            # Check if refined room's centroid falls within original's bbox
            ox, oy, ow, oh = orig.get("bbox", (0, 0, w, h))
            inside = ox <= rcx <= ox + ow and oy <= rcy <= oy + oh
            d = ((rcx - ocx) ** 2 + (rcy - ocy) ** 2) ** 0.5
            if (inside or d < max_match_dist) and d < best_dist:
                best_dist = d
                best_idx = j

        if best_idx >= 0:
            matches.setdefault(best_idx, []).append(refined)
        else:
            unmatched_refined.append(refined)

    output_rooms: list[dict] = []
    matched_originals: set[int] = set()

    for orig_idx, refined_list in matches.items():
        matched_originals.add(orig_idx)
        orig = rooms[orig_idx]
        if len(refined_list) == 1:
            # 1:1 match — inherit all original metadata, update geometry
            output_rooms.append({
                **orig,
                "polygon": refined_list[0]["polygon"],
                "centroid": refined_list[0]["centroid"],
                "bbox": refined_list[0]["bbox"],
                "area_px": refined_list[0]["area_px"],
            })
        else:
            # Split: largest inherits original, others get split_from
            sorted_by_area = sorted(refined_list, key=lambda r: r["area_px"], reverse=True)
            largest = sorted_by_area[0]
            output_rooms.append({
                **orig,
                "polygon": largest["polygon"],
                "centroid": largest["centroid"],
                "bbox": largest["bbox"],
                "area_px": largest["area_px"],
            })
            for split_room in sorted_by_area[1:]:
                output_rooms.append({
                    **split_room,
                    "confidence": 0.5,
                    "found_by": orig.get("found_by", []),
                    "split_from": orig.get("centroid"),
                    "source": "polygon_refine",
                })

    # Unmatched refined rooms = newly discovered
    for refined in unmatched_refined:
        output_rooms.append({
            **refined,
            "confidence": 0.3,
            "found_by": [],
            "source": "polygon_refine",
        })

    # Preserve lost rooms (originals with no match)
    for j, orig in enumerate(rooms):
        if j not in matched_originals:
            log.warning("polygon_refine: room at %s lost, preserving original", orig.get("centroid"))
            output_rooms.append(orig)

    meta = {
        "rooms_in": len(rooms),
        "rooms_out": len(output_rooms),
        "rooms_split": max(0, len(output_rooms) - len(rooms)),
        "rooms_lost_preserved": len(rooms) - len(matched_originals),
        "dilation_px": dilation_amount,
    }
    return MergeStepResult(rooms=output_rooms, removed=[], meta=meta)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd cv-service && .venv/bin/python -m pytest tests/test_merge.py::TestRefinePolygonsStep -v
```

Expected: All tests pass.

- [ ] **Step 6: Register in pipeline**

In `cv-service/cv/merge.py`, update the registry:

```python
POST_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_post": filter_clusters_by_bbox,
    "structural_detect": detect_structural_elements_step,
    "polygon_refine": refine_polygons_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "structural_detect",
    "polygon_refine",
]
```

- [ ] **Step 7: Update pipeline tests**

In `tests/test_merge.py::TestMergePipeline`:
- `test_runs_all_steps`: add assertion `assert "polygon_refine" in step_names`
- `test_default_pipeline_order`: update to `["bbox_filter_pre", "cluster", "bbox_filter_post", "structural_detect", "polygon_refine"]`
- `test_registry_populated`: add `assert "polygon_refine" in POST_CLUSTER_STEPS`

In `tests/test_pipeline.py`: add `assert "structural_detect" in step_names` (line 57 area, alongside existing assertions).

- [ ] **Step 8: Run full test suite**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
cd cv-service && git add cv/merge.py tests/test_merge.py tests/test_pipeline.py
git -c commit.gpgsign=false commit -m "feat(cv): add polygon refinement step — splits merged rooms at thick walls"
```

---

### Task 4: Update Pydantic response models (Phase 2 prep — included early to avoid Pydantic stripping issue)

> **Note:** The spec places this in Phase 2, but the Pydantic silent-stripping problem means we should add the models now so thickness data isn't lost when it flows through the API. The sketch generator integration (SimpleFloorPlanInput changes) remains Phase 2.

**Files:**
- Modify: `cv-service/app.py:33-45`
- Test: `cv-service/tests/test_app.py` (if exists, otherwise `tests/test_pipeline.py`)

- [ ] **Step 1: Write failing test**

Add to the appropriate test file:

```python
def test_analyze_response_includes_wall_thickness(simple_2room_path):
    """Verify wall_thickness appears in API response meta."""
    from app import AnalyzeResponse
    # The model should accept wall_thickness in meta
    meta_data = {
        "image_size": (100, 100),
        "scale_cm_per_px": 1.0,
        "walls_detected": 4,
        "rooms_detected": 2,
        "text_regions": 0,
        "wall_thickness": {
            "thin_cm": 10.0,
            "thick_cm": 20.0,
            "structural_elements": [],
        },
    }
    from app import MetaOutput
    meta = MetaOutput(**meta_data)
    assert meta.wall_thickness is not None
    assert meta.wall_thickness.thin_cm == 10.0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -k "wall_thickness" -v
```

Expected: FAIL — `wall_thickness` not a valid field on `MetaOutput`.

- [ ] **Step 3: Add Pydantic models**

In `cv-service/app.py`, add before `MetaOutput` (around line 32):

```python
class StructuralElementOutput(BaseModel):
    kind: str
    centroid_cm: list[float]
    size_cm: list[float]
    thickness_cm: float

class WallThickness(BaseModel):
    thin_cm: float
    thick_cm: float
    structural_elements: list[StructuralElementOutput] = []
```

Add to `MetaOutput` (line 45):

```python
    wall_thickness: WallThickness | None = None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -k "wall_thickness" -v
```

Expected: PASS.

- [ ] **Step 5: Wire wall_thickness into pipeline output**

In `cv-service/cv/pipeline.py`, after the merge pipeline runs, extract thickness data from `merge_context.thickness_profile` and include it in the result meta. Find where `merge_stats` is attached to the result and add:

```python
    # After merge_meta is set:
    wall_thickness = None
    if merge_context.thickness_profile:
        tp = merge_context.thickness_profile
        scale = result.get("meta", {}).get("scale_cm_per_px", 1.0)
        wall_thickness = {
            "thin_cm": round(tp.thin_wall_px * scale, 1),
            "thick_cm": round(tp.thick_wall_px * scale, 1),
            "structural_elements": [
                {
                    "kind": e.kind,
                    "centroid_cm": [round(e.centroid[0] * scale, 1), round(e.centroid[1] * scale, 1)],
                    "size_cm": [round(e.bbox[2] * scale, 1), round(e.bbox[3] * scale, 1)],
                    "thickness_cm": round(e.thickness_px * scale, 1),
                }
                for e in tp.elements
                if e.kind != "perimeter"
            ],
        }
```

Add `"wall_thickness": wall_thickness` to the meta dict that gets returned.

- [ ] **Step 6: Run full test suite**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
cd cv-service && git add app.py cv/pipeline.py tests/
git -c commit.gpgsign=false commit -m "feat(cv): add wall_thickness to API response with Pydantic models"
```

---

### Task 5: Integration verification with real images

**Files:** None (verification only)

- [ ] **Step 1: Run all unit tests**

```bash
cd cv-service && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass.

- [ ] **Step 2: Deploy to Hetzner**

```bash
cd cv-service && ./deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner
```

- [ ] **Step 3: Verify 547 W 47th**

```bash
curl -s -X POST http://87.99.134.67:8100/analyze \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785", "name": "547 W 47th"}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
rooms = data.get('rooms', [])
meta = data.get('meta', {})
print(f'Rooms: {len(rooms)}')
for i, r in enumerate(rooms):
    poly = r.get('polygon', [])
    print(f'  Room {i+1}: {r.get(\"label\", \"?\")} vertices={len(poly)} confidence={r.get(\"confidence\", \"?\")}')
wt = meta.get('wall_thickness')
if wt:
    print(f'Wall thickness: thin={wt[\"thin_cm\"]}cm thick={wt[\"thick_cm\"]}cm elements={len(wt.get(\"structural_elements\", []))}')
steps = meta.get('merge_steps', {}).get('steps', [])
for s in steps:
    print(f'  Step: {s[\"name\"]} time={s.get(\"time_ms\", \"?\")}ms')
"
```

Expected: ≥8 rooms (possibly more due to splits), `wall_thickness` present, `structural_detect` and `polygon_refine` steps visible.

**Key check:** Does the Dressing Area appear as a separate room? Previously it was merged into the Living & Dining blob.

- [ ] **Step 4: Verify 520 W 23rd**

Same curl command with URL: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092`

Expected: ≥3 rooms (possibly more due to splits). Primary Bedroom and Dining Room should be separate.

- [ ] **Step 5: Verify Plan 3 and New Plan**

Plan 3 URL: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/f299ae0e-894b-4d16-a468-78775eb73400`
New Plan URL: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/53c1822d-3e22-429b-8476-b8066e409534`

Expected: Plan 3 ≥ 8 rooms, New Plan ≥ 5 rooms. No regressions.

- [ ] **Step 6: Visual verification with MCP tool**

Use `analyze_floor_plan_image` MCP tool on 547 W 47th and 520 W 23rd. Compare the output image with the source — do room polygons now show protrusions and alcoves from thick walls?

- [ ] **Step 7: Commit any fixes discovered during verification**

If verification reveals issues, fix them and commit. Update test baselines if room counts changed (improved).

- [ ] **Step 8: Update ARCH.md**

Update `docs/arch/main/ARCH.md` to reflect:
- `structural_detect` replacing `column_detect`
- `polygon_refine` as new pipeline step
- Updated merge results table with new room counts
- Wall thickness in API output

```bash
git add docs/arch/main/ARCH.md
git -c commit.gpgsign=false commit -m "docs: update ARCH.md with structural detection and polygon refinement"
```
