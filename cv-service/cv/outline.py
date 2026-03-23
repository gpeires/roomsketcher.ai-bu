"""Extract building outline and spatial grid from floor plan images.

The outline is the outer perimeter of the building — extracted by finding
the largest filled region after sealing all wall gaps (doors, windows).

The spatial grid is an ASCII map showing where each room sits within the
outline, giving the AI agent a structured "visual" of the layout.
"""
import logging
import math
import os
import re

import cv2
import numpy as np

log = logging.getLogger(__name__)

# Patterns that indicate junk text (not a room label)
_JUNK_PATTERNS = [
    re.compile(r'^\d+$'),                          # pure numbers
    re.compile(r'^\d+[\'\"]'),                      # dimension fragments: 15'1"
    re.compile(r'[xX×]\s*\d'),                      # dimension pairs: 10'9" x 8'
    re.compile(r'\d+\s*[xX×]\s*\d'),                # "5x3"
    re.compile(r'[\'\"″′]'),                        # foot/inch marks — dimension fragments
    re.compile(r'[{}\\|()]'),                        # special characters — OCR garbage
    re.compile(r'^\d+-'),                            # digit-hyphen fragments: "8-", "8-7"
    re.compile(r'\d+\s*bedroom', re.I),             # "2 Bedroom 2 Bathroom"
    re.compile(r'\d+\s*bathroom', re.I),
    re.compile(r'^\d+\s+(shore|west|east|north|south|street|avenue|ave|st|dr|drive|blvd)', re.I),  # addresses
    re.compile(r'brooklyn|manhattan|queens|bronx', re.I),  # city names
    re.compile(r'compass|douglas|elliman|corcoran|streeteasy', re.I),  # broker names
    re.compile(r'^\w$'),                            # single character
    re.compile(r'^[A-Z]{1,2}$'),                    # single/double uppercase (P, DW, Ref)
    re.compile(r'^W/D$', re.I),                     # washer/dryer
    re.compile(r'^DW$', re.I),                      # dishwasher
    re.compile(r'^Ref$', re.I),                     # refrigerator
]

# Short lowercase words that ARE valid room abbreviations (not junk)
_VALID_SHORT_LABELS = {"cl", "wic", "ba", "br", "lr", "dr", "kt", "dn", "fo", "en"}


def _is_junk_label(text: str) -> bool:
    """Check if text is NOT a room label (dimension, address, broker, etc.)."""
    text = text.strip()
    if len(text) < 2:
        return True
    # Short lowercase text (< 3 chars) is junk unless it's a known room abbreviation
    if len(text) <= 2 and text.lower() in _VALID_SHORT_LABELS:
        return False
    for pat in _JUNK_PATTERNS:
        if pat.search(text):
            return True
    # Short lowercase words that aren't known room types are likely OCR garbage
    if len(text) <= 3 and text[0].islower() and text.isalpha():
        if text.lower() not in _VALID_SHORT_LABELS:
            return True
    return False


def _find_dimension_for_room(
    room_bbox: tuple[int, int, int, int],
    room_centroid: tuple[int, int],
    text_regions: list[dict],
    parse_dimension_fn,
) -> str | None:
    """Find dimension text (e.g. "12'8\" x 8'8\"") near a room."""
    rx, ry, rw, rh = room_bbox
    rcx, rcy = room_centroid
    best_dim = None
    best_dist = float("inf")
    for tr in text_regions:
        text = tr["text"].strip()
        # Must contain a parseable dimension
        if parse_dimension_fn(text) is None:
            continue
        # Check for compound dimension (width x depth)
        if not re.search(r'[xX×]', text):
            continue
        tx, ty = tr["center"]
        # Must be inside or near the room
        if not (rx - rw * 0.3 <= tx <= rx + rw * 1.3 and ry - rh * 0.3 <= ty <= ry + rh * 1.3):
            continue
        dist = math.hypot(tx - rcx, ty - rcy)
        if dist < best_dist:
            best_dist = dist
            best_dim = text
    return best_dim


