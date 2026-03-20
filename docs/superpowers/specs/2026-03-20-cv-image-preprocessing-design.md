# CV Image Preprocessing — Design Spec

## Problem

The CV service (`cv-service/`) detects rooms using morphological operations on binarized images. Many real-world floor plan images are low-contrast, faded, or have thin lines that the current `prepare()` function in `cv/preprocess.py` fails to binarize cleanly. This leads to missed walls, merged rooms, and 0-room results on otherwise readable floor plans.

Example: Floor plan "520 W 23rd St, Unit 2C" — CV detected 0 rooms and 7 walls. The AI specialists found all 9 rooms from the same image.

## Solution

Run the existing CV pipeline on **both the raw image and an enhanced version in parallel**, compare results, and return the winner. All processing happens on the Hetzner CV server — no Worker changes needed.

## Design

### New module: `cv/enhance.py`

A single `enhance()` function that applies a preset of OpenCV operations to improve wall/line visibility.

**Default preset (`standard`):**

1. **CLAHE** (Contrast Limited Adaptive Histogram Equalization) — boosts local contrast without blowing out highlights. `clipLimit=3.0`, `tileGridSize=(8,8)`.
2. **Bilateral filter** — reduces noise while preserving edges (wall lines). `d=9, sigmaColor=75, sigmaSpace=75`.
3. **Unsharp mask** — sharpens faint wall edges. Gaussian blur then weighted subtract.

All standard OpenCV ops. No new dependencies.

**Color space handling:** `enhance()` takes a BGR image (same as `analyze_image` receives). CLAHE is applied to the L channel of LAB color space (convert BGR→LAB, CLAHE on L, convert back to BGR). Bilateral filter and unsharp mask operate on the BGR result. Returns BGR. This preserves color information that `extract_text_regions` (OCR) uses.

**Preset parameter:** `enhance(image, preset="standard")` so additional presets (e.g. `aggressive`) can be added later without restructuring. The aggressive preset is not built now — we'll tune it after collecting data from the standard preset.

### Changes to `cv/pipeline.py`

The `analyze_image()` function gains parallel execution:

```python
def analyze_image(image, name="Extracted Floor Plan"):
    def _run_enhanced():
        try:
            enhanced_img = enhance(image, preset="standard")
            return _run_pipeline(enhanced_img, name)
        except Exception as e:
            log.warning(f"Enhancement failed, skipping: {e}")
            return None

    # Run raw and enhanced pipelines fully in parallel
    with ThreadPoolExecutor(max_workers=2) as pool:
        raw_future = pool.submit(_run_pipeline, image, name)
        enhanced_future = pool.submit(_run_enhanced)

        raw_result = raw_future.result()
        enhanced_result = enhanced_future.result()

    # Pick winner and annotate metadata
    if enhanced_result is None:
        winner, strategy = raw_result, "raw"
    else:
        winner, strategy = pick_winner(raw_result, enhanced_result)

    winner["meta"]["preprocessing"] = {
        "raw_rooms": raw_result["meta"]["rooms_detected"],
        "enhanced_rooms": enhanced_result["meta"]["rooms_detected"] if enhanced_result else 0,
        "raw_walls": raw_result["meta"]["walls_detected"],
        "enhanced_walls": enhanced_result["meta"]["walls_detected"] if enhanced_result else 0,
        "strategy_used": strategy,  # "raw" | "enhanced"
    }
    log.info(f"Preprocessing: strategy={strategy}, raw_rooms={raw_result['meta']['rooms_detected']}, "
             f"enhanced_rooms={enhanced_result['meta']['rooms_detected'] if enhanced_result else 0}")
    return winner
```

The existing pipeline logic is extracted into `_run_pipeline(image, name)` — a pure function that takes an image and returns the result dict. No behavior change to the existing pipeline.

### Winner selection: `pick_winner()`

