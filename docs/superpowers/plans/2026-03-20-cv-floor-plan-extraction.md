# CV Floor Plan Extraction Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python CV service that extracts room geometries from floor plan images, replacing the LLM's unreliable spatial coordinate guessing with deterministic computer vision.

**Architecture:** A standalone FastAPI service running OpenCV + Tesseract OCR. The MCP Cloudflare Worker calls it via HTTP POST with a base64 image. The service returns `SimpleFloorPlanInput`-compatible JSON (rooms with positions/dimensions, detected openings). The LLM's role shifts from "guess coordinates" to "validate and fix CV output."

**Tech Stack:** Python 3.11+, FastAPI, OpenCV (cv2), Tesseract OCR (pytesseract), NumPy, Pillow, Docker

---

## File Structure

```
cv-service/
├── requirements.txt          # Python dependencies
├── Dockerfile                # Container for deployment
├── docker-compose.yml        # Local dev with Tesseract
├── app.py                    # FastAPI entry point, /analyze endpoint
├── cv/
│   ├── __init__.py
│   ├── pipeline.py           # Orchestrator: image → SimpleFloorPlanInput
│   ├── preprocess.py         # Image cleanup: grayscale, threshold, denoise
│   ├── walls.py              # Wall detection: morphology + contours
│   ├── rooms.py              # Room detection: flood fill enclosed regions
│   ├── ocr.py                # OCR: extract room labels + dimensions
│   ├── dimensions.py         # Parse dimension strings (3.30m, 10'-8")
│   └── output.py             # Convert detections → SimpleFloorPlanInput JSON
├── tests/
│   ├── conftest.py           # Shared fixtures
│   ├── test_preprocess.py
│   ├── test_walls.py
│   ├── test_rooms.py
│   ├── test_ocr.py
│   ├── test_dimensions.py
│   ├── test_output.py
│   └── test_pipeline.py      # End-to-end integration test
└── fixtures/
    ├── simple-2room.png       # 2 rooms side by side (test fixture)
    ├── residence-507.png      # The failing test case from user testing
    └── expected/
        ├── simple-2room.json  # Expected output for simple-2room
        └── residence-507.json # Expected output for residence-507
```

MCP integration (existing codebase):

```
src/
├── index.ts                   # Add analyze_floor_plan_image MCP tool
└── sketch/
    └── tools.ts               # Add handleAnalyzeImage() handler
```

---

### Task 1: Project Scaffolding & Dependencies

**Files:**
- Create: `cv-service/requirements.txt`
- Create: `cv-service/Dockerfile`
- Create: `cv-service/docker-compose.yml`
- Create: `cv-service/app.py`
- Create: `cv-service/cv/__init__.py`

- [ ] **Step 1: Create requirements.txt**

```
fastapi==0.115.0
uvicorn[standard]==0.30.0
opencv-python-headless==4.10.0.84
pytesseract==0.3.13
numpy>=1.26,<2
Pillow>=10.0,<11
python-multipart==0.0.12
pytest==8.3.0
anyio[trio]==4.4.0
pytest-anyio==0.0.0
httpx==0.27.0
```

- [ ] **Step 2: Create Dockerfile**

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
```

- [ ] **Step 3: Create docker-compose.yml**

```yaml
services:
  cv-service:
    build: .
    ports:
      - "8100:8100"
    volumes:
      - ./fixtures:/app/fixtures
    environment:
      - LOG_LEVEL=debug
```

- [ ] **Step 4: Create minimal app.py with health endpoint**

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Floor Plan CV Service")


class HealthResponse(BaseModel):
    status: str


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")
```

- [ ] **Step 5: Create cv/__init__.py**

```python
# CV floor plan extraction pipeline
```

- [ ] **Step 6: Build and verify Docker container starts**

```bash
cd cv-service
docker compose up --build -d
curl http://localhost:8100/health
# Expected: {"status":"ok"}
docker compose down
```

- [ ] **Step 7: Commit**

```bash
git add cv-service/
git commit -m "feat(cv): scaffold FastAPI service with Docker + dependencies"
```

---

### Task 2: Image Preprocessing

**Files:**
- Create: `cv-service/cv/preprocess.py`
- Create: `cv-service/tests/test_preprocess.py`
- Create: `cv-service/fixtures/simple-2room.png` (programmatically generated)

- [ ] **Step 1: Create test fixture generator**

Create `cv-service/tests/conftest.py` that programmatically generates a simple 2-room floor plan image for testing (two rectangles side by side with wall lines, room labels, and dimension text). This avoids needing real images for unit tests.

