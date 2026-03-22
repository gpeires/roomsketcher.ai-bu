# Wall-Thickness-Aware Room Detection

## Problem

The CV pipeline detects rooms by tracing contours on binarized wall masks. This works for thin-walled floor plans (~2-4px walls) but fails on luxury/architectural plans where walls are 8-20px thick and structural junctions form column-like blocks.

**Failure modes observed:**

1. **Room merging** — Thick walls between rooms are treated as features within a single contour, merging adjacent rooms into one polygon. On 547 W 47th, Living & Dining + Dressing Area + Kitchen become one blob. On 520 W 23rd, Primary Bedroom + Dining Room + Hall merge.

2. **Polygon distortion** — Room polygons follow the outer face of thick walls instead of the inner face. Protrusions, alcoves, and indents created by structural elements are smoothed away or included as room area.

3. **Missing rooms** — Spaces defined by thick walls (e.g., the Dressing Area on 547 W 47th) aren't detected as rooms because the thick wall mass connecting them to adjacent spaces prevents contour closure.

**Root cause:** Contour tracing on a binarized mask treats all white pixels as "room" and all black pixels as "wall." When walls are thick, the room-side and corridor-side of a wall are far apart. The contour walks around the thick wall mass, producing a polygon that includes the wall's footprint rather than stopping at the wall's inner face.

**Impact:** Room polygons are geometrically inaccurate, leading to inaccurate sketches. Wall thickness data exists in the image but is discarded. The sketch generator uses hardcoded wall widths (20cm exterior, 10cm interior) regardless of the source image.

## Empirical Data

Analysis across 4 test images confirms a consistent two-population thickness model:

| Image | Thin wall (full width) | Thick elements | Wall pixel % |
|-------|----------------------|----------------|-------------|
| 547 W 47th | ~4px | 10-20px | 4.4% |
| 520 W 23rd | ~4px | 10-20px | 40.7%* |
| Plan 3 | ~4px | 12-60px | 11.5% |
| New Plan | ~4px | 10-74px | 7.4% |

*520 W 23rd has margin artifacts inflating wall pixel count.

**Erosion cascade findings:** 5x5 kernel erosion cleanly separates thin walls (vanish) from thick structural elements (survive). After 7x7 erosion, surviving blobs are reliably structural: columns (area 200-5000px, aspect < 3), thick walls (area > 500, aspect > 5), and perimeter walls.

## Design

### Part 1: Structural Element Detection (CV layer)

Replace the current `detect_columns_step` (which finds zero results on all test images) with `detect_structural_elements_step`. This step produces a thickness profile of the floor plan.

**Pluggable backend interface:**

```python
@dataclass
class StructuralElement:
    kind: str                          # "column" | "thick_wall" | "perimeter"
    centroid: tuple[int, int]          # pixel position
    bbox: tuple[int, int, int, int]   # x, y, w, h
    area_px: int
    thickness_px: float               # measured full thickness
    aspect_ratio: float

@dataclass
class ThicknessProfile:
    elements: list[StructuralElement]
    thin_wall_px: float               # median thin-wall full thickness
    thick_wall_px: float              # median thick-element full thickness
    grid_detected: bool
    grid_spacing_px: list[int] | None
```

**Backend A (default): Distance transform**

Mask polarity: `anchor_mask` uses walls=white (255), rooms=black (0). `cv2.distanceTransform` computes the distance from each foreground (white/wall) pixel to the nearest background (black/room) pixel. The local maxima of this transform along the wall skeleton give half-thickness values.

1. `cv2.distanceTransform(anchor_mask, cv2.DIST_L2, 5)` — each wall pixel gets its distance to the nearest room pixel (= half-thickness at that point)
2. Histogram the distance values across all wall pixels to find the thin-wall peak (typically ~2px half-thickness = 4px full width)
3. Threshold: pixels with distance > 2× the thin-wall peak are "thick" regions
4. Create a thick-region mask by thresholding the distance map, run `cv2.connectedComponentsWithStats` on it
5. Classify each thick blob by shape: compact (aspect < 3, area < 5000px) = `column`; elongated (aspect ≥ 3) or large (area ≥ 5000px) = `thick_wall`; area > 20% of image = `perimeter`
6. Filter junction false positives: if a thick blob's centroid is at a junction of thin walls (where distance naturally spikes due to geometry, not structural mass), discard it. Detect junctions by checking if the blob connects ≥ 3 thin-wall segments.

