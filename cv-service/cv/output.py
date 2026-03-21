"""Convert CV detections to SimpleFloorPlanInput JSON format."""
import re
from cv.dimensions import parse_dimension

# Common room-label words (case-insensitive).  Used to boost confidence
# that a text region is a genuine room name rather than noise.
_ROOM_WORDS = {
    "bedroom", "bed", "living", "dining", "kitchen", "bathroom", "bath",
    "foyer", "entry", "hallway", "hall", "closet", "storage", "laundry",
    "utility", "balcony", "terrace", "patio", "garage", "office", "study",
    "den", "family", "master", "primary", "guest", "powder", "dressing",
    "walk-in", "pantry", "nook", "breakfast", "sunroom", "lounge",
    "vestibule", "corridor", "mudroom", "ensuite", "wc", "toilet",
    "room", "area",
}

# Regex for things that look like dimensions/coordinates, not labels
_DIM_LIKE = re.compile(
    r"^\d+[\.\',\"x×]|^[x×]$|^\d+$|^[a-zA-Z]$|^[\W]+$",
)


def _to_cm_grid(px: float, scale: float, grid: int = 10) -> int:
    """Convert pixel value to cm, rounded to nearest grid step."""
    return round(px * scale / grid) * grid


def _room_label(rooms: list[dict], idx: int) -> str:
    """Get room label by index with fallback to 'Room N'."""
    return rooms[idx].get("label", f"Room {idx + 1}")


def build_floor_plan_input(
    rooms: list[dict],
    text_regions: list[dict],
    image_shape: tuple[int, int],
    scale_cm_per_px: float,
    name: str = "Extracted Floor Plan",
    floor_plan_bbox: tuple[int, int, int, int] | None = None,
    openings: list[dict] | None = None,
    adjacency: list[dict] | None = None,
) -> dict:
    labels = []
    for tr in text_regions:
        text = tr["text"].strip()
        if not text or len(text) < 2:
            continue
        # Skip dimension strings
        if parse_dimension(text) is not None:
            continue
        # Skip dimension-like noise
        if _DIM_LIKE.match(text):
            continue
        # Skip text outside the floor plan bounding box (header/legend)
        if floor_plan_bbox is not None:
            bx, by, bw, bh = floor_plan_bbox
            tx, ty = tr["center"]
            if tx < bx or tx > bx + bw or ty < by or ty > by + bh:
                continue
        labels.append(tr)

    labeled_rooms = _assign_labels(rooms, labels)

    # Normalize coordinates relative to the floor plan bounding box origin
    # so that rooms start near (0,0) instead of at arbitrary image offsets.
    origin_x = floor_plan_bbox[0] if floor_plan_bbox else 0
    origin_y = floor_plan_bbox[1] if floor_plan_bbox else 0

    output_rooms = []
    for room in labeled_rooms:
        bx, by, bw, bh = room["bbox"]
        label = room.get("label", f"Room {len(output_rooms) + 1}")
        polygon = room.get("polygon", [])

        # Decide whether to use polygon or rect format.
        # If the room's actual pixel area is significantly less than its
        # bounding box area, it's non-rectangular (L-shape, etc.).
        bbox_area = max(bw * bh, 1)
        is_non_rect = len(polygon) > 4 and room["area_px"] / bbox_area < 0.85

        if is_non_rect and polygon:
            # Emit polygon format, normalized to origin
            scaled_poly = [
                {"x": _to_cm_grid(px - origin_x, scale_cm_per_px),
                 "y": _to_cm_grid(py - origin_y, scale_cm_per_px)}
                for px, py in polygon
            ]
            output_rooms.append({"label": label, "polygon": scaled_poly})
        else:
            # Emit standard rect format
            output_rooms.append({
                "label": label,
                "x": _to_cm_grid(bx - origin_x, scale_cm_per_px),
                "y": _to_cm_grid(by - origin_y, scale_cm_per_px),
                "width": _to_cm_grid(bw, scale_cm_per_px),
                "depth": _to_cm_grid(bh, scale_cm_per_px),
            })

    output_openings = _convert_openings(
        openings or [], labeled_rooms, scale_cm_per_px
    )

    result = {"name": name, "rooms": output_rooms}
    if output_openings:
        result["openings"] = output_openings
    if adjacency:
        result["adjacency"] = _convert_adjacency(
            adjacency, labeled_rooms, scale_cm_per_px
        )
    return result