def _sam2_mask(
    image_url: str,
    floor_plan_bbox: tuple[int, int, int, int],
) -> np.ndarray | None:
    """Call Replicate SAM2 auto-segmenter to get a building mask.

    SAM2 returns multiple mask images sorted by predicted IoU. We download
    each, threshold to binary, and pick the one with the best overlap with
    the floor plan bounding box — the building footprint mask.

    Returns a binary mask (255=building, 0=background) or None on failure.
    """
    api_token = os.environ.get("REPLICATE_API_TOKEN")
    if not api_token:
        log.warning("SAM2: REPLICATE_API_TOKEN not set, skipping")
        return None

    try:
        import replicate
    except ImportError:
        log.warning("SAM2: replicate package not installed, skipping")
        return None

    fx, fy, fw, fh = floor_plan_bbox
    center_x = fx + fw // 2
    center_y = fy + fh // 2

    log.info("SAM2: calling auto-segmenter for bbox (%d,%d,%d,%d), center (%d,%d)",
             fx, fy, fw, fh, center_x, center_y)

    try:
        import httpx

        output = replicate.run(
            "lucataco/segment-anything-2",
            input={
                "image": image_url,
                "points_per_side": 32,
                "pred_iou_thresh": 0.7,
                "mask_limit": 10,
            },
        )

        # output is a list of mask image URLs, sorted by predicted_iou
        mask_urls = list(output) if not isinstance(output, list) else output
        log.info("SAM2: received %d mask URLs", len(mask_urls))

        if not mask_urls:
            log.warning("SAM2: no masks returned")
            return None

        # Score each mask: prefer large masks that cover the floor plan center
        best_mask = None
        best_score = -1

        for i, url in enumerate(mask_urls):
            try:
                resp = httpx.get(str(url), follow_redirects=True, timeout=30.0)
                resp.raise_for_status()
                arr = np.frombuffer(resp.content, dtype=np.uint8)
                mask = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
                if mask is None:
                    continue

                _, binary_mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
                total_px = binary_mask.shape[0] * binary_mask.shape[1]
                mask_area = cv2.countNonZero(binary_mask)

                # Check if mask covers the floor plan center
                covers_center = (
                    0 <= center_y < binary_mask.shape[0]
                    and 0 <= center_x < binary_mask.shape[1]
                    and binary_mask[center_y, center_x] > 0
                )

                # Score: coverage of floor plan bbox area, with bonus for covering center
                # Crop mask to floor plan bbox and measure overlap
                y0, y1 = max(0, fy), min(binary_mask.shape[0], fy + fh)
                x0, x1 = max(0, fx), min(binary_mask.shape[1], fx + fw)
                if y1 > y0 and x1 > x0:
                    bbox_region = binary_mask[y0:y1, x0:x1]
                    bbox_coverage = cv2.countNonZero(bbox_region) / (bbox_region.shape[0] * bbox_region.shape[1])
                else:
                    bbox_coverage = 0

                # Penalize masks that are too large (nearly full image — background)
                coverage = mask_area / total_px
                if coverage > 0.9:
                    bbox_coverage *= 0.1  # nearly full image, likely background

                score = bbox_coverage * (2.0 if covers_center else 0.5)

                log.info("SAM2: mask %d — coverage=%.1f%%, bbox_coverage=%.1f%%, center=%s, score=%.3f",
                         i, coverage * 100, bbox_coverage * 100, covers_center, score)

                if score > best_score:
                    best_score = score
                    best_mask = binary_mask

            except Exception as e:
                log.warning("SAM2: failed to fetch mask %d: %s", i, e)
                continue

        if best_mask is None:
            log.warning("SAM2: no valid masks after scoring")
            return None

        nonzero = cv2.countNonZero(best_mask)
        total = best_mask.shape[0] * best_mask.shape[1]
        log.info("SAM2: selected mask — coverage=%.1f%%, score=%.3f", nonzero / total * 100, best_score)

        if nonzero < total * 0.05:
            log.warning("SAM2: best mask too small (%.1f%%), discarding", nonzero / total * 100)
            return None

        return best_mask

    except Exception as e:
        log.warning("SAM2: call failed: %s", e)
        return None


def _contour_to_outline(
    mask: np.ndarray,
    scale_cm_per_px: float,
    snap_cm: int,
    crop_offset: tuple[int, int] = (0, 0),
    min_area_ratio: float = 0.05,
) -> list[dict] | None:
    """Convert a binary mask to a simplified outline polygon in cm.

    Finds the largest contour, simplifies it, converts to cm, snaps to grid,
    and normalizes origin to (0, 0).
    """
    h, w = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)

    if area < h * w * min_area_ratio:
        log.warning("Contour too small (%.1f%% of image)", area / (h * w) * 100)
        return None

    perimeter = cv2.arcLength(largest, True)
    epsilon = 0.003 * perimeter
    simplified = cv2.approxPolyDP(largest, epsilon, True)

    crop_x, crop_y = crop_offset
    raw_points = []
    for pt in simplified:
        x_px, y_px = pt[0]
        x_cm = (x_px + crop_x) * scale_cm_per_px
        y_cm = (y_px + crop_y) * scale_cm_per_px
        raw_points.append((x_cm, y_cm))

    min_x = min(p[0] for p in raw_points)
    min_y = min(p[1] for p in raw_points)

    outline_cm = []
    for x_cm, y_cm in raw_points:
        x = round((x_cm - min_x) / snap_cm) * snap_cm
        y = round((y_cm - min_y) / snap_cm) * snap_cm
        if not outline_cm or (x != outline_cm[-1]["x"] or y != outline_cm[-1]["y"]):
            outline_cm.append({"x": x, "y": y})

    if len(outline_cm) > 2 and outline_cm[0] == outline_cm[-1]:
        outline_cm.pop()

    log.info("Outline: %d vertices, area=%.0f px²", len(outline_cm), area)
    return outline_cm


