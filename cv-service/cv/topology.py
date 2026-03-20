"""Detect room adjacency by analyzing shared walls between room masks."""
import cv2
import numpy as np


def detect_adjacency(
    rooms: list[dict],
    binary: np.ndarray,
    wall_thickness: int = 15,
) -> list[dict]:
    """Detect which rooms share walls (are adjacent).

    For each pair of rooms, dilate both masks by the wall thickness and
    check for overlap.  If the dilated masks overlap, the rooms share a
    wall.  The overlap region's shape tells us the wall's orientation
    and extent.

    Args:
        rooms: Room dicts from detect_rooms(), each with 'mask' and 'bbox'.
        binary: Original binary wall mask (walls=255).
        wall_thickness: Dilation amount in pixels (~wall width).

    Returns:
        List of adjacency dicts with keys:
            room_a_idx: index of first room
            room_b_idx: index of second room
            orientation: 'horizontal' or 'vertical'
            shared_length_px: length of shared wall in pixels
            shared_center_px: (x, y) center of the shared wall
    """
    if len(rooms) < 2:
        return []

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (wall_thickness, wall_thickness))

    # Pre-compute dilated masks
    dilated = []
    for room in rooms:
        mask = room["mask"]
        d = cv2.dilate(mask, kernel, iterations=1)
        dilated.append(d)

    adjacencies = []
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            overlap = cv2.bitwise_and(dilated[i], dilated[j])
            overlap_area = np.count_nonzero(overlap)

            if overlap_area < wall_thickness:
                continue

            # Find overlap bounding box to determine orientation
            ys, xs = np.nonzero(overlap)
            if len(xs) == 0:
                continue

            ox_min, ox_max = int(xs.min()), int(xs.max())
            oy_min, oy_max = int(ys.min()), int(ys.max())
            ow = ox_max - ox_min
            oh = oy_max - oy_min

            if ow > oh:
                orientation = "horizontal"
                shared_length = ow
            else:
                orientation = "vertical"
                shared_length = oh

            cx = (ox_min + ox_max) // 2
            cy = (oy_min + oy_max) // 2

            adjacencies.append({
                "room_a_idx": i,
                "room_b_idx": j,
                "orientation": orientation,
                "shared_length_px": shared_length,
                "shared_center_px": (cx, cy),
            })

    return adjacencies
