# CV Preprocessing Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/sweep` diagnostic endpoint to the Python CV service that runs 8 preprocessing strategies in parallel and returns all results with debug binary mask images.

**Architecture:** New `cv/strategies.py` module defines 8 strategy functions. New `run_single_strategy()` and `sweep_strategies()` in `cv/pipeline.py` orchestrate parallel execution. New `/sweep` route in `app.py`. Worker gets a thin proxy in `src/index.ts`.

**Tech Stack:** Python, OpenCV, NumPy, FastAPI, ThreadPoolExecutor. TypeScript for Worker proxy.

**Spec:** `docs/superpowers/specs/2026-03-20-cv-preprocessing-sweep-design.md`

---

## Background & Motivation

### System overview

This project is a floor plan analysis pipeline deployed as:
- **Cloudflare Worker** (`src/`) — main MCP server, hosts API routes, orchestrates AI specialists via Workers AI
- **Python CV service** (`cv-service/`) — FastAPI app running on `cv.kworq.com:8100`, does OpenCV-based image analysis (wall detection, room detection, OCR, scale calibration)
- The Worker calls the CV service's `/analyze` endpoint, then runs 4 AI specialists (Room Namer, Layout Describer, Symbol Spotter, Dimension Reader) in parallel, then merges everything

### The preprocessing problem

The CV pipeline converts floor plan images to binary wall masks (walls=255, background=0) using `prepare()` in `cv/preprocess.py`. This binarization is the critical first step — if walls aren't detected here, no rooms get found downstream.

Currently the pipeline runs 2 strategies in parallel (raw + "standard" enhanced) and picks the winner by room count. Testing against real floor plans revealed:

- **Plan 1** (547 W 47th St, `44e71e4b`): Raw found 4 rooms/60 walls, enhanced found 0 rooms/25 walls → raw won
- **Plan 2** (520 W 23rd St, `5f8ac591`): Raw found 0 rooms/7 walls, enhanced found 0 rooms/5 walls → **both failed**

The "standard" enhanced preset (CLAHE + bilateral + unsharp) has never beaten raw on any test image. We need to try fundamentally different approaches to binarization, not just contrast tweaks.

### Why a sweep endpoint (not production changes)

We don't know which strategies work on which image types yet. The sweep endpoint runs all 8 strategies against a single image and returns all results — no winner selection. This lets us build a data-driven understanding of what works before changing production behavior. The debug binary mask images show *why* each strategy succeeded or failed.

### Key codebase patterns to follow

- **Deploy Worker:** Always via `bash deploy.sh` (never wrangler directly)
- **Git commits:** Use `-c commit.gpgsign=false` flag (GPG signing not configured)
- **Test fixtures:** `cv-service/tests/conftest.py` defines `simple_2room_image` (BGR, 600x400, black walls on white, 2 rooms with door gap + dimension text) and `low_contrast_2room_image` (same layout, gray walls on off-white)
- **FastAPI tests:** Use `ASGITransport` + `AsyncClient` with `@pytest.mark.anyio` (see `test_app.py` for pattern)
- **Worker routes:** Inline in `src/index.ts` fetch handler (no router — just `if/else` on `url.pathname`)
- **CV pipeline:** `_run_pipeline()` in `pipeline.py` is the core detection pipeline. `analyze_image()` orchestrates parallel raw+enhanced. New functions go after `_calibrate_scale()`.

### The 8 strategies and their rationale

| # | Strategy | Type | What it attacks |
|---|----------|------|-----------------|
| 1 | `raw` | BGR→prepare() | Baseline. Current production behavior |
| 2 | `enhanced` | BGR→prepare() | Existing CLAHE+bilateral+unsharp. For comparison |
| 3 | `otsu` | Binary direct | Automatic threshold for bimodal histograms. Different binarization path |
| 4 | `adaptive_large` | Binary direct | Large-block adaptive threshold. Handles uneven scan lighting |
| 5 | `invert` | Grayscale→prepare() | Inverts image. Catches light-walls-on-dark-background plans |
| 6 | `canny_dilate` | Binary direct | Edge detection first. May find walls threshold misses |
| 7 | `downscale` | Binary direct | 50% downscale→prepare()→upscale. Thickens thin walls |
| 8 | `heavy_bilateral` | BGR→prepare() | Aggressive smoothing + sharpening. Removes texture noise |

