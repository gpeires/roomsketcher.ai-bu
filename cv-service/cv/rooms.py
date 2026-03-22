"""Room detection via flood fill on the inverse of the wall mask."""
import math

import cv2
import numpy as np


def detect_rooms(
    binary: np.ndarray,
    min_room_ratio: float = 0.005,
) -> tuple[list[dict], np.ndarray]:
    """Detect room regions from a binary wall mask (walls=255, rooms=0).

    Strategy:
    1. Close the wall mask with elongated kernels in both directions so that
       door openings in interior walls are bridged, preventing rooms from
       merging through doorways.
    2. Invert the closed mask so rooms are foreground.
    3. Use connected-component analysis to enumerate enclosed regions.
    4. Filter by minimum area and exclude large border-touching regions
       (the exterior of the building).
    5. Extract simplified polygons from each room's contour.

    Args:
        binary: Binary wall mask from preprocess.prepare() (walls=255, rooms=0).
        min_room_ratio: Minimum room area as a fraction of the image area.

    Returns:
        Tuple of (rooms, closed_binary) where rooms is a list of dicts with keys:
            bbox:     (x, y, w, h) bounding box
            area_px:  area in pixels
            centroid: (cx, cy) centroid coordinates
            mask:     single-channel binary mask for this room
            polygon:  list of (x, y) vertices (simplified, rectilinear-snapped)
        and closed_binary is the wall mask after door-gap closing (for opening detection).
    """
    h, w = binary.shape
    min_area = int(h * w * min_room_ratio)

    # Close door gaps in interior walls so each room is a separate component.
    gap_size = max(15, min(80, max(h, w) // 10))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap_size))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, v_kernel, iterations=1)
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (gap_size, 1))
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, h_kernel, iterations=1)

    inv = cv2.bitwise_not(closed)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(inv, connectivity=4)

    rooms = []
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        x = stats[i, cv2.CC_STAT_LEFT]
        y = stats[i, cv2.CC_STAT_TOP]
        rw = stats[i, cv2.CC_STAT_WIDTH]
        rh = stats[i, cv2.CC_STAT_HEIGHT]
        cx, cy = centroids[i]

        # Exclude the exterior background region: large and touching the image border
        touches_border = x == 0 or y == 0 or (x + rw) >= w or (y + rh) >= h
        if touches_border and area > (h * w * 0.3):
            continue

        room_mask = (labels == i).astype(np.uint8) * 255
        polygon = _extract_polygon(room_mask)
        rooms.append({
            "bbox": (x, y, rw, rh),
            "area_px": area,
            "centroid": (int(cx), int(cy)),
            "mask": room_mask,
            "polygon": polygon,
        })

    return rooms, closed


def _extract_polygon(
    room_mask: np.ndarray,
    grid: int = 5,
) -> list[tuple[int, int]]:
    """Extract a simplified polygon from a room's binary mask.

    Uses contour detection + Douglas-Peucker simplification, then snaps
    vertices to a grid to produce clean rectilinear shapes typical of
    floor plans.

    Args:
        room_mask: Binary mask (room=255) for a single room.
        grid: Snap grid size in pixels.

    Returns:
        List of (x, y) vertex tuples forming the simplified polygon.
    """
    contours, _ = cv2.findContours(room_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    largest = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(largest, True)
    epsilon = 0.015 * perimeter
    approx = cv2.approxPolyDP(largest, epsilon, True)

    # Snap to grid and deduplicate
    snapped = []
    for pt in approx:
        x = int(round(pt[0][0] / grid) * grid)
        y = int(round(pt[0][1] / grid) * grid)
        if not snapped or (x, y) != snapped[-1]:
            snapped.append((x, y))
    # Remove last if same as first (closed polygon implied)
    if len(snapped) > 1 and snapped[0] == snapped[-1]:
        snapped.pop()

    return _snap_to_rectilinear(snapped, grid)


def _snap_to_rectilinear(
    vertices: list[tuple[int, int]],
    grid: int = 5,
) -> list[tuple[int, int]]:
    """Snap polygon edges to axis-aligned directions where nearly so.

    Floor plan rooms have 90-degree angles.  If an edge deviates < 15 degrees
    from horizontal or vertical, snap the endpoint to make it perfectly
    axis-aligned.
    """
    if len(vertices) < 3:
        return vertices

    threshold_deg = 15
    result = list(vertices)

    for _ in range(2):  # Two passes to propagate corrections
        new = []
        for i, (x, y) in enumerate(result):
            px, py = result[i - 1]
            dx = x - px
            dy = y - py
            if dx == 0 and dy == 0:
                new.append((x, y))
                continue
            angle = abs(math.degrees(math.atan2(dy, dx))) % 180
            # Near horizontal (0 or 180): snap y to previous y
            if angle < threshold_deg or angle > (180 - threshold_deg):
                y = py
            # Near vertical (90): snap x to previous x
            elif abs(angle - 90) < threshold_deg:
                x = px
            # Re-snap to grid
            x = int(round(x / grid) * grid)
            y = int(round(y / grid) * grid)
            new.append((x, y))
        result = new

    # Deduplicate consecutive identical vertices
    deduped = [result[0]]
    for v in result[1:]:
        if v != deduped[-1]:
            deduped.append(v)
    if len(deduped) > 1 and deduped[0] == deduped[-1]:
        deduped.pop()

    return deduped