```python
def pick_winner(raw_result, enhanced_result):
    raw_rooms = raw_result["meta"]["rooms_detected"]
    enhanced_rooms = enhanced_result["meta"]["rooms_detected"]

    # More rooms wins
    if enhanced_rooms > raw_rooms:
        return enhanced_result, "enhanced"
    if raw_rooms > enhanced_rooms:
        return raw_result, "raw"

    # Tie: prefer raw (no regression risk)
    return raw_result, "raw"
```

Simple room count comparison. On tie, raw wins (conservative — preprocessing didn't help, so don't risk degrading geometry quality). Future refinement could add total polygon area or wall count as secondary tie-breakers.

### Response format changes

The existing `MetaOutput` gains one optional field:

```python
class PreprocessingMeta(BaseModel):
    raw_rooms: int
    enhanced_rooms: int
    raw_walls: int
    enhanced_walls: int
    strategy_used: str  # "raw" | "enhanced"

class MetaOutput(BaseModel):
    # ... existing fields unchanged ...
    preprocessing: PreprocessingMeta | None = None
```

The Worker receives this transparently — no Worker logic changes. The `CVResult` type in `src/ai/types.ts` should add `preprocessing?: { raw_rooms: number; enhanced_rooms: number; raw_walls: number; enhanced_walls: number; strategy_used: string }` to `meta` for type completeness, even though no code reads it yet.

### Performance

- `enhance()` is ~50-100ms for a typical floor plan image (CLAHE + bilateral + sharpen)
- Both pipelines run fully in parallel via `ThreadPoolExecutor` — `enhance()` + its pipeline run inside the thread, so total latency increase is near zero vs the single-pipeline baseline
- Memory: two full pipeline branches run concurrently. Each branch holds the image plus binary masks, contours, etc. — peak ~60-120MB for a large floor plan. Well within Hetzner server capacity.

## Future: AI-triggered re-process

Not built now, but the architecture supports it:

1. Worker runs CV + AI specialists in parallel (existing behavior)
2. Worker compares `cv.meta.rooms_detected` vs AI room count
3. If gap is large (AI found 3+ more rooms), Worker calls `POST /analyze?preset=aggressive`
4. CV server runs pipeline with heavier preprocessing
5. Worker merges the better CV result with AI data

This requires:
- Adding an `aggressive` preset to `enhance()` (stronger CLAHE, adaptive threshold, morphological dilation)
- Adding a `preset` query parameter to the `/analyze` endpoint
- Worker-side logic to detect the gap and make the second call

The re-process adds ~1-3s latency (another CV round-trip). The Worker's existing timeout budget (30s for CV) accommodates this.

We'll build this after collecting preprocessing metadata from real floor plans to understand where the standard preset falls short.

## Files changed

| File | Change |
|------|--------|
| `cv-service/cv/enhance.py` | **New** — `enhance(image, preset)` function |
| `cv-service/cv/pipeline.py` | Extract `_run_pipeline()`, add parallel execution, add `pick_winner()` |
| `cv-service/app.py` | Add `PreprocessingMeta` model to `MetaOutput` |
| `cv-service/cv/preprocess.py` | No changes (existing `prepare()` untouched) |
| `cv-service/tests/test_enhance.py` | **New** — tests for enhance presets |
| `cv-service/tests/test_pipeline.py` | Add tests for parallel execution and winner selection |

## Testing

1. **Unit tests for `enhance()`** — verify CLAHE/bilateral/sharpen produce different pixel values than input
2. **Unit tests for `pick_winner()`** — verify selection logic (more rooms wins, ties go to raw)
3. **Integration test** — run `analyze_image()` on a test fixture, verify `preprocessing` metadata is present in response
4. **Regression test** — run on existing test fixtures, verify raw results are unchanged when raw wins
5. **Existing test regression** — all existing tests in `test_pipeline.py` must pass unchanged (parallel execution is transparent to callers)
6. **Manual verification** — test with the two known floor plan images to see if enhanced finds more rooms
