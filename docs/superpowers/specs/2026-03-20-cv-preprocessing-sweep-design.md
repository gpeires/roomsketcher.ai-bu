# CV Preprocessing Sweep Endpoint

**Date:** 2026-03-20
**Status:** Draft

## Problem

The current CV preprocessing pipeline runs two strategies (raw + "standard" enhanced) and picks the winner by room count. On our two test images, enhanced lost both times (0 rooms vs 4 raw on Plan 1, 0 vs 0 on Plan 2). We have no visibility into what *could* work because we only try one enhancement preset.

We need a diagnostic tool that runs many preprocessing strategies in parallel and returns all results side-by-side — with debug images — so we can identify which strategies work on which image types before committing to a production configuration.

## Goals

1. Run 8 preprocessing strategies against a single image in parallel
2. Return full CV results + binary wall mask debug images for each strategy
3. Zero impact on the production `/analyze` pipeline
4. Fast enough for interactive use (< 15s for all 8 strategies)

## Non-Goals

- Winner selection or automatic strategy picking (that comes later, informed by sweep data)
- Changes to the production pipeline or merge layer
- HTML visualization (JSON + base64 PNGs; viewer can be built separately)

## Architecture

### New files

| File | Purpose |
|------|---------|
| `cv-service/cv/strategies.py` | Registry of 8 preprocessing strategy functions |
| `cv-service/tests/test_strategies.py` | Unit tests for strategy functions |
| `cv-service/tests/test_sweep.py` | Integration tests for `/sweep` endpoint |

### Modified files

| File | Change |
|------|--------|
| `cv-service/cv/pipeline.py` | Add `run_single_strategy()` that runs one strategy through the pipeline and captures the binary mask |
| `cv-service/app.py` | Add `POST /sweep` route |
| `src/index.ts` (Worker) | Add proxy route `POST /api/cv/sweep` inline alongside existing `/api/upload-image` and `/api/images/:id` routes |

### Unchanged files

- `cv/preprocess.py` — `prepare()` is reused as-is by BGR-output strategies
- `cv/enhance.py` — `_preset_standard` is reused as the "enhanced" strategy
- `cv/walls.py`, `cv/rooms.py`, `cv/openings.py`, `cv/topology.py` — detection modules unchanged
- `src/ai/*` — merge/AI layer untouched

## Strategy Registry (`cv/strategies.py`)

Each strategy is a function that takes a BGR `np.ndarray` and returns either:
- A **BGR image** (will be fed through `prepare()` for binarization), or
- A **binary mask** (walls=255, background=0; skips `prepare()`)

The return type is distinguished by a `StrategyResult` namedtuple:

```python
class StrategyResult(NamedTuple):
    image: np.ndarray
    is_binary: bool  # True = skip prepare(), False = run prepare()
```

### Strategy definitions

#### 1. `raw` (baseline)
- Returns the input image unchanged as BGR
- `prepare()` runs its normal threshold + edge fallback
- This is the current production behavior

#### 2. `enhanced` (current preset)
- Reuses `_preset_standard` from `cv/enhance.py`: CLAHE (`clipLimit=3.0, tileGrid=8x8`) on LAB L-channel + bilateral filter (`d=9, sigma=75`) + unsharp mask (`1.5x - 0.5x blurred`)
- Returns BGR → `prepare()` binarizes

#### 3. `otsu`
- Convert to grayscale, Gaussian blur (`5x5, sigma=1.5`)
- `cv2.threshold(blurred, 0, 255, THRESH_BINARY_INV + THRESH_OTSU)`
- Morphological close (`3x3, iterations=2`)
- Component filtering (reuse `_filter_components` from `preprocess.py`)
- Returns binary mask directly

#### 4. `adaptive_large`
- Convert to grayscale
- `cv2.adaptiveThreshold(gray, 255, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY_INV, blockSize=51, C=10)`
- Morphological close (`3x3, iterations=2`)
- Component filtering
- Returns binary mask directly
- **Rationale:** Large block size handles uneven lighting from scanning/photography