**Backend B (fallback): Erosion cascade**
Same interface, progressive erosion at 3/5/7px kernels on the wall mask. Components surviving 5x5+ are structural. Shape classification same as A.

**Backend C (future): Medial axis**
Same interface, requires scikit-image. `medial_axis(anchor_mask, return_distance=True)` → skeleton + per-pixel half-thickness for full wall-width profiling.

All backends produce `ThicknessProfile`. Backend selection via `structural_backend: str = "distance_transform"` field on `MergeContext`.

**Merge pipeline integration:** Replaces `"column_detect"` in `POST_CLUSTER_STEPS`. Step name becomes `"structural_detect"`. Stores result in `context.thickness_profile` (replacing `context.columns`). Backward-compatible: the step still produces `columns_found`, `grid_detected` metadata keys.

**MergeContext additions:**

```python
@dataclass
class MergeContext:
    image_shape: tuple[int, int]
    strategy_bboxes: list[tuple[int, int, int, int]]
    consensus_bbox: tuple[int, int, int, int] | None = None
    anchor_strategy: str | None = None
    anchor_mask: np.ndarray | None = None           # NEW: direct reference to anchor binary mask
    strategy_masks: list[dict] | None = None
    columns: list[dict] | None = None               # DEPRECATED: use thickness_profile
    thickness_profile: ThicknessProfile | None = None  # NEW
    structural_backend: str = "distance_transform"   # NEW: "distance_transform" | "erosion_cascade" | "medial_axis"
```

Adding `anchor_mask` directly to `MergeContext` avoids the lookup-by-name pattern in `detect_columns_step` and makes it available to both `structural_detect` and `polygon_refine`.

**Performance budget:** Distance transform is O(n) and runs in <5ms on test images. Erosion cascade (3 passes + CC) adds ~15ms. The existing `column_detect` step runs in 0-4ms. Target: `structural_detect` < 20ms, `polygon_refine` < 30ms. Steps already report `time_ms` in metadata.

### Part 2: Wall-Thickness-Aware Room Polygon Refinement

New merge pipeline step `"polygon_refine"` that runs after `"structural_detect"`. Uses the thickness profile to adjust room polygons.

**Algorithm:**

1. **Build thick-wall-expanded mask.** Start with the anchor wall mask (walls=white, rooms=black). **Dilate** the wall mask by `thick_wall_px / 2` only in regions where structural elements were detected (using the element bboxes from Part 1 as a spatial mask for the dilation). This expands thick walls into room space, narrowing the room contours at structural boundaries. Thin walls are left unchanged — they are already correctly sized. The result is a mask where thick wall junctions that previously left wide gaps between wall faces now form narrow passages or close entirely.

2. **Re-trace room contours** on the expanded-wall mask. With thick walls expanded, contours now follow the inner face of thick walls. Thick wall junctions that previously merged rooms into single blobs now separate them because the expanded walls close the gap.

3. **Match refined polygons to clustered rooms.** Each refined contour is matched to the nearest original room cluster by centroid proximity and IoU overlap. This preserves room labels, confidence scores, and `found_by` data from the merge pipeline. Edge cases:
   - **Split:** One original room → multiple refined contours. Emit each as a separate room. The largest inherits the original label/confidence; others get label "Room N" with confidence 0.5 and a `split_from` field referencing the original.
   - **No match (new room):** A refined contour with no IoU overlap to any original room. Emit as a new room with confidence 0.3 and `source: "polygon_refine"`.
   - **Lost room:** An original room with no matching refined contour (eroded away). Preserve the original polygon as a fallback — do not drop rooms. Log a warning.

4. **Split detection.** If a single original room polygon splits into multiple contours after refinement (because thick walls now separate them), emit multiple rooms. This directly addresses the room-merging failure mode.

5. **Preserve protrusions.** The refined contours naturally include indents, alcoves, and notches created by structural elements — the geometry the original pipeline was smoothing away.

**Pipeline position:** After `structural_detect`, before final output. New pipeline order:

```
bbox_filter_pre → cluster → bbox_filter_post → structural_detect → polygon_refine
```

### Part 3: Downstream Data (CV output → Sketch generator)

**CV output changes:**

Add to the analyze response:
```python
"wall_thickness": {
    "thin_cm": 10.2,      # thin wall width in cm (using scale_cm_per_px)
    "thick_cm": 20.4,     # thick wall/column width in cm
    "structural_elements": [
        {
            "kind": "column",
            "centroid_cm": [120, 340],
            "size_cm": [15, 18],
            "thickness_cm": 15.0
        }
    ]
}
```