```python
import cv2
import numpy as np
import pytest
from pathlib import Path

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture
def simple_2room_image() -> np.ndarray:
    """Generate a synthetic 2-room floor plan: Kitchen (left) + Living (right).

    Layout (600x400 image):
    - Outer walls: 20px thick black lines
    - Interior wall: 10px thick at x=300
    - Door gap: 80px opening in interior wall centered vertically
    - Room labels: "Kitchen" at (150, 200), "Living" at (450, 200)
    - Dimensions: "3.00m" below Kitchen, "3.00m" below Living, "4.00m" on left side
    """
    img = np.ones((400, 600, 3), dtype=np.uint8) * 255

    # Outer walls (20px thick)
    cv2.rectangle(img, (0, 0), (599, 399), (0, 0, 0), 20)
    # Interior wall (10px thick) with door gap
    cv2.line(img, (300, 10), (300, 160), (0, 0, 0), 10)
    cv2.line(img, (300, 240), (300, 390), (0, 0, 0), 10)
    # Room labels
    cv2.putText(img, "Kitchen", (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 80), 2)
    cv2.putText(img, "Living", (370, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 80), 2)
    # Dimensions
    cv2.putText(img, "3.00m", (120, 385), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "3.00m", (400, 385), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "4.00m", (5, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)

    return img


@pytest.fixture
def simple_2room_path(simple_2room_image: np.ndarray, tmp_path: Path) -> Path:
    """Save the 2-room fixture to a temp file."""
    path = tmp_path / "simple-2room.png"
    cv2.imwrite(str(path), simple_2room_image)
    return path
```

- [ ] **Step 2: Write failing test for preprocess**

```python
# tests/test_preprocess.py
import numpy as np
from cv.preprocess import prepare


def test_prepare_returns_binary_image(simple_2room_image):
    binary = prepare(simple_2room_image)
    assert binary.ndim == 2, "Should be single-channel"
    unique = set(np.unique(binary))
    assert unique <= {0, 255}, "Should be binary (0 and 255 only)"


def test_prepare_walls_are_white_on_black(simple_2room_image):
    """Convention: walls = 255 (white), background = 0 (black)."""
    binary = prepare(simple_2room_image)
    # The center of a wall should be white
    center_of_left_wall = binary[200, 5]  # Left exterior wall
    center_of_room = binary[200, 150]      # Inside Kitchen
    assert center_of_left_wall == 255, "Wall pixels should be 255"
    assert center_of_room == 0, "Room interior should be 0"
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_preprocess.py -v
# Expected: FAIL — ModuleNotFoundError: No module named 'cv.preprocess'
```

- [ ] **Step 4: Implement preprocess.py**

```python
# cv/preprocess.py
"""Image preprocessing: convert floor plan image to clean binary wall mask."""

import cv2
import numpy as np


def prepare(image: np.ndarray) -> np.ndarray:
    """Convert a floor plan image to a binary wall mask.

    Args:
        image: BGR or grayscale input image

    Returns:
        Binary image where walls = 255 (white) and background = 0 (black)
    """
    # Convert to grayscale if needed
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    # Adaptive threshold to handle varying lighting/backgrounds
    # Walls are dark lines on light background → invert so walls become white
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 10
    )

    # Morphological close to fill small gaps in wall lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Remove small noise (text, furniture icons, dimension lines)
    # Walls are large connected components; text/icons are small
    # Use area-based filtering
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    min_wall_area = (image.shape[0] * image.shape[1]) * 0.001  # 0.1% of image area
    mask = np.zeros_like(binary)
    for cnt in contours:
        if cv2.contourArea(cnt) >= min_wall_area:
            cv2.drawContours(mask, [cnt], -1, 255, cv2.FILLED)

    return mask
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_preprocess.py -v
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add cv-service/cv/preprocess.py cv-service/tests/
git commit -m "feat(cv): image preprocessing — grayscale → binary wall mask"
```

---

### Task 3: Wall Line Detection

**Files:**
- Create: `cv-service/cv/walls.py`
- Create: `cv-service/tests/test_walls.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_walls.py
import numpy as np
from cv.preprocess import prepare
from cv.walls import detect_walls


def test_detect_walls_finds_horizontal_and_vertical(simple_2room_image):
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)

    # Each wall: {"start": (x1, y1), "end": (x2, y2), "thickness": int}
    assert len(walls) >= 5, f"Expected ≥5 walls (4 exterior + 1 interior), got {len(walls)}"

    horizontal = [w for w in walls if abs(w["start"][1] - w["end"][1]) < 10]
    vertical = [w for w in walls if abs(w["start"][0] - w["end"][0]) < 10]
    assert len(horizontal) >= 2, "Should find top and bottom walls"
    assert len(vertical) >= 3, "Should find left, right, and interior walls"


def test_walls_have_positive_thickness(simple_2room_image):
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)

    for w in walls:
        assert w["thickness"] > 0, "Every wall should have positive thickness"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_walls.py -v
# Expected: FAIL — ModuleNotFoundError
```

- [ ] **Step 3: Implement wall detection**