**Two return types:** Strategies return a `StrategyResult(image, is_binary)` namedtuple. If `is_binary=False`, the pipeline runs `prepare()` to binarize. If `is_binary=True`, the binary mask is used directly (skipping `prepare()`). The `invert` strategy is special: returns grayscale (2D) with `is_binary=False` — `prepare()` handles this via its `ndim != 3` branch. The `downscale` strategy is unique: it calls `prepare()` internally (at half resolution) then returns `is_binary=True`.

---

### Task 1: Rename `_filter_components` to public API

Make `_filter_components` a public export so strategies can reuse it.

**Files:**
- Modify: `cv-service/cv/preprocess.py:88-106`

- [ ] **Step 1: Rename `_filter_components` → `filter_components`**

In `cv-service/cv/preprocess.py`, rename the function at line 88 and update the call at line 39:

```python
# Line 39: change
binary = _filter_components(binary, total_pixels)
# to
binary = filter_components(binary, total_pixels)

# Line 88: change
def _filter_components(binary: np.ndarray, total_pixels: int) -> np.ndarray:
# to
def filter_components(binary: np.ndarray, total_pixels: int) -> np.ndarray:
```

- [ ] **Step 2: Run existing tests to verify no breakage**

Run: `cd cv-service && python -m pytest tests/test_preprocess.py tests/test_pipeline.py -v`
Expected: All pass — only a rename of a module-internal function.

- [ ] **Step 3: Commit**

```bash
cd cv-service && git add cv/preprocess.py && git -c commit.gpgsign=false commit -m "refactor: make filter_components public for cross-module use"
```

---

### Task 2: Create strategy registry (`cv/strategies.py`)

8 preprocessing strategy functions, each returns a `StrategyResult` namedtuple.

**Files:**
- Create: `cv-service/cv/strategies.py`
- Test: `cv-service/tests/test_strategies.py`

- [ ] **Step 1: Write the test file**

Create `cv-service/tests/test_strategies.py`:

```python
import numpy as np
import pytest
from cv.strategies import STRATEGIES, StrategyResult


@pytest.fixture
def bgr_image():
    """Simple 400x600 BGR image with black walls on white background."""
    img = np.ones((400, 600, 3), dtype=np.uint8) * 255
    # Outer walls
    img[0:20, :] = 0
    img[380:400, :] = 0
    img[:, 0:20] = 0
    img[:, 580:600] = 0
    # Interior wall
    img[:, 295:305] = 0
    return img


class TestStrategyRegistry:
    def test_has_8_strategies(self):
        assert len(STRATEGIES) == 8

    def test_expected_names(self):
        expected = {"raw", "enhanced", "otsu", "adaptive_large",
                    "invert", "canny_dilate", "downscale", "heavy_bilateral"}
        assert set(STRATEGIES.keys()) == expected


class TestStrategyOutputs:
    @pytest.mark.parametrize("name", list(STRATEGIES.keys()))
    def test_returns_strategy_result(self, name, bgr_image):
        fn = STRATEGIES[name]
        result = fn(bgr_image.copy())
        assert isinstance(result, StrategyResult)
        assert isinstance(result.is_binary, bool)

    @pytest.mark.parametrize("name", ["raw", "enhanced", "heavy_bilateral"])
    def test_bgr_strategies_return_3channel(self, name, bgr_image):
        result = STRATEGIES[name](bgr_image.copy())
        assert result.is_binary is False
        assert result.image.ndim == 3
        assert result.image.shape[2] == 3

    @pytest.mark.parametrize("name", ["otsu", "adaptive_large", "canny_dilate", "downscale"])
    def test_binary_strategies_return_mask(self, name, bgr_image):
        result = STRATEGIES[name](bgr_image.copy())
        assert result.is_binary is True
        assert result.image.ndim == 2
        assert result.image.dtype == np.uint8
        unique = set(np.unique(result.image))
        assert unique <= {0, 255}

    def test_invert_returns_grayscale_non_binary(self, bgr_image):
        result = STRATEGIES["invert"](bgr_image.copy())
        assert result.is_binary is False
        # Grayscale — single channel
        assert result.image.ndim == 2

    def test_all_strategies_preserve_height_width(self, bgr_image):
        h, w = bgr_image.shape[:2]
        for name, fn in STRATEGIES.items():
            result = fn(bgr_image.copy())
            assert result.image.shape[:2] == (h, w), f"{name} changed image dimensions"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_strategies.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'cv.strategies'`