def _convert_openings(
    openings: list[dict],
    labeled_rooms: list[dict],
    scale_cm_per_px: float,
) -> list[dict]:
    """Convert detected openings to SimpleOpeningInput format."""
    output = []
    for o in openings:
        width_cm = max(60, min(_to_cm_grid(o["width_px"], scale_cm_per_px), 250))

        if o["type"] == "door":
            room_a = o.get("room_a_idx")
            room_b = o.get("room_b_idx")
            if room_a is not None and room_b is not None:
                output.append({
                    "type": "door",
                    "between": [_room_label(labeled_rooms, room_a),
                                _room_label(labeled_rooms, room_b)],
                    "width": width_cm,
                })
            elif room_a is not None:
                wall_side = _opening_wall_side(o, labeled_rooms[room_a])
                if wall_side:
                    output.append({
                        "type": "door",
                        "room": _room_label(labeled_rooms, room_a),
                        "wall": wall_side,
                        "width": width_cm,
                    })
        elif o["type"] == "window":
            room_idx = o.get("room_a_idx")
            if room_idx is not None:
                wall_side = _opening_wall_side(o, labeled_rooms[room_idx])
                if wall_side:
                    output.append({
                        "type": "window",
                        "room": _room_label(labeled_rooms, room_idx),
                        "wall": wall_side,
                        "width": width_cm,
                    })
    return output


def _opening_wall_side(opening: dict, room: dict) -> str | None:
    """Determine which wall side (north/south/east/west) an opening is on."""
    ox, oy = opening["position_px"]
    bx, by, bw, bh = room["bbox"]
    cx, cy = bx + bw // 2, by + bh // 2

    if opening["orientation"] == "horizontal":
        # Opening is on a horizontal wall — north or south
        if oy < cy:
            return "north"
        else:
            return "south"
    else:
        # Opening is on a vertical wall — east or west
        if ox < cx:
            return "west"
        else:
            return "east"


def _convert_adjacency(
    adjacency: list[dict],
    labeled_rooms: list[dict],
    scale_cm_per_px: float,
) -> list[dict]:
    """Convert adjacency data to output format with room labels."""
    output = []
    for adj in adjacency:
        a = adj["room_a_idx"]
        b = adj["room_b_idx"]
        if a >= len(labeled_rooms) or b >= len(labeled_rooms):
            continue
        length_cm = _to_cm_grid(adj["shared_length_px"], scale_cm_per_px)
        output.append({
            "rooms": [_room_label(labeled_rooms, a), _room_label(labeled_rooms, b)],
            "shared_edge": adj["orientation"],
            "length_cm": length_cm,
        })
    return output


def _assign_labels(rooms: list[dict], labels: list[dict]) -> list[dict]:
    """Assign text labels to rooms using mask containment, with nearest-centroid fallback.

    When multiple labels fall inside the same room, pick the single best one
    (prefer known room words, break ties by proximity to room centroid).
    """
    room_labels: dict[int, list[dict]] = {}

    for label in labels:
        lx, ly = label["center"]
        assigned = False

        # Primary: check if label center is inside any room's mask
        for i, room in enumerate(rooms):
            mask = room.get("mask")
            if mask is not None:
                h, w = mask.shape
                if 0 <= ly < h and 0 <= lx < w and mask[ly, lx] > 0:
                    room_labels.setdefault(i, []).append(label)
                    assigned = True
                    break

        # Fallback: assign to nearest room whose bbox contains the label
        if not assigned:
            for i, room in enumerate(rooms):
                bx, by, bw, bh = room["bbox"]
                if bx <= lx <= bx + bw and by <= ly <= by + bh:
                    room_labels.setdefault(i, []).append(label)
                    assigned = True
                    break

    # Pick the single best label per room
    result = []
    for i, room in enumerate(rooms):
        r = dict(room)
        if i in room_labels:
            candidates = room_labels[i]
            # Filter to room-name-like text
            filtered = [c for c in candidates if _is_room_label(c["text"])]
            if not filtered:
                filtered = candidates
            r["label"] = _pick_best_label(filtered, room)
        result.append(r)
    return result


def _pick_best_label(candidates: list[dict], room: dict) -> str:
    """Pick the single best label from candidates for a room.

    Prefers labels containing a known room word, then picks the one
    closest to the room centroid.
    """
    if len(candidates) == 1:
        return candidates[0]["text"]

    cx, cy = room.get("centroid", (
        room["bbox"][0] + room["bbox"][2] // 2,
        room["bbox"][1] + room["bbox"][3] // 2,
    ))

    # Partition into known-room-word vs other
    has_room_word = [c for c in candidates
                     if any(w in c["text"].strip().lower().split()
                            for w in _ROOM_WORDS)]

    pool = has_room_word if has_room_word else candidates

    # Pick closest to centroid
    best = min(pool, key=lambda c: (
        (c["center"][0] - cx) ** 2 + (c["center"][1] - cy) ** 2
    ))
    return best["text"]


def _is_room_label(text: str) -> bool:
    """Check if text looks like a room label rather than noise."""
    t = text.strip().lower()
    if len(t) < 2:
        return False
    # Known room words
    if t in _ROOM_WORDS:
        return True
    # Multi-word text where at least one word is a known room word
    words = t.split()
    if any(w in _ROOM_WORDS for w in words):
        return True
    # Title-case alphabetic words of reasonable length (e.g. "Dressing", "Primary")
    clean = text.replace(" ", "").replace("-", "")
    if len(clean) >= 4 and text[0].isupper() and clean.isalpha():
        return True
    return False
