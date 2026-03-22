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
    "room", "area", "wic", "cl",
}

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

    # Filter out ghost rooms: low confidence, negative coords, outside floor plan, too small
    filtered_rooms = []
    for room in labeled_rooms:
        bx, by, bw, bh = room["bbox"]

        # Skip low-confidence rooms (found by only 1 strategy — almost always noise)
        confidence = room.get("confidence", 0.9)
        if confidence < 0.5:
            continue

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

    labeled_rooms_unfiltered = labeled_rooms
    labeled_rooms = filtered_rooms

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

        room_type = _infer_room_type(label)

        if is_non_rect and polygon:
            # Emit polygon format, normalized to origin
            scaled_poly = [
                {"x": _to_cm_grid(px - origin_x, scale_cm_per_px),
                 "y": _to_cm_grid(py - origin_y, scale_cm_per_px)}
                for px, py in polygon
            ]
            entry = {"label": label, "polygon": scaled_poly}
        else:
            # Emit standard rect format
            entry = {
                "label": label,
                "x": _to_cm_grid(bx - origin_x, scale_cm_per_px),
                "y": _to_cm_grid(by - origin_y, scale_cm_per_px),
                "width": _to_cm_grid(bw, scale_cm_per_px),
                "depth": _to_cm_grid(bh, scale_cm_per_px),
            }
        if room_type != "other":
            entry["type"] = room_type
        output_rooms.append(entry)

    # Pass the PRE-filtered rooms to _convert_openings so that opening
    # indices (which reference the original room list) stay valid.
    output_openings = _convert_openings(
        openings or [], labeled_rooms_unfiltered, scale_cm_per_px
    )

    result = {"name": name, "rooms": output_rooms}
    if output_openings:
        result["openings"] = output_openings
    if adjacency:
        result["adjacency"] = _convert_adjacency(
            adjacency, labeled_rooms_unfiltered, scale_cm_per_px
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

        # Fallback 1: assign to nearest room whose bbox contains the label
        if not assigned:
            for i, room in enumerate(rooms):
                bx, by, bw, bh = room["bbox"]
                if bx <= lx <= bx + bw and by <= ly <= by + bh:
                    room_labels.setdefault(i, []).append(label)
                    assigned = True
                    break

        # Fallback 2: assign to nearest room by centroid distance (within
        # a generous threshold).  This catches labels that fall just outside
        # a room's detected mask/bbox due to segmentation noise.
        if not assigned and _is_room_label(label["text"]):
            best_i = -1
            best_dist = float("inf")
            for i, room in enumerate(rooms):
                cx, cy = room.get("centroid", (
                    room["bbox"][0] + room["bbox"][2] // 2,
                    room["bbox"][1] + room["bbox"][3] // 2,
                ))
                d = ((lx - cx) ** 2 + (ly - cy) ** 2) ** 0.5
                # Max distance: half the room's diagonal
                bw, bh = room["bbox"][2], room["bbox"][3]
                max_d = ((bw ** 2 + bh ** 2) ** 0.5) * 0.7
                if d < best_dist and d < max_d:
                    best_dist = d
                    best_i = i
            if best_i >= 0:
                room_labels.setdefault(best_i, []).append(label)

    # Pick the single best label per room
    result = []
    for i, room in enumerate(rooms):
        r = dict(room)
        if i in room_labels:
            candidates = room_labels[i]
            # Filter to room-name-like text
            filtered = [c for c in candidates if _is_room_label(c["text"])]
            if filtered:
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


_ROOM_TYPE_MAP = {
    # Keywords → room type.  Checked in order; first match wins.
    "bedroom": "bedroom", "bed": "bedroom", "master": "bedroom",
    "primary": "bedroom", "guest": "bedroom",
    "kitchen": "kitchen", "pantry": "kitchen",
    "bathroom": "bathroom", "bath": "bathroom", "powder": "bathroom",
    "ensuite": "bathroom", "wc": "bathroom", "toilet": "bathroom",
    "living": "living", "lounge": "living", "family": "living",
    "dining": "dining", "breakfast": "dining", "nook": "dining",
    "hallway": "hallway", "hall": "hallway", "corridor": "hallway",
    "foyer": "hallway", "entry": "hallway", "vestibule": "hallway",
    "closet": "closet", "cl": "closet", "wic": "closet",
    "walk-in": "closet", "dressing": "closet",
    "storage": "storage",
    "laundry": "laundry", "w/d": "laundry",
    "office": "office", "study": "office", "den": "office",
    "balcony": "balcony", "terrace": "balcony", "patio": "balcony",
    "garage": "garage",
    "utility": "utility", "mudroom": "utility",
}


def _infer_room_type(label: str) -> str:
    """Infer room type from label text. Returns 'other' if no match."""
    low = label.strip().lower()
    words = re.split(r"[\s/&,]+", low)
    for word in words:
        if word in _ROOM_TYPE_MAP:
            return _ROOM_TYPE_MAP[word]
    return "other"


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
