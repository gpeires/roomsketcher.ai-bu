# CV Image Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve CV room detection by running raw and contrast-enhanced images through the pipeline in parallel, returning whichever finds more rooms.

**Architecture:** A new `cv/enhance.py` module applies CLAHE + bilateral filter + unsharp mask to the input image. `cv/pipeline.py` runs both raw and enhanced through the existing pipeline concurrently via `ThreadPoolExecutor`, compares room counts, and returns the winner with preprocessing metadata. The FastAPI app in `app.py` gains a `PreprocessingMeta` Pydantic model. The Worker-side TypeScript type `CVResult` gains an optional `preprocessing` field.

**Tech Stack:** Python 3.11, OpenCV (already installed), FastAPI/Pydantic, ThreadPoolExecutor. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-20-cv-image-preprocessing-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `cv-service/cv/enhance.py` | **New.** `enhance(image, preset)` — applies OpenCV preprocessing to improve wall visibility. Takes BGR `np.ndarray`, returns BGR `np.ndarray`. |
| `cv-service/cv/pipeline.py` | **Modify.** Extract `_run_pipeline()`, add parallel raw+enhanced execution, add `pick_winner()`. |
| `cv-service/app.py` | **Modify.** Add `PreprocessingMeta` Pydantic model to `MetaOutput`. |
| `cv-service/tests/test_enhance.py` | **New.** Unit tests for enhancement and winner selection. |
| `cv-service/tests/test_pipeline.py` | **Modify.** Add test for preprocessing metadata in pipeline output. |
| `cv-service/tests/conftest.py` | **Modify.** Add a low-contrast fixture image for testing enhancement. |
| `src/ai/types.ts` | **Modify.** Add optional `preprocessing` field to `CVResult.meta`. |

---

## Codebase Context

**How tests run:** From `cv-service/` directory: `pytest tests/ -v`

**How the CV server is deployed:** `./cv-service/deploy-hetzner.sh <server-ip> [ssh-key-path]` — rsyncs code, builds Docker, restarts container on port 8100.

**How the Worker is deployed:** `./deploy.sh` from repo root. Never use `wrangler deploy` directly.

**Existing test fixtures:** `cv-service/tests/conftest.py` creates a synthetic 600x400 2-room floor plan image with black walls on white background. Tests use `simple_2room_image` (np.ndarray) and `simple_2room_path` (saved PNG) fixtures.

**Key constraint:** The `analyze_image()` function signature and return shape must not change — it takes `(image: np.ndarray, name: str)` and returns a dict with `name`, `rooms`, `openings`, `adjacency`, `meta` keys. The only addition is `meta.preprocessing`.

---

### Task 1: Create `cv/enhance.py` with tests

**Files:**
- Create: `cv-service/cv/enhance.py`
- Create: `cv-service/tests/test_enhance.py`
- Modify: `cv-service/tests/conftest.py`

- [ ] **Step 1: Add low-contrast fixture to conftest.py**

Open `cv-service/tests/conftest.py` and add this fixture after the existing `simple_2room_path` fixture:

```python
@pytest.fixture
def low_contrast_2room_image() -> np.ndarray:
    """Same layout as simple_2room_image but with faded, low-contrast walls.
    Walls are light gray (180) on slightly-off-white background (240).
    This simulates real-world scanned/photographed floor plans."""
    img = np.ones((400, 600, 3), dtype=np.uint8) * 240
    gray = (180, 180, 180)
    cv2.rectangle(img, (0, 0), (599, 399), gray, 20)
    cv2.line(img, (300, 10), (300, 180), gray, 10)
    cv2.line(img, (300, 220), (300, 390), gray, 10)
    cv2.putText(img, "Kitchen", (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
    cv2.putText(img, "Living", (370, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
    return img
```

- [ ] **Step 2: Write failing tests for `enhance()` and `pick_winner()`**

Create `cv-service/tests/test_enhance.py`:

