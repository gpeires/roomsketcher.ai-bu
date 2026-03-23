"""Extract building outline and spatial grid from floor plan images.

The outline is the outer perimeter of the building — extracted by finding
the largest filled region after sealing all wall gaps (doors, windows).

The spatial grid is an ASCII map showing where each room sits within the
outline, giving the AI agent a structured "visual" of the layout.
"""
import logging
import math
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


def _is_junk_label(text: str) -> bool:
    """Check if text is NOT a room label (dimension, address, broker, etc.)."""
    text = text.strip()
    if len(text) < 2:
        return True
    for pat in _JUNK_PATTERNS:
        if pat.search(text):
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


def extract_outline(
    binary: np.ndarray,
    scale_cm_per_px: float,
    floor_plan_bbox: tuple[int, int, int, int] | None = None,
    snap_cm: int = 10,
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

    # Step 3: Find the largest external contour
    contours, _ = cv2.findContours(building, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        log.warning("No contours found for building outline")
        return None

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)

    if area < h * w * 0.05:
        log.warning("Largest contour too small (%.1f%% of image)", area / (h * w) * 100)
        return None

    # Step 4: Simplify polygon
    perimeter = cv2.arcLength(largest, True)
    epsilon = 0.008 * perimeter
    simplified = cv2.approxPolyDP(largest, epsilon, True)

    # Step 5: Convert to cm, snap to grid, normalize to (0,0)
    raw_points = []
    for pt in simplified:
        x_px, y_px = pt[0]
        # Convert back to full image coords if we cropped
        x_cm = (x_px + crop_x) * scale_cm_per_px
        y_cm = (y_px + crop_y) * scale_cm_per_px
        raw_points.append((x_cm, y_cm))

    # Find min x/y to normalize origin
    min_x = min(p[0] for p in raw_points)
    min_y = min(p[1] for p in raw_points)

    outline_cm = []
    for x_cm, y_cm in raw_points:
        x = round((x_cm - min_x) / snap_cm) * snap_cm
        y = round((y_cm - min_y) / snap_cm) * snap_cm
        if not outline_cm or (x != outline_cm[-1]["x"] or y != outline_cm[-1]["y"]):
            outline_cm.append({"x": x, "y": y})

    # Close polygon if needed
    if len(outline_cm) > 2 and outline_cm[0] == outline_cm[-1]:
        outline_cm.pop()

    log.info("Outline extracted: %d vertices, area=%.0f px²", len(outline_cm), area)
    return outline_cm


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
