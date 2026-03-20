"""Detect door and window openings from wall gaps in the binary mask."""
import cv2
import numpy as np

from cv.walls import extract_segments


def detect_openings(
    binary: np.ndarray,
    closed: np.ndarray,
    rooms: list[dict],
    walls: list[dict],
    scale_cm_per_px: float = 1.0,
) -> list[dict]:
    """Detect door and window openings by comparing original vs closed wall masks.

    Door gaps: regions present in the closed mask but absent in the original.
    Window gaps: breaks in exterior walls that don't connect to interior rooms.

    Args:
        binary: Original binary wall mask (walls=255).
        closed: Wall mask after door-gap closing from detect_rooms().
        rooms: Room dicts with 'mask', 'bbox', 'centroid' keys.
        walls: Wall segment dicts with 'start', 'end', 'thickness' keys.
        scale_cm_per_px: Scale factor for converting pixel sizes to cm.

    Returns:
        List of opening dicts with keys:
            type: 'door' or 'window'
            position_px: (x, y) center of the gap in pixels
            width_px: gap width in pixels
            orientation: 'horizontal' or 'vertical'
            room_a_idx: index of room on one side (or None)
            room_b_idx: index of room on the other side (or None)
    """
    openings = []
    openings.extend(_detect_doors(binary, closed, rooms, scale_cm_per_px))
    openings.extend(_detect_windows(binary, rooms, walls, scale_cm_per_px))
    return openings


def _detect_doors(
    binary: np.ndarray,
    closed: np.ndarray,
    rooms: list[dict],
    scale_cm_per_px: float,
) -> list[dict]:
    """Find door gaps by scanning the original binary mask along wall paths.

    For each wall detected in the closed mask, scan the original mask
    along the wall's path.  Breaks in the original where the closed mask
    has wall pixels are door gaps.
    """
    h, w = binary.shape
    # Use scale to estimate pixel range, but keep min low enough to catch
    # doors in test fixtures and low-res images.
    min_gap_px = 8
    max_gap_px = w // 3

    doors = []

    # Detect wall segments from the CLOSED mask (which has door gaps bridged)
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(w // 10, 30), 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(h // 10, 30)))

    h_lines_closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, h_kernel)
    v_lines_closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, v_kernel)

    h_walls = extract_segments(h_lines_closed, "horizontal")
    v_walls = extract_segments(v_lines_closed, "vertical")

    # For each wall in the closed mask, scan the ORIGINAL mask for gaps
    for wall in h_walls:
        gaps = _find_wall_gaps(binary, wall, is_horizontal=True)
        for gap_start, gap_end, gap_mid in gaps:
            gap_width = gap_end - gap_start
            if gap_width < min_gap_px or gap_width > max_gap_px:
                continue
            cy = (wall["start"][1] + wall["end"][1]) // 2
            room_a, room_b = _find_adjacent_rooms(gap_mid, cy, "horizontal", rooms)
            if room_a is not None and room_b is not None and room_a != room_b:
                doors.append({
                    "type": "door",
                    "position_px": (gap_mid, cy),
                    "width_px": gap_width,
                    "orientation": "horizontal",
                    "room_a_idx": room_a,
                    "room_b_idx": room_b,
                })

    for wall in v_walls:
        gaps = _find_wall_gaps(binary, wall, is_horizontal=False)
        for gap_start, gap_end, gap_mid in gaps:
            gap_width = gap_end - gap_start
            if gap_width < min_gap_px or gap_width > max_gap_px:
                continue
            cx = (wall["start"][0] + wall["end"][0]) // 2
            room_a, room_b = _find_adjacent_rooms(cx, gap_mid, "vertical", rooms)
            if room_a is not None and room_b is not None and room_a != room_b:
                doors.append({
                    "type": "door",
                    "position_px": (cx, gap_mid),
                    "width_px": gap_width,
                    "orientation": "vertical",
                    "room_a_idx": room_a,
                    "room_b_idx": room_b,
                })

    return doors