```python
import numpy as np
import pytest
from cv.enhance import enhance, pick_winner


class TestEnhance:
    def test_returns_same_shape_as_input(self, simple_2room_image):
        result = enhance(simple_2room_image)
        assert result.shape == simple_2room_image.shape

    def test_returns_bgr_image(self, simple_2room_image):
        result = enhance(simple_2room_image)
        assert result.ndim == 3
        assert result.shape[2] == 3

    def test_modifies_pixel_values(self, simple_2room_image):
        result = enhance(simple_2room_image)
        # Enhancement should change at least some pixels
        assert not np.array_equal(result, simple_2room_image)

    def test_increases_contrast_on_low_contrast_image(self, low_contrast_2room_image):
        original = low_contrast_2room_image
        enhanced = enhance(original)
        # Standard deviation of pixel values should increase (more contrast)
        orig_std = np.std(original.astype(float))
        enhanced_std = np.std(enhanced.astype(float))
        assert enhanced_std > orig_std, (
            f"Enhanced contrast ({enhanced_std:.1f}) should exceed "
            f"original ({orig_std:.1f})"
        )

    def test_unknown_preset_raises(self, simple_2room_image):
        with pytest.raises(ValueError, match="Unknown preset"):
            enhance(simple_2room_image, preset="nonexistent")

    def test_standard_preset_is_default(self, simple_2room_image):
        default_result = enhance(simple_2room_image)
        explicit_result = enhance(simple_2room_image, preset="standard")
        assert np.array_equal(default_result, explicit_result)


class TestPickWinner:
    def _make_result(self, rooms_detected, walls_detected=10):
        return {
            "meta": {
                "rooms_detected": rooms_detected,
                "walls_detected": walls_detected,
            }
        }

    def test_more_rooms_wins(self):
        raw = self._make_result(2)
        enhanced = self._make_result(5)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "enhanced"
        assert winner is enhanced

    def test_raw_wins_when_more_rooms(self):
        raw = self._make_result(5)
        enhanced = self._make_result(3)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
        assert winner is raw

    def test_tie_goes_to_raw(self):
        raw = self._make_result(3)
        enhanced = self._make_result(3)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
        assert winner is raw

    def test_zero_rooms_both(self):
        raw = self._make_result(0)
        enhanced = self._make_result(0)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_enhance.py -v`

Expected: `ModuleNotFoundError: No module named 'cv.enhance'`

- [ ] **Step 4: Implement `cv/enhance.py`**

Create `cv-service/cv/enhance.py`:

```python
"""Image enhancement presets for improving CV wall detection."""
import cv2
import numpy as np


def enhance(image: np.ndarray, preset: str = "standard") -> np.ndarray:
    """Apply preprocessing to improve wall/line visibility in floor plans.

    Takes a BGR image, returns a BGR image of the same shape.
    The existing prepare() binarization runs after this, unchanged.

    Args:
        image: BGR color image (np.ndarray, shape H x W x 3)
        preset: Enhancement preset name. Currently: "standard".
    """
    presets = {
        "standard": _preset_standard,
    }
    fn = presets.get(preset)
    if fn is None:
        raise ValueError(f"Unknown preset: {preset!r}. Available: {list(presets.keys())}")
    return fn(image)


def pick_winner(
    raw_result: dict, enhanced_result: dict
) -> tuple[dict, str]:
    """Compare two pipeline results and return (winner, strategy_name).

    More rooms wins. Ties go to raw (conservative — avoid regression).
    """
    raw_rooms = raw_result["meta"]["rooms_detected"]
    enhanced_rooms = enhanced_result["meta"]["rooms_detected"]

    if enhanced_rooms > raw_rooms:
        return enhanced_result, "enhanced"
    return raw_result, "raw"


def _preset_standard(image: np.ndarray) -> np.ndarray:
    """Standard enhancement: CLAHE on luminance + bilateral filter + unsharp mask."""
    # 1. CLAHE on L channel of LAB color space (preserves color for OCR)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_channel)

    lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])
    result = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

    # 2. Bilateral filter — reduces noise while preserving edges
    result = cv2.bilateralFilter(result, d=9, sigmaColor=75, sigmaSpace=75)

    # 3. Unsharp mask — sharpen faint wall edges
    blurred = cv2.GaussianBlur(result, (0, 0), sigmaX=2.0)
    result = cv2.addWeighted(result, 1.5, blurred, -0.5, 0)

    return result
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_enhance.py -v`