```python
# cv/walls.py
"""Wall detection using morphological line extraction and contour analysis."""

import cv2
import numpy as np


def detect_walls(binary: np.ndarray) -> list[dict]:
    """Detect wall segments from a binary wall mask.

    Uses morphological operations to separate horizontal and vertical wall
    segments, then extracts line segments with position and thickness.

    Args:
        binary: Binary image (walls=255, background=0)

    Returns:
        List of wall dicts: {"start": (x1,y1), "end": (x2,y2), "thickness": int}
    """
    h, w = binary.shape
    walls = []

    # Detect horizontal walls using a wide horizontal kernel
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(w // 10, 30), 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)
    walls.extend(_extract_segments(h_lines, orientation="horizontal"))

    # Detect vertical walls using a tall vertical kernel
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(h // 10, 30)))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)
    walls.extend(_extract_segments(v_lines, orientation="vertical"))

    return walls


def _extract_segments(mask: np.ndarray, orientation: str) -> list[dict]:
    """Extract line segments from a morphologically filtered mask.

    For each connected component, compute the bounding rect to get
    start/end points and thickness.
    """
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    segments = []

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)

        if orientation == "horizontal":
            # Horizontal wall: long in x, short in y
            if w < 20:
                continue
            mid_y = y + h // 2
            segments.append({
                "start": (x, mid_y),
                "end": (x + w, mid_y),
                "thickness": h,
            })
        else:
            # Vertical wall: short in x, long in y
            if h < 20:
                continue
            mid_x = x + w // 2
            segments.append({
                "start": (mid_x, y),
                "end": (mid_x, y + h),
                "thickness": w,
            })

    return segments
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_walls.py -v
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/walls.py cv-service/tests/test_walls.py
git commit -m "feat(cv): wall detection — morphological line extraction"
```

---

### Task 4: Room Detection (Flood Fill)

**Files:**
- Create: `cv-service/cv/rooms.py`
- Create: `cv-service/tests/test_rooms.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_rooms.py
import numpy as np
from cv.preprocess import prepare
from cv.rooms import detect_rooms


def test_detect_rooms_finds_two_rooms(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)

    # Each room: {"bbox": (x, y, w, h), "area_px": int, "centroid": (cx, cy)}
    assert len(rooms) == 2, f"Expected 2 rooms, got {len(rooms)}"


def test_rooms_have_reasonable_area(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)

    img_area = simple_2room_image.shape[0] * simple_2room_image.shape[1]
    for room in rooms:
        ratio = room["area_px"] / img_area
        assert 0.05 < ratio < 0.8, f"Room area ratio {ratio} is unreasonable"


def test_rooms_are_left_and_right(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)

    centroids_x = sorted(r["centroid"][0] for r in rooms)
    # One room on the left half, one on the right half
    img_mid = simple_2room_image.shape[1] // 2
    assert centroids_x[0] < img_mid, "First room should be on the left"
    assert centroids_x[1] > img_mid, "Second room should be on the right"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_rooms.py -v
# Expected: FAIL
```

- [ ] **Step 3: Implement room detection**

```python
# cv/rooms.py
"""Room detection via flood fill on the inverse of the wall mask."""

import cv2
import numpy as np


def detect_rooms(binary: np.ndarray, min_room_ratio: float = 0.02) -> list[dict]:
    """Detect enclosed rooms by flood-filling non-wall areas.

    Args:
        binary: Binary wall mask (walls=255, background=0)
        min_room_ratio: Minimum room area as fraction of image area

    Returns:
        List of room dicts: {"bbox": (x,y,w,h), "area_px": int, "centroid": (cx,cy), "mask": ndarray}
    """
    h, w = binary.shape
    min_area = int(h * w * min_room_ratio)

    # Invert: rooms become white, walls become black
    inv = cv2.bitwise_not(binary)

    # Close small gaps in walls that might cause rooms to merge
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    inv = cv2.morphologyEx(inv, cv2.MORPH_ERODE, kernel, iterations=1)

    # Find connected components (each enclosed region = potential room)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(inv, connectivity=4)

    rooms = []
    for i in range(1, num_labels):  # Skip background (label 0)
        area = stats[i, cv2.CC_STAT_AREA]

        # Skip tiny regions (noise) and the outer background
        if area < min_area:
            continue

        x = stats[i, cv2.CC_STAT_LEFT]
        y = stats[i, cv2.CC_STAT_TOP]
        rw = stats[i, cv2.CC_STAT_WIDTH]
        rh = stats[i, cv2.CC_STAT_HEIGHT]
        cx, cy = centroids[i]

        # Skip the outer background — the largest border-touching component
        touches_border = x == 0 or y == 0 or (x + rw) >= w or (y + rh) >= h
        if touches_border and area > (h * w * 0.3):
            continue

        room_mask = (labels == i).astype(np.uint8) * 255
        rooms.append({
            "bbox": (x, y, rw, rh),
            "area_px": area,
            "centroid": (int(cx), int(cy)),
            "mask": room_mask,
        })

    return rooms
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_rooms.py -v
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/rooms.py cv-service/tests/test_rooms.py
git commit -m "feat(cv): room detection — flood fill on inverse wall mask"
```