- [ ] **Step 3: Create `cv/strategies.py`**

Create `cv-service/cv/strategies.py`:

```python
"""Preprocessing strategy registry for sweep diagnostic endpoint."""
from typing import NamedTuple

import cv2
import numpy as np

from cv.preprocess import prepare, filter_components
from cv.enhance import enhance as _enhance_standard


class StrategyResult(NamedTuple):
    image: np.ndarray
    is_binary: bool  # True = skip prepare(), False = run prepare()


# ── Strategy functions ────────────────────────────────────────────────


def _raw(image: np.ndarray) -> StrategyResult:
    """Baseline — no preprocessing, let prepare() handle binarization."""
    return StrategyResult(image, is_binary=False)


def _enhanced(image: np.ndarray) -> StrategyResult:
    """Current standard preset: CLAHE + bilateral + unsharp mask."""
    return StrategyResult(_enhance_standard(image, preset="standard"), is_binary=False)


def _otsu(image: np.ndarray) -> StrategyResult:
    """Otsu's automatic threshold — good for bimodal histograms."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _adaptive_large(image: np.ndarray) -> StrategyResult:
    """Adaptive threshold with large block — handles uneven scan lighting."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=51, C=10,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _invert(image: np.ndarray) -> StrategyResult:
    """Invert grayscale — catches light-walls-on-dark-background plans.

    Returns inverted grayscale (2D) with is_binary=False.
    prepare() handles single-channel input via its ndim != 3 branch.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    inverted = 255 - gray
    return StrategyResult(inverted, is_binary=False)


def _canny_dilate(image: np.ndarray) -> StrategyResult:
    """Edge-first approach — Canny edges dilated into wall-width bands."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    edges = cv2.Canny(blurred, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.dilate(edges, kernel, iterations=2)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _downscale(image: np.ndarray) -> StrategyResult:
    """Downscale 50% → binarize → upscale. Thickens thin walls, reduces noise.

    Unique: calls prepare() internally. Returns binary mask with is_binary=True
    so the pipeline does NOT call prepare() again.
    """
    h, w = image.shape[:2]
    small = cv2.resize(image, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    binary_small = prepare(small)
    binary = cv2.resize(binary_small, (w, h), interpolation=cv2.INTER_NEAREST)
    return StrategyResult(binary, is_binary=True)


def _heavy_bilateral(image: np.ndarray) -> StrategyResult:
    """Aggressive bilateral smoothing + strong unsharp mask."""
    result = cv2.bilateralFilter(image, d=15, sigmaColor=150, sigmaSpace=150)
    blurred = cv2.GaussianBlur(result, (0, 0), sigmaX=3.0)
    result = cv2.addWeighted(result, 2.0, blurred, -1.0, 0)
    return StrategyResult(result, is_binary=False)


# ── Registry ──────────────────────────────────────────────────────────

STRATEGIES: dict[str, callable] = {
    "raw": _raw,
    "enhanced": _enhanced,
    "otsu": _otsu,
    "adaptive_large": _adaptive_large,
    "invert": _invert,
    "canny_dilate": _canny_dilate,
    "downscale": _downscale,
    "heavy_bilateral": _heavy_bilateral,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_strategies.py -v`
Expected: All 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd cv-service && git add cv/strategies.py tests/test_strategies.py && git -c commit.gpgsign=false commit -m "feat(cv): add 8 preprocessing strategies for sweep endpoint"
```

---

### Task 3: Add `run_single_strategy` and `sweep_strategies` to pipeline

Wire strategies into the detection pipeline with timing and debug binary capture.

**Files:**
- Modify: `cv-service/cv/pipeline.py` (add two new functions, import `strategies`)
- Test: `cv-service/tests/test_sweep.py`

- [ ] **Step 1: Write the test file**

Create `cv-service/tests/test_sweep.py`:

```python
import base64
import numpy as np
import pytest
from cv.pipeline import run_single_strategy, sweep_strategies
from cv.strategies import STRATEGIES, _raw