Room polygons in the output will be the refined versions from Part 2 — more vertices, more accurate shapes, with indents and protrusions preserved.

**SimpleFloorPlanInput schema changes:**

Add optional wall thickness hints:
```typescript
export const SimpleFloorPlanInputSchema = z.object({
  name: z.string(),
  units: z.enum(['metric', 'imperial']).optional(),
  rooms: z.array(SimpleRoomInputSchema).min(1),
  openings: z.array(SimpleOpeningInputSchema).optional(),
  furniture: z.array(SimpleFurnitureInputSchema).optional(),
  wallThickness: z.object({
    exterior: z.number().optional(),  // cm, overrides default 20
    interior: z.number().optional(),  // cm, overrides default 10
  }).optional(),
});
```

**Sketch generator changes:**

In `compile-layout.ts`, `makeWall()` reads from `wallThickness` input when available instead of using hardcoded `WALL_THICKNESS` defaults. This is a minimal change — the wall generation logic stays room-first, but wall widths match the source image.

### Part 4: Pydantic Response Models

Update `app.py` models to include the new fields:

```python
class StructuralElementOutput(BaseModel):
    kind: str                    # "column" | "thick_wall" | "perimeter"
    centroid_cm: list[float]     # [x, y] in cm
    size_cm: list[float]         # [width, height] in cm
    thickness_cm: float

class WallThickness(BaseModel):
    thin_cm: float
    thick_cm: float
    structural_elements: list[StructuralElementOutput] = []

class MetaOutput(BaseModel):
    # ... existing fields ...
    wall_thickness: WallThickness | None = None
```

This is critical — Pydantic silently strips unknown fields, so any new output field MUST have a corresponding model update. Using typed `StructuralElementOutput` instead of `list[dict]` ensures field validation and prevents silent data loss.

## Scope and Phasing

**Phase 1 (this work):** Parts 1 + 2 — structural detection + polygon refinement in the CV pipeline. This is where the accuracy improvement lives.

**Phase 2:** Parts 3 + 4 — downstream data flow to sketch generator. Depends on Phase 1 producing correct data.

**Phase 1 deliverables:**
- `detect_structural_elements_step` with Backend A (distance transform)
- `refine_polygons_step` in the merge pipeline
- Updated tests with structural element assertions on all 4 test images
- Visual verification: analyze all 4 images, compare refined polygons to source

**Phase 2 deliverables:**
- `wall_thickness` in CV output + Pydantic models
- `wallThickness` in SimpleFloorPlanInput schema
- Sketch generator reads wall thickness from input
- End-to-end test: image → analyze → generate sketch → visual comparison

## Testing Strategy

**Unit tests:**
- Synthetic images with known thick walls: verify structural elements detected with correct thickness
- Synthetic image with column grid: verify grid detection
- Room polygon refinement on synthetic merged-room polygon: verify split
- Backend A vs Backend B produce consistent classifications on same input

**Integration tests:**
- All 4 test images through the full pipeline: verify room counts don't regress
- 520 W 23rd: verify Primary Bedroom and Dining Room are separate rooms after refinement
- 547 W 47th: verify Dressing Area detected as a room after refinement
- Wall thickness values are plausible (5-25cm range for residential)

**Visual verification (human):**
- Overlay refined polygons on source images for all 4 test plans
- Compare sketch output to source image side-by-side

## Risks

1. **Polygon refinement may over-split rooms.** Erosion could fragment rooms that are correctly merged. Mitigation: only split when the thick-wall erosion creates the gap, not thin-wall erosion. Use the thickness profile to be selective.

2. **Erosion may lose small rooms.** Rooms smaller than the erosion kernel could vanish. Mitigation: only erode in regions where structural elements were detected, not globally.

3. **Backend A junction false positives.** T/L wall junctions have elevated distance-transform values that look like columns. Mitigation: filter candidates whose centroid sits at a skeleton junction of thin walls (junction = natural thickness elevation, not structural element).

4. **Scale sensitivity.** Wall thickness in pixels varies with image resolution. All thresholds must be relative to the thin-wall baseline, not absolute pixel values.

5. **Pydantic model drift.** New output fields must be added to response models in `app.py`. Existing pattern: unit tests pass (test dicts directly) but API output is missing. Mitigation: always update Pydantic models in the same PR as pipeline changes.