def extract_outline(
    binary: np.ndarray,
    scale_cm_per_px: float,
    floor_plan_bbox: tuple[int, int, int, int] | None = None,
    snap_cm: int = 10,
    image_url: str | None = None,
) -> list[dict] | None:
    """Extract the building perimeter polygon from a binary wall mask.

    Algorithm:
    1. Crop to floor plan bounding box (exclude footer/logos)
    2. Heavy morphological closing to seal ALL gaps (doors, windows)
    3. Flood fill from image border to mark exterior
    4. Interior = everything NOT exterior
    5. Find largest external contour
    6. Simplify with approxPolyDP
    7. Snap to grid, convert to cm, normalize origin to (0,0)

    Args:
        binary: Binary wall mask (walls=255, rooms=0).
        scale_cm_per_px: Scale factor from pixel coords to centimeters.
        floor_plan_bbox: (x, y, w, h) of just the floor plan area (excludes footer).
        snap_cm: Grid size for snapping outline vertices (cm).

    Returns:
        List of {x, y} points in cm forming the building perimeter polygon
        with origin normalized to (0,0), or None if extraction fails.
    """
    h, w = binary.shape

    # Try SAM2 first if we have an image URL and bbox
    if image_url and floor_plan_bbox:
        sam2_mask = _sam2_mask(image_url, floor_plan_bbox)
        if sam2_mask is not None:
            sam2_outline = _contour_to_outline(sam2_mask, scale_cm_per_px, snap_cm, crop_offset=(0, 0))
            if sam2_outline:
                log.info("SAM2 outline: %d vertices (using SAM2 result)", len(sam2_outline))
                return sam2_outline
            log.warning("SAM2: mask produced no valid outline, falling back to OpenCV")

    # Crop to floor plan bbox if provided (removes footer, logos, compass)
    crop_x, crop_y = 0, 0
    if floor_plan_bbox:
        fx, fy, fw, fh = floor_plan_bbox
        # Add small margin
        margin = 5
        x0 = max(0, fx - margin)
        y0 = max(0, fy - margin)
        x1 = min(w, fx + fw + margin)
        y1 = min(h, fy + fh + margin)
        binary = binary[y0:y1, x0:x1].copy()
        crop_x, crop_y = x0, y0
        h, w = binary.shape

    # Step 1: Heavy morphological closing to seal all openings
    gap_size = max(20, min(120, max(h, w) // 8))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (gap_size, gap_size))
    sealed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Step 2: Flood fill from image border to mark exterior
    pad = 2
    padded = np.zeros((h + 2 * pad, w + 2 * pad), dtype=np.uint8)
    padded[pad:pad + h, pad:pad + w] = sealed

    # Invert: rooms/interior = 255, walls = 0
    inv = cv2.bitwise_not(padded)

    # Flood fill from (0,0) — marks the exterior region
    flood_mask = np.zeros((h + 2 * pad + 2, w + 2 * pad + 2), dtype=np.uint8)
    cv2.floodFill(inv, flood_mask, (0, 0), 128)

    # Interior = pixels still at 255 (not exterior, not walls)
    interior = (inv == 255).astype(np.uint8) * 255

    # Remove padding
    interior = interior[pad:pad + h, pad:pad + w]

    # Include walls as part of building footprint
    building = cv2.bitwise_or(interior, sealed)

    # Step 3–5: Find contour, simplify, convert to cm
    return _contour_to_outline(building, scale_cm_per_px, snap_cm, crop_offset=(crop_x, crop_y))


def _make_room_abbreviation(label: str, used: set[str]) -> str:
    """Generate a short unique abbreviation for a room label."""
    abbrevs = {
        "living": "LV", "living room": "LV", "living/dining": "LD",
        "living/dining room": "LD", "dining": "DN", "dining room": "DN",
        "kitchen": "KT", "bedroom": "BR", "bathroom": "BA", "bath": "BA",
        "closet": "CL", "cl": "CL", "wic": "WI", "walk-in closet": "WI",
        "hallway": "HL", "hall": "HL", "foyer": "FO", "entry": "EN",
        "balcony": "BL", "terrace": "TR", "laundry": "LA",
        "office": "OF", "study": "ST", "den": "DN",
        "garage": "GA", "storage": "SG", "utility": "UT",
        "master bedroom": "MB", "master bath": "MB",
        "powder room": "PR", "pantry": "PN",
        "dressing": "DR", "dressing room": "DR",
    }
    lower = label.lower().strip()

    base = abbrevs.get(lower)
    if not base:
        words = [w for w in lower.split() if w not in ("room", "the", "a")]
        if words:
            base = words[0][:2].upper()
        else:
            base = lower[:2].upper()

    candidate = base
    n = 2
    while candidate in used:
        candidate = f"{base}{n}"
        n += 1
    used.add(candidate)
    return candidate


def build_spatial_grid(
    rooms: list[dict],
    text_regions: list[dict],
    scale_cm_per_px: float,
    floor_plan_bbox: tuple[int, int, int, int],
    cell_size_cm: int = 30,
) -> dict | None:
    """Build an ASCII spatial grid showing room layout.

    Each cell represents a cell_size_cm x cell_size_cm area.
    Cells labeled with 2-char room abbreviations.

    Returns dict with 'grid', 'legend' (abbrev -> "Label (WxDcm)"),
    'cell_size_cm', 'origin', 'size'.
    """
    if not rooms or scale_cm_per_px <= 0:
        return None

    from cv.dimensions import parse_dimension

    fp_x, fp_y, fp_w, fp_h = floor_plan_bbox
    cell_px = cell_size_cm / scale_cm_per_px

    cols = max(1, int(math.ceil(fp_w / cell_px)))
    rows = max(1, int(math.ceil(fp_h / cell_px)))

    # Cap grid size
    if cols * rows > 5000:
        cell_size_cm = int(math.ceil(math.sqrt(fp_w * fp_h * scale_cm_per_px**2 / 2000)))
        cell_px = cell_size_cm / scale_cm_per_px
        cols = max(1, int(math.ceil(fp_w / cell_px)))
        rows = max(1, int(math.ceil(fp_h / cell_px)))

    # Assign labels and dimensions to rooms using OCR
    room_labels = []
    room_dims = []
    for room in rooms:
        rx, ry, rw, rh = room["bbox"]
        rcx, rcy = room["centroid"]

        # Find room name label
        best_label = None
        best_dist = float("inf")
        for tr in text_regions:
            text = tr["text"].strip()
            if parse_dimension(text) is not None:
                continue
            if _is_junk_label(text):
                continue

            tx, ty = tr["center"]
            inside = (rx - rw * 0.2 <= tx <= rx + rw * 1.2 and
                      ry - rh * 0.2 <= ty <= ry + rh * 1.2)
            if not inside:
                continue
            dist = math.hypot(tx - rcx, ty - rcy)
            if dist < best_dist:
                best_dist = dist
                best_label = text

        room_labels.append(best_label or f"Room {len(room_labels) + 1}")

        # Find dimension text for this room
        dim_text = _find_dimension_for_room((rx, ry, rw, rh), (rcx, rcy), text_regions, parse_dimension)
        room_dims.append(dim_text)

    # Generate unique abbreviations
    used_abbrevs: set[str] = set()
    abbrevs = []
    for label in room_labels:
        abbrevs.append(_make_room_abbreviation(label, used_abbrevs))

    # Build the grid
    grid = [["  "] * cols for _ in range(rows)]

    for room_idx, room in enumerate(rooms):
        mask = room.get("mask")
        if mask is None:
            continue
        abbrev = abbrevs[room_idx]

        for r in range(rows):
            for c in range(cols):
                if grid[r][c] != "  ":
                    continue
                px = fp_x + (c + 0.5) * cell_px
                py = fp_y + (r + 0.5) * cell_px
                ix, iy = int(px), int(py)
                if 0 <= iy < mask.shape[0] and 0 <= ix < mask.shape[1] and mask[iy, ix] > 0:
                    grid[r][c] = abbrev

    # Format grid lines
    max_abbrev_len = max((len(a) for a in abbrevs), default=2)
    pad_width = max(2, max_abbrev_len)
    dot = "·" + " " * (pad_width - 1)

    grid_lines = []
    for row in grid:
        cells = []
        for cell in row:
            if cell == "  ":
                cells.append(dot)
            else:
                cells.append(cell.ljust(pad_width))
        grid_lines.append(" ".join(cells))

    # Build legend with dimensions
    legend = {}
    for i, abbrev in enumerate(abbrevs):
        entry = room_labels[i]
        if room_dims[i]:
            entry += f" ({room_dims[i]})"
        legend[abbrev] = entry

    origin_x_cm = round(fp_x * scale_cm_per_px)
    origin_y_cm = round(fp_y * scale_cm_per_px)

    log.info("Spatial grid: %dx%d cells (%dcm each), %d rooms mapped",
             cols, rows, cell_size_cm, len(rooms))

    return {
        "grid": grid_lines,
        "legend": legend,
        "cell_size_cm": cell_size_cm,
        "origin": {"x": origin_x_cm, "y": origin_y_cm},
        "size": {"cols": cols, "rows": rows},
    }