---

### Task 5: OCR — Room Labels & Dimensions

**Files:**
- Create: `cv-service/cv/ocr.py`
- Create: `cv-service/cv/dimensions.py`
- Create: `cv-service/tests/test_ocr.py`
- Create: `cv-service/tests/test_dimensions.py`

- [ ] **Step 1: Write failing test for dimension parsing**

```python
# tests/test_dimensions.py
from cv.dimensions import parse_dimension


def test_parse_metric_meters():
    assert parse_dimension("3.30m") == 330
    assert parse_dimension("1.60m") == 160
    assert parse_dimension("0.50m") == 50


def test_parse_metric_no_unit():
    # Some plans just write "3.30" meaning meters
    assert parse_dimension("3.30") == 330


def test_parse_imperial_feet_inches():
    assert parse_dimension("10'-8\"") == 325  # 10*30.48 + 8*2.54 ≈ 325
    assert parse_dimension("8'-1\"") == 246    # 8*30.48 + 1*2.54 ≈ 246


def test_parse_imperial_dash_format():
    # "10'- 8\"" with space
    assert parse_dimension("10'- 8\"") == 325


def test_parse_area_sqm():
    # "8.6 m²" — this is area, not a dimension
    assert parse_dimension("8.6 m²") is None


def test_parse_garbage():
    assert parse_dimension("Kitchen") is None
    assert parse_dimension("") is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_dimensions.py -v
# Expected: FAIL
```

- [ ] **Step 3: Implement dimension parser**

```python
# cv/dimensions.py
"""Parse dimension strings from floor plans into centimeters."""

import re

# Patterns in priority order
_METRIC_M = re.compile(r"^(\d+(?:\.\d+)?)\s*m$", re.IGNORECASE)
_METRIC_BARE = re.compile(r"^(\d+\.\d{2})$")  # "3.30" = meters (exactly 2 decimal places)
_IMPERIAL = re.compile(r"^(\d+)['']\s*-?\s*(\d+)[\"\"]\s*$")
_AREA = re.compile(r"m[²2]|sq\.?\s*(?:ft|m)", re.IGNORECASE)


def parse_dimension(text: str) -> int | None:
    """Parse a dimension string into centimeters.

    Returns None if the text is not a valid dimension (e.g. room label, area).
    """
    text = text.strip()
    if not text:
        return None

    # Reject area measurements
    if _AREA.search(text):
        return None

    # Metric: "3.30m"
    m = _METRIC_M.match(text)
    if m:
        return round(float(m.group(1)) * 100)

    # Imperial: "10'-8\""
    m = _IMPERIAL.match(text)
    if m:
        feet = int(m.group(1))
        inches = int(m.group(2))
        return round(feet * 30.48 + inches * 2.54)

    # Bare metric: "3.30" (exactly 2 decimal places → meters)
    m = _METRIC_BARE.match(text)
    if m:
        return round(float(m.group(1)) * 100)

    return None
```

- [ ] **Step 4: Run dimension test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_dimensions.py -v
# Expected: PASS
```

- [ ] **Step 5: Write failing test for OCR**

```python
# tests/test_ocr.py
from cv.ocr import extract_text_regions


def test_extract_finds_room_labels(simple_2room_image):
    regions = extract_text_regions(simple_2room_image)

    # Each region: {"text": str, "bbox": (x,y,w,h), "center": (cx,cy)}
    texts = [r["text"].lower() for r in regions]
    assert any("kitchen" in t for t in texts), f"Should find 'Kitchen', got {texts}"
    assert any("living" in t for t in texts), f"Should find 'Living', got {texts}"


def test_extract_finds_dimensions(simple_2room_image):
    regions = extract_text_regions(simple_2room_image)

    texts = [r["text"] for r in regions]
    assert any("3.00" in t or "3.0" in t for t in texts), f"Should find dimension, got {texts}"
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_ocr.py -v
# Expected: FAIL
```

- [ ] **Step 7: Implement OCR extraction**

```python
# cv/ocr.py
"""OCR extraction of room labels and dimension text from floor plan images."""

import cv2
import numpy as np

try:
    import pytesseract
except ImportError:
    pytesseract = None