Expected: All 10 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd cv-service
git add cv/enhance.py tests/test_enhance.py tests/conftest.py
git commit -m "feat(cv): add image enhancement module with CLAHE, bilateral filter, unsharp mask"
```

---

### Task 2: Update Pydantic model in `app.py`

**Why this comes before pipeline changes:** The pipeline will add `meta.preprocessing` to its output. If Pydantic's `MetaOutput` doesn't have this field, `AnalyzeResponse(**result)` will reject it. Update the model first so app tests pass after pipeline changes.

**Files:**
- Modify: `cv-service/app.py`

- [ ] **Step 1: Add `PreprocessingMeta` model to `app.py`**

In `cv-service/app.py`, add the `PreprocessingMeta` class after the existing `AnalyzeRequest` class (around line 19), and add the field to `MetaOutput`:

```python
class PreprocessingMeta(BaseModel):
    raw_rooms: int
    enhanced_rooms: int
    raw_walls: int
    enhanced_walls: int
    strategy_used: str
```

Then update the existing `MetaOutput` class to add the optional field:

```python
class MetaOutput(BaseModel):
    image_size: tuple[int, int]
    scale_cm_per_px: float
    walls_detected: int
    rooms_detected: int
    text_regions: int
    openings_detected: int = 0
    preprocessing: PreprocessingMeta | None = None
```

- [ ] **Step 2: Run app tests to confirm no regression**

Run: `cd cv-service && python -m pytest tests/test_app.py -v`

Expected: All tests PASS. The field is optional (`None` default), so existing responses without preprocessing metadata still validate.

- [ ] **Step 3: Commit**

```bash
cd cv-service
git add app.py
git commit -m "feat(cv): add PreprocessingMeta to Pydantic response model"
```

---

### Task 3: Add parallel execution to `cv/pipeline.py`

**Files:**
- Modify: `cv-service/cv/pipeline.py`
- Modify: `cv-service/tests/test_pipeline.py`

- [ ] **Step 1: Write failing test for preprocessing metadata**

Add to `cv-service/tests/test_pipeline.py`:

```python
def test_pipeline_includes_preprocessing_metadata(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    assert "preprocessing" in result["meta"]
    pre = result["meta"]["preprocessing"]
    assert "raw_rooms" in pre
    assert "enhanced_rooms" in pre
    assert "raw_walls" in pre
    assert "enhanced_walls" in pre
    assert pre["strategy_used"] in ("raw", "enhanced")


def test_pipeline_preprocessing_raw_wins_tie(simple_2room_path):
    """When raw and enhanced find the same rooms, raw should win.
    The synthetic image has perfect black-on-white contrast, so both
    paths should find 2 rooms — making this a reliable tie scenario."""
    result = analyze_floor_plan(str(simple_2room_path))
    pre = result["meta"]["preprocessing"]
    assert pre["raw_rooms"] == pre["enhanced_rooms"], (
        f"Expected tie on synthetic image, got raw={pre['raw_rooms']} vs enhanced={pre['enhanced_rooms']}"
    )
    assert pre["strategy_used"] == "raw"


def test_pipeline_enhancement_failure_falls_back_to_raw(simple_2room_path, monkeypatch):
    """If enhance() throws, the pipeline should still return raw results."""
    import cv.enhance
    monkeypatch.setattr(cv.enhance, "enhance", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    result = analyze_floor_plan(str(simple_2room_path))
    assert "preprocessing" in result["meta"]
    assert result["meta"]["preprocessing"]["strategy_used"] == "raw"
    assert result["meta"]["preprocessing"]["enhanced_rooms"] == 0
    assert len(result["rooms"]) == 2  # raw still works
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_pipeline.py -v`

Expected: `KeyError: 'preprocessing'` — the field doesn't exist yet.

- [ ] **Step 3: Modify `cv/pipeline.py` to add parallel execution**

Replace the contents of `cv-service/cv/pipeline.py` with:

```python
"""Main pipeline: image → SimpleFloorPlanInput JSON."""
import logging
import math
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from cv.preprocess import prepare, find_floor_plan_bbox
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.ocr import extract_text_regions
from cv.dimensions import parse_dimension
from cv.openings import detect_openings
from cv.topology import detect_adjacency
from cv.output import build_floor_plan_input
from cv.enhance import enhance, pick_winner

log = logging.getLogger(__name__)


def analyze_floor_plan(image_path: str, name: str = "Extracted Floor Plan") -> dict:
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")
    return analyze_image(image, name=name)


def analyze_image(image: np.ndarray, name: str = "Extracted Floor Plan") -> dict:
    """Run raw and enhanced pipelines in parallel, return the better result."""

    def _run_enhanced():
        try:
            # .copy() ensures thread safety — raw and enhanced branches
            # never share the same numpy array in memory
            enhanced_img = enhance(image.copy(), preset="standard")
            return _run_pipeline(enhanced_img, name)
        except Exception as e:
            log.warning(f"Enhancement failed, skipping: {e}")
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        raw_future = pool.submit(_run_pipeline, image, name)
        enhanced_future = pool.submit(_run_enhanced)

        raw_result = raw_future.result()
        enhanced_result = enhanced_future.result()

    if enhanced_result is None:
        winner, strategy = raw_result, "raw"
    else:
        winner, strategy = pick_winner(raw_result, enhanced_result)

    winner["meta"]["preprocessing"] = {
        "raw_rooms": raw_result["meta"]["rooms_detected"],
        "enhanced_rooms": enhanced_result["meta"]["rooms_detected"] if enhanced_result else 0,
        "raw_walls": raw_result["meta"]["walls_detected"],
        "enhanced_walls": enhanced_result["meta"]["walls_detected"] if enhanced_result else 0,
        "strategy_used": strategy,
    }
    log.info(
        "Preprocessing: strategy=%s, raw_rooms=%d, enhanced_rooms=%d",
        strategy,
        raw_result["meta"]["rooms_detected"],
        enhanced_result["meta"]["rooms_detected"] if enhanced_result else 0,
    )
    return winner


def _run_pipeline(image: np.ndarray, name: str) -> dict:
    """Run the full CV pipeline on a single image. Pure function, no side effects."""
    h, w = image.shape[:2]
    binary = prepare(image)
    fp_bbox = find_floor_plan_bbox(binary)
    walls = detect_walls(binary)
    rooms, closed_binary = detect_rooms(binary)
    text_regions = extract_text_regions(image)
    scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))
    openings = detect_openings(binary, closed_binary, rooms, walls, scale)
    adjacency = detect_adjacency(rooms, binary)
    result = build_floor_plan_input(
        rooms=rooms, text_regions=text_regions,
        image_shape=(h, w), scale_cm_per_px=scale, name=name,
        floor_plan_bbox=fp_bbox,
        openings=openings,
        adjacency=adjacency,
    )
    result["meta"] = {
        "image_size": (w, h),
        "scale_cm_per_px": scale,
        "walls_detected": len(walls),
        "rooms_detected": len(rooms),
        "text_regions": len(text_regions),
        "openings_detected": len(openings),
    }
    return result


