# CV Pipeline Quality Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 highest-impact CV pipeline quality issues: garbage labels, ghost rooms, scale calibration failures, wall thickness capping, and dimension text leaking into room names.

**Architecture:** All changes are in the Python CV service (`cv-service/cv/`). Each fix is isolated to 1-2 files with clear test coverage. No TypeScript changes needed — the TS layer already passes through whatever CV produces.

**Tech Stack:** Python 3.11, OpenCV, Tesseract OCR, pytest

**Test command:** `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/ -v`

---

## File Map

| File | Responsibility | Tasks |
|------|---------------|-------|
| `cv-service/cv/output.py` | Label assignment, room output formatting | 1, 2 |
| `cv-service/cv/dimensions.py` | Dimension string parsing | 1 |
| `cv-service/cv/merge.py` | Room clustering, filtering, structural detection | 3, 4 |
| `cv-service/cv/pipeline.py` | Scale calibration, strategy orchestration | 5 |
| `cv-service/tests/test_output.py` | Label and output tests | 1, 2 |
| `cv-service/tests/test_merge.py` | Merge pipeline tests | 3, 4 |
| `cv-service/tests/test_pipeline.py` | Scale calibration tests | 5 |

---

### Task 1: Filter dimension text from room labels

**Problem:** OCR-detected dimension strings like `14°4"`, `8-7"`, `5'9"` are being assigned as room labels. The `_DIM_LIKE` regex (output.py:18-20) catches some patterns, but misses imperial formats with degree symbols, dashes, and other OCR artifacts.

**Root cause:** `_DIM_LIKE` only matches strings *starting* with digits followed by `'`, `"`, `.`. OCR often garbles `'` into `°`, `-` into `—`, or produces fragments like `8-7"` that don't match. Also, `_is_room_label` (output.py:271-287) accepts any title-case 4+ char word — this lets through garbage like "COMPASS", "Shore", "Brooklyn".

**Files:**
- Modify: `cv-service/cv/output.py:17-20` (_DIM_LIKE regex), `cv-service/cv/output.py:43-60` (label filtering), `cv-service/cv/output.py:271-287` (_is_room_label)
- Test: `cv-service/tests/test_output.py`

- [ ] **Step 1: Write failing tests for dimension-like label filtering**

Add to `tests/test_output.py`:

```python
import pytest
from cv.output import _is_room_label, _DIM_LIKE


class TestDimensionFiltering:
    """Dimension text and OCR garbage must not become room labels."""

    @pytest.mark.parametrize("text", [
        "14°4\"",       # OCR-garbled imperial
        "8-7\"",        # partial imperial
        "5'9\"",        # clean imperial
        "10'2\"",       # clean imperial
        "11'11\"",      # clean imperial
        "3.00m",        # metric
        "3.50",         # bare metric
        "x",            # separator
        "×",            # separator
        "P",            # single letter (OCR noise)
        "DW",           # fixture abbreviation
        "Ref",          # fixture abbreviation
        "W/D",          # fixture abbreviation
        "LC",           # fixture abbreviation
    ])
    def test_dim_like_rejects_noise(self, text):
        assert not _is_room_label(text), f"Should reject: {text!r}"

    @pytest.mark.parametrize("text", [
        "COMPASS",      # logo text (all-caps non-room word)
        "Hanna",        # person name (in _LOGO_WORDS)
        "9511",         # house number (pure digits)
    ])
    def test_rejects_non_room_proper_nouns(self, text):
        assert not _is_room_label(text), f"Should reject: {text!r}"

    @pytest.mark.parametrize("text", [
        "Kitchen",
        "Living Room",
        "Primary Bedroom",
        "Bath",
        "Foyer",
        "Hall",
        "Dining Room",
        "Dressing Area",
        "WIC",
        "CL",
        "Walk-in",
        "Living / Dining",
        "Living & Dining",
    ])
    def test_accepts_valid_room_labels(self, text):
        assert _is_room_label(text), f"Should accept: {text!r}"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_output.py::TestDimensionFiltering -v`

Expected: Several FAIL — "COMPASS", "Brooklyn", "CL", "DW" etc. currently pass `_is_room_label`.

- [ ] **Step 3: Improve _DIM_LIKE regex and _is_room_label**

In `cv-service/cv/output.py`, make these changes:

1. Expand `_DIM_LIKE` to catch OCR-garbled dimensions (line 18-20):

```python
# Regex for things that look like dimensions/coordinates, not labels
_DIM_LIKE = re.compile(
    r"^\d+[\.\',\"°x×\-]"   # starts with digits + punctuation
    r"|^[x×]$"               # bare separator
    r"|^\d+$"                # pure digits
    r"|^[a-zA-Z]$"           # single letter
    r"|^[\W]+$"              # non-word only
    r"|^\d+\s*[\-]\s*\d+"    # digit-dash-digit (e.g. "8-7")
    r"|\d+['\u2019\u2032°]"  # contains feet mark or degree (OCR garble)
    r'|\d+["\u201d\u2033]'   # contains inch mark
)
```

2. Add a fixture/abbreviation blocklist and tighten `_is_room_label` (after line 15):

```python
# Common fixture abbreviations and non-room text that OCR detects.
# Do NOT include room abbreviations here (CL=closet, WIC=walk-in closet).
_FIXTURE_ABBREVS = {
    "dw", "ref", "w/d", "wd", "lc", "p", "ac",
}

# Known non-room proper nouns (logos, brands, brokerage names)
_LOGO_WORDS = {
    "compass", "douglas", "elliman", "corcoran", "halstead",
    "sotheby", "streeteasy", "zillow", "redfin", "howard", "hanna",
}
```

3. Rewrite `_is_room_label` to be stricter:

```python
def _is_room_label(text: str) -> bool:
    """Check if text looks like a room label rather than noise."""
    t = text.strip()
    if len(t) < 2:
        return False
    low = t.lower()

    # Reject fixture abbreviations
    if low in _FIXTURE_ABBREVS:
        return False

    # Reject if any word is a known logo/brand
    words = low.split()
    if any(w in _LOGO_WORDS for w in words):
        return False

    # Reject dimension-like text
    if _DIM_LIKE.match(t):
        return False

    # Known room words — accept
    if low in _ROOM_WORDS:
        return True
    if any(w in _ROOM_WORDS for w in words):
        return True

    # Multi-word with separator (e.g. "Living / Dining", "Living & Dining")
    parts = re.split(r"[/&]", low)
    if len(parts) >= 2 and any(
        any(w in _ROOM_WORDS for w in p.split()) for p in parts
    ):
        return True

    # Title-case alphabetic word ≥4 chars — only if NOT all-caps
    # (all-caps catches logos like "COMPASS")
    clean = text.replace(" ", "").replace("-", "")
    if (len(clean) >= 4 and text[0].isupper() and clean.isalpha()
            and not text.isupper()):
        return True

    return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_output.py::TestDimensionFiltering -v`

Expected: All PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/ -v`

Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
git add cv-service/cv/output.py cv-service/tests/test_output.py
git -c commit.gpgsign=false commit -m "fix(cv): filter dimension text and logo noise from room labels

Expand _DIM_LIKE regex to catch OCR-garbled imperial dimensions.
Add fixture abbreviation blocklist and logo word blocklist.
Tighten _is_room_label to reject all-caps non-room words.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Filter ghost rooms and noise regions

**Problem:** CV detects rooms at negative coordinates (outside the image), logo/address text regions as rooms, and tiny fragments. Image 1 has "Room 6" at x=-320. Image 2 detects "COMPASS" logo and "9511 Shore Drive" address as rooms.

**Root cause:** The `bbox_filter_pre` step in merge.py filters rooms outside the consensus bbox, but:
1. Consensus bbox is computed from *all* strategy bboxes, so if most strategies produce the ghost room, it's included in the consensus
2. Logo/address regions pass the area threshold (0.5% of image) because they're large enough
3. No post-merge filtering removes rooms based on label quality or position validity

**Files:**
- Modify: `cv-service/cv/output.py:33-42` (add post-label filtering in `build_floor_plan_input`)
- Test: `cv-service/tests/test_output.py`

- [ ] **Step 1: Write failing tests for ghost room filtering**

Add to `tests/test_output.py`:

```python
from cv.output import build_floor_plan_input