def extract_text_regions(image: np.ndarray, min_confidence: int = 40) -> list[dict]:
    """Extract text regions with positions from a floor plan image.

    Uses Tesseract OCR with word-level bounding boxes.

    Args:
        image: BGR input image
        min_confidence: Minimum OCR confidence (0-100)

    Returns:
        List of {"text": str, "bbox": (x,y,w,h), "center": (cx,cy)}
    """
    if pytesseract is None:
        raise RuntimeError("pytesseract not installed")

    # Convert to grayscale and enhance contrast for OCR
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    # Light denoise for better OCR
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Run Tesseract with word-level output
    data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)

    regions = []
    n = len(data["text"])
    for i in range(n):
        text = data["text"][i].strip()
        conf = int(data["conf"][i])

        if not text or conf < min_confidence:
            continue

        x = data["left"][i]
        y = data["top"][i]
        w = data["width"][i]
        h = data["height"][i]

        regions.append({
            "text": text,
            "bbox": (x, y, w, h),
            "center": (x + w // 2, y + h // 2),
            "confidence": conf,
        })

    return regions
```

- [ ] **Step 8: Run OCR test**

```bash
cd cv-service && python -m pytest tests/test_ocr.py -v
# Expected: PASS (requires Tesseract installed — run in Docker if needed)
```

Note: If running outside Docker, install Tesseract: `brew install tesseract` (macOS) or `apt-get install tesseract-ocr` (Linux).

- [ ] **Step 9: Commit**

```bash
git add cv-service/cv/ocr.py cv-service/cv/dimensions.py cv-service/tests/test_ocr.py cv-service/tests/test_dimensions.py
git commit -m "feat(cv): OCR text extraction + dimension parser"
```

---

### Task 6: Output Mapper — Detections → SimpleFloorPlanInput

**Files:**
- Create: `cv-service/cv/output.py`
- Create: `cv-service/tests/test_output.py`

This is the critical step: combine wall detection, room detection, and OCR results into the JSON format that `compileLayout()` expects.

- [ ] **Step 1: Write failing test**

```python
# tests/test_output.py
from cv.output import build_floor_plan_input


def test_build_basic_output():
    rooms = [
        {"bbox": (20, 20, 270, 370), "area_px": 99900, "centroid": (155, 200), "mask": None},
        {"bbox": (310, 20, 270, 370), "area_px": 99900, "centroid": (445, 200), "mask": None},
    ]
    text_regions = [
        {"text": "Kitchen", "center": (150, 200), "bbox": (100, 190, 100, 20), "confidence": 90},
        {"text": "Living", "center": (450, 200), "bbox": (370, 190, 80, 20), "confidence": 90},
        {"text": "3.00m", "center": (150, 385), "bbox": (120, 380, 60, 15), "confidence": 80},
    ]
    image_shape = (400, 600)  # (height, width)

    result = build_floor_plan_input(rooms, text_regions, image_shape, scale_cm_per_px=1.0)

    assert result["name"] == "Extracted Floor Plan"
    assert len(result["rooms"]) == 2

    labels = {r["label"] for r in result["rooms"]}
    assert "Kitchen" in labels
    assert "Living" in labels

    kitchen = next(r for r in result["rooms"] if r["label"] == "Kitchen")
    assert kitchen["x"] >= 0
    assert kitchen["y"] >= 0
    assert kitchen["width"] > 0
    assert kitchen["depth"] > 0


def test_build_labels_assigned_by_proximity():
    """Labels should be assigned to the nearest room centroid."""
    rooms = [
        {"bbox": (10, 10, 100, 100), "area_px": 10000, "centroid": (60, 60), "mask": None},
        {"bbox": (200, 10, 100, 100), "area_px": 10000, "centroid": (250, 60), "mask": None},
    ]
    text_regions = [
        {"text": "Bedroom", "center": (55, 65), "bbox": (30, 60, 50, 10), "confidence": 90},
        {"text": "Bath", "center": (245, 65), "bbox": (230, 60, 30, 10), "confidence": 90},
    ]

    result = build_floor_plan_input(rooms, text_regions, (200, 400), scale_cm_per_px=1.0)

    labels = {r["label"] for r in result["rooms"]}
    assert "Bedroom" in labels
    assert "Bath" in labels
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_output.py -v
# Expected: FAIL
```

- [ ] **Step 3: Implement output mapper**

```python
# cv/output.py
"""Convert CV detections to SimpleFloorPlanInput JSON format."""

import math
from cv.dimensions import parse_dimension


def build_floor_plan_input(
    rooms: list[dict],
    text_regions: list[dict],
    image_shape: tuple[int, int],
    scale_cm_per_px: float,
    name: str = "Extracted Floor Plan",
) -> dict:
    """Map detected rooms + OCR text to SimpleFloorPlanInput format.

    Args:
        rooms: From detect_rooms() — each has bbox, centroid
        text_regions: From extract_text_regions() — each has text, center
        image_shape: (height, width) of input image
        scale_cm_per_px: Conversion factor from pixels to cm
        name: Floor plan name

    Returns:
        Dict matching SimpleFloorPlanInput schema
    """
    # Separate labels (words) from dimensions (numbers with units)
    labels = []
    dimensions = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is not None:
            dimensions.append({**tr, "cm": cm})
        elif tr["text"].isalpha() or " " in tr["text"]:
            labels.append(tr)

    # Assign labels to nearest room centroid
    labeled_rooms = _assign_labels(rooms, labels)

    # Convert pixel bboxes to cm coordinates
    output_rooms = []
    for room in labeled_rooms:
        bx, by, bw, bh = room["bbox"]
        output_rooms.append({
            "label": room.get("label", f"Room {len(output_rooms) + 1}"),
            "x": round(bx * scale_cm_per_px / 10) * 10,  # Snap to 10cm grid
            "y": round(by * scale_cm_per_px / 10) * 10,
            "width": round(bw * scale_cm_per_px / 10) * 10,
            "depth": round(bh * scale_cm_per_px / 10) * 10,
        })

    return {
        "name": name,
        "rooms": output_rooms,
    }


def _assign_labels(rooms: list[dict], labels: list[dict]) -> list[dict]:
    """Assign text labels to rooms by proximity to centroid."""
    # For each label, find nearest room
    room_labels: dict[int, list[str]] = {}
    for label in labels:
        lx, ly = label["center"]
        best_idx = 0
        best_dist = float("inf")
        for i, room in enumerate(rooms):
            cx, cy = room["centroid"]
            dist = math.hypot(lx - cx, ly - cy)
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        room_labels.setdefault(best_idx, []).append(label["text"])

    # Apply labels
    result = []
    for i, room in enumerate(rooms):
        r = dict(room)
        if i in room_labels:
            # Join multi-word labels (e.g., ["Living", "&", "Dining"])
            r["label"] = " ".join(room_labels[i])
        result.append(r)
    return result
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_output.py -v
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/output.py cv-service/tests/test_output.py
git commit -m "feat(cv): output mapper — detections to SimpleFloorPlanInput JSON"
```

---

### Task 7: Pipeline Orchestrator & Scale Calibration

**Files:**
- Create: `cv-service/cv/pipeline.py`
- Create: `cv-service/tests/test_pipeline.py`

The pipeline ties everything together and handles the critical **scale calibration** step — converting pixels to centimeters.

- [ ] **Step 1: Write failing test**

```python
# tests/test_pipeline.py
import numpy as np
from cv.pipeline import analyze_floor_plan


def test_pipeline_end_to_end(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))

    assert "rooms" in result
    assert len(result["rooms"]) == 2
    assert all("label" in r for r in result["rooms"])
    assert all("width" in r for r in result["rooms"])
    assert all("depth" in r for r in result["rooms"])

    # Rooms should have non-zero dimensions
    for room in result["rooms"]:
        assert room["width"] > 0
        assert room["depth"] > 0