class TestRunSingleStrategy:
    def test_returns_expected_fields(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        assert result["strategy"] == "raw"
        assert "debug_binary" in result
        assert "time_ms" in result
        assert isinstance(result["time_ms"], int)
        assert result["time_ms"] >= 0
        assert "rooms" in result
        assert "meta" in result

    def test_debug_binary_is_valid_png(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        png_bytes = base64.b64decode(result["debug_binary"])
        # PNG magic bytes
        assert png_bytes[:4] == b"\x89PNG"

    def test_detects_rooms(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        assert result["meta"]["rooms_detected"] >= 1


class TestSweepStrategies:
    def test_returns_all_8_strategies(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        assert "image_size" in result
        assert "strategies" in result
        assert len(result["strategies"]) == 8

    def test_each_strategy_has_required_fields(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        for s in result["strategies"]:
            assert "strategy" in s
            assert "rooms" in s or "error" in s
            assert "time_ms" in s

    def test_strategy_names_match_registry(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        names = {s["strategy"] for s in result["strategies"]}
        assert names == set(STRATEGIES.keys())

    def test_image_size_correct(self, simple_2room_image):
        h, w = simple_2room_image.shape[:2]
        result = sweep_strategies(simple_2room_image, "Test")
        assert result["image_size"] == (w, h)

    def test_failed_strategy_returns_error_entry(self, simple_2room_image, monkeypatch):
        """When a strategy raises, its entry has error set and sensible defaults."""
        from cv import strategies as strat_mod
        original = dict(strat_mod.STRATEGIES)

        def _boom(image):
            raise RuntimeError("test explosion")

        monkeypatch.setattr(strat_mod, "STRATEGIES", {**original, "raw": _boom})
        result = sweep_strategies(simple_2room_image, "Test")
        raw_entry = next(s for s in result["strategies"] if s["strategy"] == "raw")
        assert raw_entry["error"] is not None
        assert "test explosion" in raw_entry["error"]
        assert raw_entry["meta"]["rooms_detected"] == 0
        assert raw_entry["meta"]["walls_detected"] == 0
        assert raw_entry["debug_binary"] == ""
        assert raw_entry["rooms"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_sweep.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_single_strategy' from 'cv.pipeline'`

- [ ] **Step 3: Add `run_single_strategy` and `sweep_strategies` to `cv/pipeline.py`**

Add these imports at the top of `cv-service/cv/pipeline.py` (after existing imports at line 18).
Note: `ThreadPoolExecutor` is already imported at line 4 — do NOT add it again.

```python
import base64
import time
from cv.strategies import STRATEGIES, StrategyResult
```

Add these two functions at the end of the file (after `_calibrate_scale`):

```python
def run_single_strategy(
    image: np.ndarray,
    plan_name: str,
    strategy_name: str,
    strategy_fn,
) -> dict:
    """Run one preprocessing strategy through the full CV pipeline.

    Returns the standard pipeline result dict plus:
    - strategy: name of the strategy used
    - debug_binary: base64-encoded PNG of the binary wall mask
    - time_ms: wall-clock time in milliseconds
    """
    start = time.monotonic()
    try:
        h, w = image.shape[:2]
        sr: StrategyResult = strategy_fn(image.copy())

        if sr.is_binary:
            binary = sr.image
        else:
            binary = prepare(sr.image)

        # Capture binary mask as debug PNG
        _, png_buf = cv2.imencode(".png", binary)
        debug_binary = base64.b64encode(png_buf.tobytes()).decode()

        fp_bbox = find_floor_plan_bbox(binary)
        walls = detect_walls(binary)
        rooms, closed_binary = detect_rooms(binary)
        # OCR needs the original color image, not the preprocessed one
        text_regions = extract_text_regions(image)
        scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))
        openings = detect_openings(binary, closed_binary, rooms, walls, scale)
        adjacency = detect_adjacency(rooms, binary)

        result = build_floor_plan_input(
            rooms=rooms, text_regions=text_regions,
            image_shape=(h, w), scale_cm_per_px=scale, name=plan_name,
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
        result["strategy"] = strategy_name
        result["debug_binary"] = debug_binary
        result["time_ms"] = int((time.monotonic() - start) * 1000)
        return result

    except Exception as e:
        elapsed = int((time.monotonic() - start) * 1000)
        log.warning("Strategy %s failed: %s", strategy_name, e)
        return {
            "strategy": strategy_name,
            "name": plan_name,
            "rooms": [],
            "openings": [],
            "adjacency": [],
            "meta": {
                "image_size": (image.shape[1], image.shape[0]),
                "scale_cm_per_px": 0.0,
                "walls_detected": 0,
                "rooms_detected": 0,
                "text_regions": 0,
                "openings_detected": 0,
            },
            "debug_binary": "",
            "time_ms": elapsed,
            "error": str(e),
        }


def sweep_strategies(image: np.ndarray, plan_name: str) -> dict:
    """Run all registered strategies in parallel, return all results."""
    h, w = image.shape[:2]

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            name: pool.submit(run_single_strategy, image, plan_name, name, fn)
            for name, fn in STRATEGIES.items()
        }
        results = []
        for name, future in futures.items():
            try:
                results.append(future.result(timeout=10))
            except Exception as e:
                log.warning("Strategy %s timed out or crashed: %s", name, e)
                results.append({
                    "strategy": name,
                    "name": plan_name,
                    "rooms": [],
                    "openings": [],
                    "adjacency": [],
                    "meta": {
                        "image_size": (w, h),
                        "scale_cm_per_px": 0.0,
                        "walls_detected": 0,
                        "rooms_detected": 0,
                        "text_regions": 0,
                        "openings_detected": 0,
                    },
                    "debug_binary": "",
                    "time_ms": 0,
                    "error": f"Timed out or crashed: {e}",
                })

    return {"image_size": (w, h), "strategies": results}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cv-service && python -m pytest tests/test_sweep.py tests/test_pipeline.py -v`
Expected: All pass (new tests + existing pipeline tests unbroken).

- [ ] **Step 5: Commit**

```bash
cd cv-service && git add cv/pipeline.py tests/test_sweep.py && git -c commit.gpgsign=false commit -m "feat(cv): add run_single_strategy and sweep_strategies for parallel preprocessing sweep"
```

---

### Task 4: Add `/sweep` endpoint to FastAPI app

**Files:**
- Modify: `cv-service/app.py`
- Test: `cv-service/tests/test_app.py` (add sweep test)

- [ ] **Step 1: Write the test**

Append to `cv-service/tests/test_app.py`:

```python
@pytest.mark.anyio
async def test_sweep_endpoint(b64_simple_image):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/sweep", json={
            "image": b64_simple_image,
            "name": "Sweep Test",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert "image_size" in data
    assert "strategies" in data
    assert len(data["strategies"]) == 8
    # Each strategy has required fields
    for s in data["strategies"]:
        assert "strategy" in s
        assert "time_ms" in s
        assert "meta" in s


@pytest.mark.anyio
async def test_sweep_rejects_missing_image():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/sweep", json={"name": "No Image"})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cv-service && python -m pytest tests/test_app.py::test_sweep_endpoint -v`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Add `/sweep` route to `app.py`**

Add the import at the top of `cv-service/app.py` (line 8, alongside existing import):

```python
from cv.pipeline import analyze_image, sweep_strategies
```

Add the Pydantic models after `AnalyzeResponse` (after line 44):

```python
class SweepRequest(BaseModel):
    image: str | None = Field(default=None, description="Base64-encoded PNG/JPG image")
    image_url: str | None = Field(default=None, description="URL to fetch the image from")
    name: str = Field(default="Extracted Floor Plan")

class StrategyResultOutput(BaseModel):
    strategy: str
    name: str
    rooms: list[dict] = []
    openings: list[dict] = []
    adjacency: list[dict] = []
    meta: dict = {}
    debug_binary: str = ""
    time_ms: int = 0
    error: str | None = None

class SweepResponse(BaseModel):
    image_size: tuple[int, int]
    strategies: list[StrategyResultOutput]
```

Add the route after the `/analyze` route (after line 79):

```python
@app.post("/sweep")
def sweep(req: SweepRequest) -> SweepResponse:
    if req.image:
        try:
            raw = base64.b64decode(req.image)
        except Exception:
            raise HTTPException(400, "Invalid base64 image data")
    elif req.image_url:
        try:
            resp = httpx.get(req.image_url, follow_redirects=True, timeout=15.0)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Failed to fetch image from URL: {e}")
        content_type = resp.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            raise HTTPException(400, f"URL did not return an image (content-type: {content_type})")
        raw = resp.content
    else:
        raise HTTPException(400, "Provide either 'image' (base64) or 'image_url'")

    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "Could not decode image (not a valid PNG/JPG)")
    try:
        result = sweep_strategies(image, plan_name=req.name)
    except Exception as e:
        log.exception("Sweep failed")
        raise HTTPException(500, f"Sweep failed: {e}")
    return result
```

- [ ] **Step 4: Run all app tests**

Run: `cd cv-service && python -m pytest tests/test_app.py -v`
Expected: All pass (existing + new sweep tests).

- [ ] **Step 5: Commit**

```bash
cd cv-service && git add app.py tests/test_app.py && git -c commit.gpgsign=false commit -m "feat(cv): add /sweep endpoint for preprocessing strategy comparison"
```

---

### Task 5: Add Worker proxy route

**Files:**
- Modify: `src/index.ts:841` (after the `/api/images/:id` block, before health check)

- [ ] **Step 1: Add proxy route**

In `src/index.ts`, add after line 841 (after the closing `}` of the `/api/images/:id` block, before the `// Health check` comment):

```typescript
    // Sweep endpoint — proxy to CV service for preprocessing strategy comparison
    if (url.pathname === '/api/cv/sweep' && request.method === 'POST') {
      const cvUrl = env.CV_SERVICE_URL || 'http://localhost:8100';
      const resp = await fetch(`${cvUrl}/sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
```

- [ ] **Step 2: Run Worker tests to check for compilation**

Run: `npx vitest run 2>&1 | tail -20`
Expected: All existing tests pass. The proxy route is a simple pass-through, no unit test needed.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts && git -c commit.gpgsign=false commit -m "feat: add /api/cv/sweep proxy route to Worker"
```

---

### Task 6: Run full test suite and deploy

- [ ] **Step 1: Run all Python CV tests**

Run: `cd cv-service && python -m pytest -v`
Expected: All pass.

- [ ] **Step 2: Run all Worker tests**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 3: Deploy CV service**

The CV service runs on `cv.kworq.com:8100`. Deploy per your usual process (likely restart the service on the server).

- [ ] **Step 4: Deploy Worker**

Run: `bash deploy.sh`
Expected: Deployment succeeds.

- [ ] **Step 5: Smoke test — run sweep against test image via curl**

```bash
curl -s -X POST https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/cv/sweep \
  -H 'Content-Type: application/json' \
  -d '{"image_url": "https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785", "name": "547 W 47th St"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{s[\"strategy\"]:20s} rooms={s[\"meta\"][\"rooms_detected\"]:2d}  walls={s[\"meta\"][\"walls_detected\"]:3d}  time={s[\"time_ms\"]}ms') for s in d['strategies']]"
```

Expected: 8 rows, one per strategy, with varying room/wall counts.

- [ ] **Step 6: Run sweep against second test image**

```bash
curl -s -X POST https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/cv/sweep \
  -H 'Content-Type: application/json' \
  -d '{"image_url": "https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/5f8ac591-f5f1-4bb1-a655-36ee1012c092", "name": "520 W 23rd St"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{s[\"strategy\"]:20s} rooms={s[\"meta\"][\"rooms_detected\"]:2d}  walls={s[\"meta\"][\"walls_detected\"]:3d}  time={s[\"time_ms\"]}ms') for s in d['strategies']]"
```

Expected: 8 rows. This is the image where raw found 0 rooms — we're looking for any strategy that finds > 0.

- [ ] **Step 7: Commit any final fixes**

If smoke tests revealed issues, fix and commit. Otherwise, done.