class TestGhostRoomFiltering:
    """Rooms outside the floor plan or with garbage labels should be removed."""

    def _make_room(self, label, x, y, w, h, confidence=0.9):
        import numpy as np
        mask = np.zeros((800, 800), dtype=np.uint8)
        # Only create mask pixels if coordinates are valid
        if x >= 0 and y >= 0 and x + w <= 800 and y + h <= 800:
            mask[y:y+h, x:x+w] = 255
        return {
            "label": label,
            "bbox": (x, y, w, h),
            "area_px": w * h,
            "centroid": (x + w // 2, y + h // 2),
            "mask": mask,
            "polygon": [(x, y), (x+w, y), (x+w, y+h), (x, y+h)],
            "confidence": confidence,
        }

    def test_removes_negative_coordinate_rooms(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Ghost", -320, -60, 320, 760),  # negative coords
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 700),
        )
        labels = [r["label"] for r in result["rooms"]]
        assert "Kitchen" in labels
        assert "Ghost" not in labels

    def test_removes_zero_dimension_rooms(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Tiny", 300, 300, 5, 5),  # too small
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 700),
        )
        labels = [r["label"] for r in result["rooms"]]
        assert "Kitchen" in labels
        assert len(result["rooms"]) == 1

    def test_removes_rooms_outside_floor_plan_bbox(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Logo", 100, 750, 280, 60),  # below floor plan
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 650),
        )
        assert len(result["rooms"]) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_output.py::TestGhostRoomFiltering -v`

Expected: FAIL — `build_floor_plan_input` currently passes all rooms through without position/size filtering.

- [ ] **Step 3: Add room filtering to build_floor_plan_input**

In `cv-service/cv/output.py`, add room filtering after label assignment (after line 62, before the origin calculation):

```python
    labeled_rooms = _assign_labels(rooms, labels)

    # Filter out ghost rooms: negative coords, outside floor plan, too small
    filtered_rooms = []
    for room in labeled_rooms:
        bx, by, bw, bh = room["bbox"]

        # Skip rooms with negative coordinates
        if bx < 0 or by < 0:
            continue

        # Skip rooms with zero/tiny dimensions (< 0.5% of image area)
        min_area = image_shape[0] * image_shape[1] * 0.005
        if room["area_px"] < min_area:
            continue

        # Skip rooms whose centroid is outside the floor plan bbox
        if floor_plan_bbox is not None:
            fbx, fby, fbw, fbh = floor_plan_bbox
            cx, cy = room.get("centroid", (bx + bw // 2, by + bh // 2))
            if cx < fbx or cx > fbx + fbw or cy < fby or cy > fby + fbh:
                continue

        filtered_rooms.append(room)

    labeled_rooms = filtered_rooms
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_output.py::TestGhostRoomFiltering -v`

Expected: All PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/ -v`

Expected: All pass. Some existing tests may need adjustment if they relied on rooms at edge coordinates — fix as needed.

- [ ] **Step 6: Commit**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
git add cv-service/cv/output.py cv-service/tests/test_output.py
git -c commit.gpgsign=false commit -m "fix(cv): filter ghost rooms with negative coords, tiny area, or outside bbox

Rooms at negative coordinates, below 1% of image area, or with
centroids outside the floor plan bounding box are now removed from
output.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Cap wall thickness at realistic bounds

**Problem:** Image 3 reports 35.8cm exterior walls, which is unrealistic for residential construction. This inflated thickness causes the structural detection to aggressively dilate wall regions, which swallows small rooms (both bedrooms missing in image 3).

**Root cause:** The `detect_structural_elements_step` in merge.py computes `thick_threshold = thin_half * 2`. If the thin-wall peak is measured incorrectly (e.g. from a noisy strategy), the thick threshold becomes too aggressive, classifying too many pixels as "structural" and dilating rooms away during `refine_polygons_step`.

**Files:**
- Modify: `cv-service/cv/merge.py` (cap thickness in structural detection and thickness profile output)
- Modify: `cv-service/cv/pipeline.py` (cap wall_thickness values in analyze_image output)
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write failing tests for wall thickness capping**

Add to `tests/test_merge.py`:

```python
class TestWallThicknessCapping:
    """Wall thickness values must be capped at realistic residential bounds."""

    def test_thin_wall_capped(self):
        from cv.merge import cap_wall_thickness_cm
        # Raw values of 39.5cm interior and 79cm exterior are unrealistic
        thin_cm, thick_cm = cap_wall_thickness_cm(39.5, 79.0)
        assert thin_cm <= 20, f"Interior wall {thin_cm}cm exceeds 20cm cap"
        assert thick_cm <= 40, f"Exterior wall {thick_cm}cm exceeds 40cm cap"

    def test_normal_thickness_unchanged(self):
        from cv.merge import cap_wall_thickness_cm
        thin_cm, thick_cm = cap_wall_thickness_cm(10.0, 20.0)
        assert thin_cm == 10.0
        assert thick_cm == 20.0

    def test_minimum_thickness_enforced(self):
        from cv.merge import cap_wall_thickness_cm
        thin_cm, thick_cm = cap_wall_thickness_cm(0.5, 1.0)
        assert thin_cm >= 5, f"Interior wall {thin_cm}cm below 5cm minimum"
        assert thick_cm >= 10, f"Exterior wall {thick_cm}cm below 10cm minimum"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_merge.py::TestWallThicknessCapping -v`

Expected: FAIL — `cap_wall_thickness_cm` doesn't exist yet.

- [ ] **Step 3: Add cap_wall_thickness_cm function**

In `cv-service/cv/merge.py`, add at module level:

```python
def cap_wall_thickness_cm(thin_cm: float, thick_cm: float) -> tuple[float, float]:
    """Clamp wall thickness to realistic residential bounds.

    Interior walls: 5-20cm (typical 10-15cm)
    Exterior walls: 10-40cm (typical 20-30cm)
    """
    thin_cm = max(5.0, min(thin_cm, 20.0))
    thick_cm = max(10.0, min(thick_cm, 40.0))
    # Exterior must be >= interior
    thick_cm = max(thick_cm, thin_cm)
    return thin_cm, thick_cm
```

- [ ] **Step 4: Apply capping in pipeline.py (lines 152-154)**

In `cv-service/cv/pipeline.py`, at lines 152-154 where `wall_thickness` dict is built:

```python
# BEFORE (lines 152-154):
wall_thickness = {
    "thin_cm": round(tp.thin_wall_px * scale, 1),
    "thick_cm": round(tp.thick_wall_px * scale, 1),

# AFTER:
from cv.merge import cap_wall_thickness_cm

raw_thin = round(tp.thin_wall_px * scale, 1)
raw_thick = round(tp.thick_wall_px * scale, 1)
thin_cm, thick_cm = cap_wall_thickness_cm(raw_thin, raw_thick)
wall_thickness = {
    "thin_cm": thin_cm,
    "thick_cm": thick_cm,
```

Note: This caps the **output metadata** only. The actual polygon refinement dilation (which uses pixel-space `thick_wall_px`) is capped separately in Task 4.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_merge.py::TestWallThicknessCapping -v`

Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/ -v`

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
git add cv-service/cv/merge.py cv-service/cv/pipeline.py cv-service/tests/test_merge.py
git -c commit.gpgsign=false commit -m "fix(cv): cap wall thickness output at realistic residential bounds

Interior: 5-20cm, exterior: 10-40cm. Caps the reported metadata
values. Polygon refinement dilation is capped separately in the
next commit.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Limit polygon refinement dilation

**Problem:** When `thick_wall_px` is large, `refine_polygons_step` dilates wall regions by `thick_wall_px / 2` pixels. This swallows adjacent rooms, especially small ones like closets and bathrooms. Image 3 lost both bedrooms this way.

**Root cause:** In merge.py `refine_polygons_step` (line ~470): `dilation = max(1, int(profile.thick_wall_px / 2))`. With a `thick_wall_px` of 27 (at 2.63 cm/px scale), dilation is 13 pixels — enough to close off small room gaps.

**Files:**
- Modify: `cv-service/cv/merge.py` (cap dilation amount in refine_polygons_step)
- Test: `cv-service/tests/test_merge.py`

- [ ] **Step 1: Write failing test for excessive dilation**

Add to `tests/test_merge.py`:

```python
import numpy as np


class TestRefinementDilation:
    """Polygon refinement dilation must not exceed a safe maximum."""

    def test_dilation_capped_at_8px(self):
        """Even with thick walls, dilation should not exceed 8 pixels
        to avoid swallowing small rooms."""
        from cv.merge import _safe_dilation
        # thick_wall_px = 30 → raw dilation = 15 → should cap at 8
        assert _safe_dilation(30) <= 8
        # thick_wall_px = 10 → raw dilation = 5 → should be 5 (within cap)
        assert _safe_dilation(10) == 5
        # thick_wall_px = 2 → raw dilation = 1 → minimum 1
        assert _safe_dilation(2) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_merge.py::TestRefinementDilation -v`

Expected: FAIL — `_safe_dilation` doesn't exist.

- [ ] **Step 3: Add _safe_dilation and use it in refine_polygons_step**

In `cv-service/cv/merge.py`:

```python
def _safe_dilation(thick_wall_px: float) -> int:
    """Compute dilation for polygon refinement, capped to avoid swallowing rooms."""
    raw = max(1, int(thick_wall_px / 2))
    return min(raw, 8)  # cap at 8px to preserve small rooms
```

Then in `refine_polygons_step`, replace the dilation calculation line:

```python
# OLD: dilation = max(1, int(profile.thick_wall_px / 2))
# NEW:
dilation = _safe_dilation(profile.thick_wall_px)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_merge.py::TestRefinementDilation tests/test_merge.py -v`

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
git add cv-service/cv/merge.py cv-service/tests/test_merge.py
git -c commit.gpgsign=false commit -m "fix(cv): cap polygon refinement dilation at 8px

Prevents thick wall measurements from causing excessive dilation
that swallows small rooms like closets and bathrooms.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Improve scale calibration matching

**Problem:** Image 4 has clear dimension labels ("10'- 6\" x 8'- 10\"", "21'- 1\" x 11'- 8\"", "8'- 7\" x 5'- 2\"") but scale falls back. The dimension parser or wall matcher is rejecting valid matches.

**Root cause (likely):** The dimension labels in image 4 use the format `10'- 6" x 8'- 10"` (compound dimensions). `parse_dimension` correctly parses the first half. But the issue may be:
1. **OCR splits the text**: Tesseract may split `10'- 6" x 8'- 10"` into separate fragments
2. **Wall matching orientation**: The merged OCR text may be wider than tall (horizontal), but the wall it labels may be vertical
3. **Perpendicular distance**: With thick exterior walls, the text may be far from the wall centerline

**Files:**
- Modify: `cv-service/cv/pipeline.py:233-300` (relax scale matching constraints)
- Modify: `cv-service/cv/dimensions.py` (handle OCR-garbled imperial with spaces/dashes)
- Test: `cv-service/tests/test_pipeline.py`, `cv-service/tests/test_dimensions.py`

- [ ] **Step 1: Write failing tests for dimension parsing edge cases**

Add to `tests/test_dimensions.py`:

```python
import pytest
from cv.dimensions import parse_dimension


class TestOCRGarbledDimensions:
    """Dimensions as OCR commonly garbles them."""

    @pytest.mark.parametrize("text,expected_cm", [
        ("10'- 6\"", 320),     # space after dash
        ("10' - 6\"", 320),    # spaces around dash
        ("10'  6\"", 320),     # double space, no dash
        ("8'- 10\"", 269),     # space after dash
        ("21'- 1\"", 643),     # space after dash
        ("10' -8\"", 325),     # space before dash
        ("10'-  8\"", 325),    # double space after dash
        ("7' 6\"", 229),       # space, no dash
    ])
    def test_parses_spaced_imperial(self, text, expected_cm):
        result = parse_dimension(text)
        assert result is not None, f"Failed to parse: {text!r}"
        assert abs(result - expected_cm) < 5, f"{text!r}: got {result}, expected ~{expected_cm}"
```

- [ ] **Step 2: Run tests to check which already pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_dimensions.py::TestOCRGarbledDimensions -v`

Expected: The existing `_IMPERIAL` regex (`\s*-?\s*`) likely handles most spacing variations already. If all pass, skip Step 3 and proceed to Step 5. If any fail, continue to Step 3.

- [ ] **Step 3: (Conditional) Fix any failing dimension patterns**

Only needed if Step 2 found failures. The most likely fix is adding `\s*` before the closing inch mark:

```python
_IMPERIAL = re.compile(r"^(\d+)['']\s*-?\s*(\d+)\s*[\"\"]\s*$")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_dimensions.py -v`

Expected: All PASS.

- [ ] **Step 5: Write failing test for relaxed scale matching**

Add to `tests/test_pipeline.py`:

```python
class TestScaleCalibrationRelaxed:
    """Scale calibration should try both orientations for compound dimensions."""

    def test_matches_vertical_dimension_on_horizontal_label(self):
        """A compound dimension like '10'-6" x 8'-10"' is OCR'd as horizontal
        text but the first dimension may label a vertical wall."""
        from cv.pipeline import _calibrate_scale
        walls = [
            {"start": (100, 50), "end": (100, 370), "thickness": 5},  # vertical, ~320px
        ]
        text_regions = [
            {
                "text": "10'- 6\" x 8'- 10\"",
                "center": (140, 200),  # to the right of the vertical wall
                "bbox": (110, 190, 180, 20),  # wide text = horizontal
                "confidence": 85,
            },
        ]
        scale, confidence = _calibrate_scale(walls, text_regions, (400, 400))
        assert confidence == "measured", "Should match despite orientation mismatch"
        assert 0.5 < scale < 2.0, f"Scale {scale} out of reasonable range"
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_pipeline.py::TestScaleCalibrationRelaxed -v`

Expected: FAIL — current code skips when `wall_horizontal != label_horizontal`.

- [ ] **Step 7: Relax orientation constraint in _calibrate_scale**

In `cv-service/cv/pipeline.py`, modify `_calibrate_scale` (lines 264-265). Instead of strictly skipping orientation mismatches, try both orientations but penalize mismatches with a distance multiplier:

```python
        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)

            # Orientation mismatch penalty: compound dims (e.g. "10'-6" x 8'-10"")
            # are always horizontal text but may label vertical walls.
            # Allow mismatch but penalize distance by 2x.
            orientation_penalty = 1.0 if (wall_horizontal == label_horizontal) else 2.0

            if wall_horizontal:
                wall_y = (sy + ey) / 2
                perp_dist = abs(ty - wall_y) * orientation_penalty
                wall_min_x = min(sx, ex)
                wall_max_x = max(sx, ex)
                margin = (wall_max_x - wall_min_x) * 0.2
                if tx < wall_min_x - margin or tx > wall_max_x + margin:
                    continue
            else:
                wall_x = (sx + ex) / 2
                perp_dist = abs(tx - wall_x) * orientation_penalty
                wall_min_y = min(sy, ey)
                wall_max_y = max(sy, ey)
                margin = (wall_max_y - wall_min_y) * 0.2
                if ty < wall_min_y - margin or ty > wall_max_y + margin:
                    continue

            if perp_dist < best_dist:
                best_dist = perp_dist
                best_wall = wall
```

Also increase `max_dist` from 15% to 20% (line 288):

```python
        max_dist = max(image_shape) * 0.20
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/test_pipeline.py tests/test_dimensions.py -v`

Expected: All PASS.

- [ ] **Step 9: Run full test suite**

Run: `cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service && python -m pytest tests/ -v`

Expected: All pass.

- [ ] **Step 10: Commit**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
git add cv-service/cv/dimensions.py cv-service/cv/pipeline.py \
        cv-service/tests/test_dimensions.py cv-service/tests/test_pipeline.py
git -c commit.gpgsign=false commit -m "fix(cv): improve scale calibration for compound imperial dimensions

Relax imperial regex to handle OCR spacing variations.
Allow orientation-mismatched dimension-to-wall matching with 2x
distance penalty (compound dims are always horizontal text but may
label vertical walls). Increase max matching distance to 20%.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Deploy and verify with test images

After all code changes are committed:

- [ ] **Step 1: Deploy CV service to Hetzner**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp/cv-service
bash deploy-hetzner.sh 87.99.134.67 ~/.ssh/hetzner
```

Expected: Health check passes.

- [ ] **Step 2: Deploy Worker to Cloudflare**

```bash
cd /Users/guy/CODE/roomsketcher-help-mcp
bash deploy.sh
```

Expected: Deployment succeeds, sync OK.

- [ ] **Step 3: Re-test all 4 images via MCP**

Run `analyze_floor_plan_image` on each of the 4 test URLs. For each, verify:

1. **Image 1** (Unit 2C): No dimension labels as room names, no ghost room at x=-320
2. **Image 2** (Shore Dr): No "COMPASS" or address rooms, "CL" should not be a room label
3. **Image 3** (Apt 6C): Wall thickness ≤40cm exterior, more rooms detected (6→hopefully 8+)
4. **Image 4** (Res 507): Scale should be "measured" not "fallback", no "8-7\"" room labels

- [ ] **Step 4: Compare before/after results**

Document which issues are resolved and which remain for future work.