def test_pipeline_returns_scale_info(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))

    assert "meta" in result
    assert "scale_cm_per_px" in result["meta"]
    assert result["meta"]["scale_cm_per_px"] > 0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_pipeline.py -v
# Expected: FAIL
```

- [ ] **Step 3: Implement pipeline orchestrator**

```python
# cv/pipeline.py
"""Main pipeline: image → SimpleFloorPlanInput JSON."""

import cv2
import numpy as np

from cv.preprocess import prepare
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.ocr import extract_text_regions
from cv.dimensions import parse_dimension
from cv.output import build_floor_plan_input


def analyze_floor_plan(
    image_path: str,
    name: str = "Extracted Floor Plan",
) -> dict:
    """Full pipeline: load image → detect rooms → OCR → output JSON.

    Args:
        image_path: Path to floor plan image
        name: Name for the output floor plan

    Returns:
        Dict with "rooms", "openings" (if detectable), and "meta" (diagnostics)
    """
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")

    return analyze_image(image, name=name)


def analyze_image(
    image: np.ndarray,
    name: str = "Extracted Floor Plan",
) -> dict:
    """Analyze an in-memory image (BGR numpy array)."""
    h, w = image.shape[:2]

    # Step 1: Preprocess → binary wall mask
    binary = prepare(image)

    # Step 2: Detect walls
    walls = detect_walls(binary)

    # Step 3: Detect rooms (enclosed regions)
    rooms = detect_rooms(binary)

    # Step 4: OCR — extract all text
    text_regions = extract_text_regions(image)

    # Step 5: Calibrate scale (pixels → cm)
    scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))

    # Step 6: Build output
    result = build_floor_plan_input(
        rooms=rooms,
        text_regions=text_regions,
        image_shape=(h, w),
        scale_cm_per_px=scale,
        name=name,
    )

    # Add metadata for debugging
    result["meta"] = {
        "image_size": (w, h),
        "scale_cm_per_px": scale,
        "walls_detected": len(walls),
        "rooms_detected": len(rooms),
        "text_regions": len(text_regions),
    }

    return result