#### 5. `invert`
- Convert to grayscale, invert (`255 - gray`)
- Return the inverted grayscale as-is with `is_binary=False`; `prepare()` handles single-channel input (its `ndim != 3` branch copies the array directly)
- **Rationale:** Catches light-walls-on-dark-background plans

#### 6. `canny_dilate`
- Convert to grayscale, Gaussian blur (`5x5, sigma=1.5`)
- `cv2.Canny(blurred, 30, 100)` — lower thresholds than the edge pass in `prepare()` to catch faint walls
- `cv2.dilate(edges, 3x3, iterations=2)` — thicken edges into wall-width bands
- `cv2.morphologyEx(MORPH_CLOSE, 5x5, iterations=2)` — bridge gaps
- Component filtering
- Returns binary mask directly
- **Rationale:** Edge-first approach; may find rooms that threshold-based methods miss

#### 7. `downscale`
- Resize image to 50% with `cv2.INTER_AREA`
- Run through `prepare()` internally to get binary mask at half resolution (unique among strategies — calls `prepare()` inside the strategy function rather than having it called externally)
- Resize binary mask back to original size with `cv2.INTER_NEAREST`
- Returns binary mask directly (`is_binary=True`, so `prepare()` is NOT called again by the pipeline)
- **Rationale:** Thin walls become proportionally thicker at lower resolution; noise is reduced

#### 8. `heavy_bilateral`
- `cv2.bilateralFilter(image, d=15, sigmaColor=150, sigmaSpace=150)` — aggressive smoothing
- Unsharp mask with stronger parameters: `2.0x - 1.0x blurred` (Gaussian `sigmaX=3.0`)
- Returns BGR → `prepare()` binarizes
- **Rationale:** Smooths out texture noise (hatching, furniture detail) while preserving wall edges

### Shared utilities

Strategies that return binary masks need `_filter_components` from `preprocess.py`. Rename it to `filter_components` (drop the underscore) to make it a proper public export, since it's now used across modules. Update the single internal call site in `preprocess.py` to match.

## Pipeline Integration (`cv/pipeline.py`)

New function:

```python
def run_single_strategy(
    image: np.ndarray,
    plan_name: str,
    strategy_name: str,
    strategy_fn: Callable,
) -> dict:
    """Run one preprocessing strategy through the full CV pipeline.

    Returns the standard pipeline result dict plus:
    - debug_binary: base64-encoded PNG of the binary wall mask
    - strategy: name of the strategy used
    - time_ms: wall-clock time for this strategy
    """
```

Implementation:
1. Start timer
2. Call `strategy_fn(image.copy())` → get `StrategyResult`
3. If `is_binary=False`: run `prepare()` to get binary mask
4. If `is_binary=True`: use returned mask directly
5. Encode binary mask as PNG → base64 string (`debug_binary`)
6. Run rest of pipeline: `find_floor_plan_bbox`, `detect_walls`, `detect_rooms`, `extract_text_regions`, `_calibrate_scale`, `detect_openings`, `detect_adjacency`, `build_floor_plan_input`
7. Stop timer
8. Return result dict with `strategy`, `debug_binary`, `time_ms` added

The existing `_run_pipeline()` is not modified. `run_single_strategy` extracts the shared detection logic into calls that mirror `_run_pipeline` but add the binary capture and timing.

## Sweep Orchestration

New function in `cv/pipeline.py`:

```python
def sweep_strategies(image: np.ndarray, name: str) -> dict:
    """Run all registered strategies in parallel, return all results."""
```

Implementation:
1. Import `STRATEGIES` from `cv.strategies`
2. Use `ThreadPoolExecutor(max_workers=8)` to run `run_single_strategy` for each
3. Collect all results (failed strategies get an error entry, not an exception)
4. Return `{"image_size": [w, h], "strategies": [...]}`

## API Endpoint (`cv-service/app.py`)

### Request