def _calibrate_scale(walls, text_regions, image_shape):
    """Match dimension labels to their nearest parallel wall and compute scale.

    Strategy: for each dimension text, find the nearest wall that is
    parallel to the dimension's likely orientation.  A horizontal dimension
    label (wider than tall) should match a horizontal wall, and vice versa.
    We use perpendicular distance (not center-to-center) for matching,
    and require the text to fall within the wall's span along the
    parallel axis.
    """
    matches = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is None or cm <= 0:
            continue
        tx, ty = tr["center"]
        tw, th = tr["bbox"][2], tr["bbox"][3]
        label_horizontal = tw >= th

        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)

            if wall_horizontal != label_horizontal:
                continue

            if wall_horizontal:
                wall_y = (sy + ey) / 2
                perp_dist = abs(ty - wall_y)
                wall_min_x = min(sx, ex)
                wall_max_x = max(sx, ex)
                margin = (wall_max_x - wall_min_x) * 0.2
                if tx < wall_min_x - margin or tx > wall_max_x + margin:
                    continue
            else:
                wall_x = (sx + ex) / 2
                perp_dist = abs(tx - wall_x)
                wall_min_y = min(sy, ey)
                wall_max_y = max(sy, ey)
                margin = (wall_max_y - wall_min_y) * 0.2
                if ty < wall_min_y - margin or ty > wall_max_y + margin:
                    continue

            if perp_dist < best_dist:
                best_dist = perp_dist
                best_wall = wall

        max_dist = max(image_shape) * 0.15
        if best_wall is not None and best_dist < max_dist:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            wall_px = math.hypot(ex - sx, ey - sy)
            if wall_px > 10:
                matches.append(cm / wall_px)

    if matches:
        matches.sort()
        return matches[len(matches) // 2]
    return 1000.0 / image_shape[1]
```

Key changes from the original:
- Import `enhance` and `pick_winner` from `cv.enhance`
- Import `logging` and `ThreadPoolExecutor`
- `analyze_image()` now runs raw + enhanced in parallel via `ThreadPoolExecutor(max_workers=2)`
- `image.copy()` in the enhanced branch ensures thread safety — both branches work on separate numpy arrays
- Enhancement failure is caught and falls back to raw-only with logging
- The original pipeline logic is extracted verbatim into `_run_pipeline()`
- `_calibrate_scale()` is unchanged — copied exactly from the original

- [ ] **Step 4: Run ALL pipeline tests to verify they pass (including existing)**

Run: `cd cv-service && python -m pytest tests/test_pipeline.py -v`

Expected: All 5 tests PASS (2 existing + 3 new). The existing tests must pass unchanged — this is the regression check.

- [ ] **Step 5: Run full test suite (including app tests)**

Run: `cd cv-service && python -m pytest tests/ -v`

Expected: All tests PASS, including `test_app.py`. The Pydantic `PreprocessingMeta` model was added in Task 2, so the new `preprocessing` field in pipeline output flows through `AnalyzeResponse(**result)` cleanly.

- [ ] **Step 6: Commit**

```bash
cd cv-service
git add cv/pipeline.py tests/test_pipeline.py
git commit -m "feat(cv): parallel raw+enhanced pipeline with winner selection"
```

---

### Task 4: Update TypeScript `CVResult` type

**Files:**
- Modify: `src/ai/types.ts`

- [ ] **Step 1: Add optional `preprocessing` field to `CVResult.meta`**

In `src/ai/types.ts`, find the `CVResult` interface (around line 68). Add the `preprocessing` field to the `meta` object:

```typescript
export interface CVResult {
  name: string;
  rooms: CVRoom[];
  meta: {
    walls_detected: number;
    rooms_detected: number;
    text_regions: number;
    scale_cm_per_px: number;
    image_size?: [number, number];
    image_width?: number;
    image_height?: number;
    preprocessing?: {
      raw_rooms: number;
      enhanced_rooms: number;
      raw_walls: number;
      enhanced_walls: number;
      strategy_used: string;
    };
  };
}
```

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Run Worker tests**

Run: `npx vitest run`

Expected: All 162 tests PASS. No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/ai/types.ts
git commit -m "feat: add preprocessing metadata to CVResult type"
```

---

### Task 5: Deploy and verify

- [ ] **Step 1: Deploy CV service to Hetzner**

Run: `./cv-service/deploy-hetzner.sh <server-ip>`

The server IP is in the deploy script or `.env`. If unsure, check `CV_SERVICE_URL` in `wrangler.toml` — it points to `http://cv.kworq.com:8100`. Resolve the hostname to get the IP, or ask the user.

Expected: Docker builds successfully, container restarts, health check passes.

- [ ] **Step 2: Verify health endpoint**

Run: `curl http://cv.kworq.com:8100/health`

Expected: `{"status":"ok"}`

- [ ] **Step 3: Deploy Worker**

Run: `./deploy.sh` (from repo root)

Expected: Deployment completes, sync OK, health OK.

- [ ] **Step 4: Test with MCP tool**

Use the `analyze_floor_plan_image` MCP tool with this image URL:
```
https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092
```

This is the "520 W 23rd St, Unit 2C" floor plan that previously detected 0 rooms.

**Check the response for:**
1. `meta.preprocessing` object exists
2. `meta.preprocessing.strategy_used` is either "raw" or "enhanced"
3. `meta.preprocessing.raw_rooms` and `meta.preprocessing.enhanced_rooms` show the comparison
4. Ideally, `enhanced_rooms > raw_rooms` (this validates the whole feature)

- [ ] **Step 5: Test with second floor plan**

Test with: `https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785`

This is "547 W 47 St, Residence 507" which previously found 4 rooms. Verify no regression — should find at least 4 rooms.

- [ ] **Step 6: Commit any fixes and final state**

If any issues were found and fixed during verification, commit them.

```bash
git add -A
git commit -m "feat: CV image preprocessing — parallel raw+enhanced pipeline"
```