def _calibrate_scale(
    walls: list[dict],
    text_regions: list[dict],
    image_shape: tuple[int, int],
) -> float:
    """Determine the pixels-to-cm conversion factor.

    Strategy:
    1. Find dimension labels (e.g., "3.30m") near walls
    2. Match each dimension to the nearest wall segment
    3. Compute scale = dimension_cm / wall_length_px
    4. Use median of all matches for robustness

    Fallback: Assume a standard apartment width (1000cm) maps to image width.
    """
    import math

    matches = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is None or cm <= 0:
            continue

        tx, ty = tr["center"]

        # Match dimension to nearest wall with compatible orientation.
        # A label below/above a wall likely measures horizontal span.
        # A label left/right of a wall likely measures vertical span.
        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)

            # Check orientation compatibility:
            # Horizontal dimension text (below/above wall) → horizontal wall
            # Vertical dimension text (left/right of wall) → vertical wall
            mx, my = (sx + ex) / 2, (sy + ey) / 2
            dx, dy = abs(tx - mx), abs(ty - my)

            if wall_horizontal and dy > dx:
                # Label is above/below a horizontal wall — good match
                dist = dy
            elif not wall_horizontal and dx > dy:
                # Label is left/right of a vertical wall — good match
                dist = dx
            else:
                continue  # Orientation mismatch, skip

            if dist < best_dist:
                best_dist = dist
                best_wall = wall

        if best_wall is not None and best_dist < max(image_shape) * 0.3:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            wall_px = math.hypot(ex - sx, ey - sy)
            if wall_px > 10:
                matches.append(cm / wall_px)

    if matches:
        # Use median for robustness against outliers
        matches.sort()
        return matches[len(matches) // 2]

    # Fallback: assume image width ≈ 1000cm (10m, typical apartment)
    return 1000.0 / image_shape[1]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_pipeline.py -v
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add cv-service/cv/pipeline.py cv-service/tests/test_pipeline.py
git commit -m "feat(cv): pipeline orchestrator with scale calibration"
```

---

### Task 8: FastAPI Endpoint — POST /analyze

**Files:**
- Modify: `cv-service/app.py`
- Create: `cv-service/tests/test_app.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_app.py
import base64
import cv2
import numpy as np
import pytest
from httpx import AsyncClient, ASGITransport
from app import app


@pytest.fixture
def b64_simple_image(simple_2room_image) -> str:
    _, buf = cv2.imencode(".png", simple_2room_image)
    return base64.b64encode(buf.tobytes()).decode()


@pytest.mark.anyio
async def test_analyze_endpoint(b64_simple_image):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/analyze", json={
            "image": b64_simple_image,
            "name": "Test Plan",
        })

    assert resp.status_code == 200
    data = resp.json()
    assert "rooms" in data
    assert len(data["rooms"]) >= 1
    assert "meta" in data


@pytest.mark.anyio
async def test_analyze_rejects_invalid_image():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/analyze", json={
            "image": "not-valid-base64!@#$",
        })

    assert resp.status_code == 422 or resp.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cv-service && python -m pytest tests/test_app.py -v
# Expected: FAIL
```

- [ ] **Step 3: Implement the /analyze endpoint**

Update `cv-service/app.py`:

```python
import base64
import logging

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from cv.pipeline import analyze_image

app = FastAPI(title="Floor Plan CV Service")
log = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    status: str


class AnalyzeRequest(BaseModel):
    image: str = Field(description="Base64-encoded PNG/JPG image")
    name: str = Field(default="Extracted Floor Plan")


class RoomOutput(BaseModel):
    label: str
    x: int
    y: int
    width: int
    depth: int


class MetaOutput(BaseModel):
    image_size: tuple[int, int]
    scale_cm_per_px: float
    walls_detected: int
    rooms_detected: int
    text_regions: int


class AnalyzeResponse(BaseModel):
    name: str
    rooms: list[RoomOutput]
    openings: list[dict] = []
    meta: MetaOutput


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """Analyze a floor plan image and extract room geometries."""
    try:
        raw = base64.b64decode(req.image)
    except Exception:
        raise HTTPException(400, "Invalid base64 image data")

    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "Could not decode image (not a valid PNG/JPG)")

    try:
        result = analyze_image(image, name=req.name)
    except Exception as e:
        log.exception("CV pipeline failed")
        raise HTTPException(500, f"Analysis failed: {e}")

    return AnalyzeResponse(**result)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cv-service && python -m pytest tests/test_app.py -v