```python
class SweepRequest(BaseModel):
    image: str | None = Field(default=None, description="Base64-encoded PNG/JPG image")
    image_url: str | None = Field(default=None, description="URL to fetch the image from")
    name: str = Field(default="Extracted Floor Plan")
```

Same as `AnalyzeRequest` — identical image input.

### Response

```python
class StrategyResultOutput(BaseModel):
    name: str
    rooms_detected: int
    walls_detected: int
    openings_detected: int
    scale_cm_per_px: float
    rooms: list[dict]
    openings: list[dict]
    time_ms: int
    debug_binary: str  # base64 PNG of binary wall mask
    error: str | None = None

class SweepResponse(BaseModel):
    image_size: tuple[int, int]
    strategies: list[StrategyResultOutput]
```

### Route

```python
@app.post("/sweep")
def sweep(req: SweepRequest) -> SweepResponse:
    # Same image decoding as /analyze
    # Call sweep_strategies(image, req.name)
    # Return SweepResponse
```

### Error handling

If a single strategy fails (exception in OpenCV, etc.), it returns an entry with `error` set and sensible defaults: `rooms_detected=0`, `walls_detected=0`, `openings_detected=0`, `scale_cm_per_px=0.0`, `rooms=[]`, `openings=[]`, `debug_binary=""`, `time_ms` set to elapsed time before failure. The sweep never fails entirely — partial results are always returned.

### Per-strategy timeout

Each strategy future gets a 10-second timeout via `future.result(timeout=10)`. If a strategy hangs, it is recorded as failed with `error="Timed out after 10s"` and the sweep continues.

## Worker Proxy (`src/index.ts`)

Add an inline route in the Worker's `fetch` handler (alongside existing `/api/upload-image` and `/api/images/:id`):

```typescript
// POST /api/cv/sweep → forwards request body to CV_SERVICE_URL/sweep, returns response
if (url.pathname === '/api/cv/sweep' && request.method === 'POST') {
  const resp = await fetch(`${env.CV_SERVICE_URL}/sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: request.body,
  });
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}
```

No transformation needed. Diagnostic-only, no additional auth beyond what's already on the Worker.

## Testing

### Unit tests (`test_strategies.py`)

For each strategy function:
- Input: a synthetic BGR image (white background, black rectangle walls)
- Assert: returns `StrategyResult` with correct `is_binary` flag
- Assert: output shape matches input shape (or half for downscale before upscale)
- Assert: binary outputs have dtype `uint8` with only 0/255 values

### Integration tests (`test_sweep.py`)

- `POST /sweep` with a test image returns 8 strategy entries
- Each entry has `name`, `rooms_detected`, `walls_detected`, `debug_binary`, `time_ms`
- `debug_binary` is valid base64 that decodes to a PNG
- Failed strategies have `error` set, others have `error: null`

### Manual validation

Run against our two test images:
- `44e71e4b` (547 W 47th St) — baseline: 4 rooms, 60 walls from raw
- `5f8ac591` (520 W 23rd St) — baseline: 0 rooms, 7 walls from raw

Compare room counts across all 8 strategies. Inspect binary masks for strategies that find more rooms to understand why.

## Performance

Each strategy runs the full pipeline (~200-400ms per strategy). With 8 strategies in parallel, expect ~1-3 seconds total wall-clock time. OpenCV releases the GIL for most heavy operations, but Python-level loops in `filter_components` and room detection hold the GIL briefly — realistic expectation is 2-4x single-strategy time, not 1x.

Start with `ThreadPoolExecutor` since it works for the existing 2-strategy pipeline. If GIL contention is worse than expected, switch to `ProcessPoolExecutor`.

## Future Work

Once sweep data reveals which strategies work on which image types:
1. Build a smarter `pick_winner` that runs top-2-3 strategies instead of all 8
2. Add image classification (scan vs render, dark walls vs light walls) to predict the best strategy
3. Consider making strategies composable (e.g., downscale + adaptive_large)
