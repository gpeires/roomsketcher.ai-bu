"""Room detection via flood fill on the inverse of the wall mask."""
import cv2
import numpy as np


def detect_rooms(binary: np.ndarray, min_room_ratio: float = 0.02) -> list[dict]:
    """Detect room regions from a binary wall mask (walls=255, rooms=0).

    Strategy:
    1. Close the wall mask with elongated kernels in both directions so that
       door openings in interior walls are bridged, preventing rooms from
       merging through doorways.
    2. Invert the closed mask so rooms are foreground.
    3. Use connected-component analysis to enumerate enclosed regions.
    4. Filter by minimum area and exclude large border-touching regions
       (the exterior of the building).

    Args:
        binary: Binary wall mask from preprocess.prepare() (walls=255, rooms=0).
        min_room_ratio: Minimum room area as a fraction of the image area.

    Returns:
        List of dicts with keys:
            bbox:     (x, y, w, h) bounding box
            area_px:  area in pixels
            centroid: (cx, cy) centroid coordinates
            mask:     single-channel binary mask for this room
    """
    h, w = binary.shape
    min_area = int(h * w * min_room_ratio)

    # Close door gaps in interior walls so each room is a separate component.
    # A vertical kernel bridges gaps in vertical interior walls (doors) and
    # a horizontal kernel does the same for horizontal interior walls.
    gap_size = max(h, w) // 3  # large enough to span any realistic door
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
        rooms.append({
            "bbox": (x, y, rw, rh),
            "area_px": area,
            "centroid": (int(cx), int(cy)),
            "mask": room_mask,
        })

    return rooms