# Expected: PASS
```

- [ ] **Step 5: End-to-end Docker test**

```bash
cd cv-service
docker compose up --build -d
# Wait for startup
sleep 3
# Test with a small base64 image
python -c "
import base64, cv2, numpy as np, json, urllib.request
img = np.ones((200,300,3), dtype=np.uint8)*255
cv2.rectangle(img, (10,10), (290,190), (0,0,0), 5)
_, buf = cv2.imencode('.png', img)
b64 = base64.b64encode(buf.tobytes()).decode()
data = json.dumps({'image': b64}).encode()
req = urllib.request.Request('http://localhost:8100/analyze', data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req)
print(json.loads(resp.read()))
"
docker compose down
```

- [ ] **Step 6: Commit**

```bash
git add cv-service/app.py cv-service/tests/test_app.py
git commit -m "feat(cv): POST /analyze endpoint — base64 image to room JSON"
```

---

### Task 9: MCP Integration — analyze_floor_plan_image Tool

**Files:**
- Modify: `src/index.ts` — add new MCP tool registration
- Modify: `src/sketch/tools.ts` — add handler function

- [ ] **Step 1: Add handler in tools.ts**

Add to `src/sketch/tools.ts`:

```typescript
export async function handleAnalyzeImage(
  imageBase64: string,
  name: string,
  cvServiceUrl: string,
): Promise<ToolResult> {
  const resp = await fetch(`${cvServiceUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageBase64, name }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: [{ type: 'text', text: `CV analysis failed: ${err}` }] };
  }

  const result = await resp.json() as {
    name: string;
    rooms: Array<{ label: string; x: number; y: number; width: number; depth: number }>;
    meta: { walls_detected: number; rooms_detected: number; scale_cm_per_px: number };
  };

  const summary = [
    `**CV Analysis Complete** — ${result.rooms.length} rooms detected`,
    `Scale: ${result.meta.scale_cm_per_px.toFixed(2)} cm/px`,
    `Walls: ${result.meta.walls_detected}, Text regions: ${result.meta.rooms_detected}`,
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
    'Use this as input to `generate_floor_plan` — review and adjust positions/dimensions first.',
  ].join('\n');

  return { content: [{ type: 'text', text: summary }] };
}
```

- [ ] **Step 2: Register MCP tool in index.ts**

Add tool registration in `src/index.ts` alongside existing tools. Follow the existing pattern which uses Zod schemas and a separate handler callback:

```typescript
this.server.registerTool('analyze_floor_plan_image', {
  description: 'Analyze a floor plan image using computer vision to extract room geometries. Returns structured JSON with room positions, dimensions, and labels that can be passed to generate_floor_plan. Use this BEFORE generate_floor_plan when the user provides a floor plan image to copy.',
  inputSchema: {
    image: z.string().describe('Base64-encoded floor plan image (PNG or JPG)'),
    name: z.string().optional().describe('Name for the floor plan'),
  },
}, async ({ image, name }) => {
  const cvUrl = this.env.CV_SERVICE_URL || 'http://localhost:8100';
  return handleAnalyzeImage(image, name || 'Extracted Floor Plan', cvUrl);
});
```

- [ ] **Step 3: Add CV_SERVICE_URL to wrangler.toml**

```toml
[vars]
CV_SERVICE_URL = "https://cv.your-domain.com"  # Update after deploying CV service
```

And add `CV_SERVICE_URL` to the `Env` interface in `src/types.ts`:

```typescript
CV_SERVICE_URL?: string;
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/sketch/tools.ts wrangler.toml src/types.ts
git commit -m "feat: analyze_floor_plan_image MCP tool — calls CV service"
```

---

### Task 10: Deployment & End-to-End Test

**Files:**
- Modify: `cv-service/Dockerfile` (if needed)
- Create: `cv-service/fly.toml` (or similar deployment config)

- [ ] **Step 1: Choose deployment target**

Options (discuss with user):
- **Fly.io** — simple Docker deployment, free tier, low latency
- **Railway** — similar, Docker-based
- **VPS** — cheapest long-term, most control
- **Google Cloud Run** — serverless, pay-per-request

- [ ] **Step 2: Deploy CV service**

Example for Fly.io:

```bash
cd cv-service
fly launch --name roomsketcher-cv --region iad --no-deploy
fly deploy
fly status
# Note the URL: https://roomsketcher-cv.fly.dev
```

- [ ] **Step 3: Update wrangler.toml with production CV_SERVICE_URL**

```bash
# Update CV_SERVICE_URL in wrangler.toml to the deployed URL
```

- [ ] **Step 4: Deploy MCP worker**

```bash
bash deploy.sh
```

- [ ] **Step 5: End-to-end test**

Use the MCP tool to analyze the residence-507 floor plan image and verify the output matches the expected room layout.

- [ ] **Step 6: Commit any deployment config**

```bash
git add cv-service/fly.toml wrangler.toml
git commit -m "chore: deployment config for CV service"
```

---

## Post-MVP Improvements (Not in scope)

These are documented for future reference but **not part of this plan**:

1. **Opening detection** — detect door arcs and window symbols in the image
2. **Furniture detection** — identify furniture icons and classify them
3. **L-shaped room support** — detect non-rectangular rooms via polygon fitting
4. **Scale bar detection** — find and parse scale bars (e.g., "1' 5' 10'")
5. **Caching** — cache results by image hash to avoid re-processing
6. **Confidence scoring** — return per-room confidence so the LLM knows what to double-check