def _detect_windows(
    binary: np.ndarray,
    rooms: list[dict],
    walls: list[dict],
    scale_cm_per_px: float,
) -> list[dict]:
    """Find window gaps along exterior walls.

    A window is a break in an exterior wall that doesn't connect to another
    room on the other side (i.e., the other side is outside the building).
    """
    h, w = binary.shape
    windows = []

    for wall in walls:
        sx, sy = wall["start"]
        ex, ey = wall["end"]
        thickness = wall.get("thickness", 10)

        is_horizontal = abs(ey - sy) < abs(ex - sx)
        wall_len = max(abs(ex - sx), abs(ey - sy))
        if wall_len < 30:
            continue

        # Check if this is an exterior wall (near image edge)
        if is_horizontal:
            mid_y = (sy + ey) // 2
            is_exterior = mid_y < h * 0.05 or mid_y > h * 0.95
        else:
            mid_x = (sx + ex) // 2
            is_exterior = mid_x < w * 0.05 or mid_x > w * 0.95

        if not is_exterior:
            # Also check if only one room touches this wall
            # (interior walls have rooms on both sides)
            if is_horizontal:
                above = _room_at(rooms, (sx + ex) // 2, min(sy, ey) - thickness * 2)
                below = _room_at(rooms, (sx + ex) // 2, max(sy, ey) + thickness * 2)
                is_exterior = (above is None) != (below is None)
            else:
                left = _room_at(rooms, min(sx, ex) - thickness * 2, (sy + ey) // 2)
                right = _room_at(rooms, max(sx, ex) + thickness * 2, (sy + ey) // 2)
                is_exterior = (left is None) != (right is None)

        if not is_exterior:
            continue

        # Scan along the wall for gaps in the binary mask
        gaps = _find_wall_gaps(binary, wall, is_horizontal)
        min_window_px = max(10, int(40 / max(scale_cm_per_px, 0.1)))
        max_window_px = min(wall_len, int(300 / max(scale_cm_per_px, 0.1)))

        for gap_start, gap_end, gap_mid in gaps:
            gap_width = gap_end - gap_start
            if gap_width < min_window_px or gap_width > max_window_px:
                continue

            if is_horizontal:
                cx, cy = gap_mid, (sy + ey) // 2
            else:
                cx, cy = (sx + ex) // 2, gap_mid

            # Find which room this window belongs to
            room_idx = _room_at(rooms, cx, cy)
            if room_idx is None:
                # Try offset into the room
                offset = thickness * 3
                if is_horizontal:
                    room_idx = _room_at(rooms, cx, cy + offset)
                    if room_idx is None:
                        room_idx = _room_at(rooms, cx, cy - offset)
                else:
                    room_idx = _room_at(rooms, cx + offset, cy)
                    if room_idx is None:
                        room_idx = _room_at(rooms, cx - offset, cy)

            windows.append({
                "type": "window",
                "position_px": (cx, cy),
                "width_px": gap_width,
                "orientation": "horizontal" if is_horizontal else "vertical",
                "room_a_idx": room_idx,
                "room_b_idx": None,
            })

    return windows


def _find_adjacent_rooms(
    cx: int, cy: int,
    orientation: str,
    rooms: list[dict],
) -> tuple[int | None, int | None]:
    """Find the two rooms on either side of a gap at (cx, cy)."""
    search_dist = 30  # pixels to search perpendicular to gap

    if orientation == "vertical":
        # Gap is in a vertical wall — rooms are left and right
        room_a = _room_at(rooms, cx - search_dist, cy)
        room_b = _room_at(rooms, cx + search_dist, cy)
    else:
        # Gap is in a horizontal wall — rooms are above and below
        room_a = _room_at(rooms, cx, cy - search_dist)
        room_b = _room_at(rooms, cx, cy + search_dist)

    # Widen search if needed
    if room_a is None or room_b is None:
        for mult in [2, 3, 4]:
            d = search_dist * mult
            if orientation == "vertical":
                if room_a is None:
                    room_a = _room_at(rooms, cx - d, cy)
                if room_b is None:
                    room_b = _room_at(rooms, cx + d, cy)
            else:
                if room_a is None:
                    room_a = _room_at(rooms, cx, cy - d)
                if room_b is None:
                    room_b = _room_at(rooms, cx, cy + d)
            if room_a is not None and room_b is not None:
                break

    return room_a, room_b


def _room_at(rooms: list[dict], x: int, y: int) -> int | None:
    """Find which room contains the point (x, y) using room masks."""
    for i, room in enumerate(rooms):
        mask = room.get("mask")
        if mask is None:
            continue
        h, w = mask.shape
        if 0 <= y < h and 0 <= x < w and mask[int(y), int(x)] > 0:
            return i
    return None


def _find_wall_gaps(
    binary: np.ndarray,
    wall: dict,
    is_horizontal: bool,
) -> list[tuple[int, int, int]]:
    """Scan along a wall and find gaps (breaks) in the binary mask.

    Returns list of (gap_start, gap_end, gap_midpoint) along the wall's axis.
    """
    sx, sy = wall["start"]
    ex, ey = wall["end"]
    thickness = wall.get("thickness", 10)
    half_t = max(thickness // 2, 3)

    gaps = []
    if is_horizontal:
        start_pos = min(sx, ex)
        end_pos = max(sx, ex)
        wall_y = (sy + ey) // 2
        in_gap = False
        gap_start = 0

        for x in range(start_pos, end_pos):
            # Check a strip perpendicular to the wall
            y_lo = max(0, wall_y - half_t)
            y_hi = min(binary.shape[0], wall_y + half_t)
            col = binary[y_lo:y_hi, x]
            has_wall = np.any(col > 0)

            if not has_wall and not in_gap:
                in_gap = True
                gap_start = x
            elif has_wall and in_gap:
                in_gap = False
                gaps.append((gap_start, x, (gap_start + x) // 2))

        if in_gap:
            gaps.append((gap_start, end_pos, (gap_start + end_pos) // 2))
    else:
        start_pos = min(sy, ey)
        end_pos = max(sy, ey)
        wall_x = (sx + ex) // 2
        in_gap = False
        gap_start = 0

        for y in range(start_pos, end_pos):
            x_lo = max(0, wall_x - half_t)
            x_hi = min(binary.shape[1], wall_x + half_t)
            row = binary[y, x_lo:x_hi]
            has_wall = np.any(row > 0)

            if not has_wall and not in_gap:
                in_gap = True
                gap_start = y
            elif has_wall and in_gap:
                in_gap = False
                gaps.append((gap_start, y, (gap_start + y) // 2))

        if in_gap:
            gaps.append((gap_start, end_pos, (gap_start + end_pos) // 2))

    return gaps
