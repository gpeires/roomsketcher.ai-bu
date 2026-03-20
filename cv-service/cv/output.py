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


def build_floor_plan_input(
    rooms: list[dict],
    text_regions: list[dict],
    image_shape: tuple[int, int],
    scale_cm_per_px: float,
    name: str = "Extracted Floor Plan",
    floor_plan_bbox: tuple[int, int, int, int] | None = None,
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

    output_rooms = []
    for room in labeled_rooms:
        bx, by, bw, bh = room["bbox"]
        output_rooms.append({
            "label": room.get("label", f"Room {len(output_rooms) + 1}"),
            "x": round(bx * scale_cm_per_px / 10) * 10,
            "y": round(by * scale_cm_per_px / 10) * 10,
            "width": round(bw * scale_cm_per_px / 10) * 10,
            "depth": round(bh * scale_cm_per_px / 10) * 10,
        })

    return {"name": name, "rooms": output_rooms}


def _assign_labels(rooms: list[dict], labels: list[dict]) -> list[dict]:
    """Assign text labels to rooms using mask containment, with nearest-centroid fallback."""
    room_labels: dict[int, list[str]] = {}

    for label in labels:
        lx, ly = label["center"]
        assigned = False

        # Primary: check if label center is inside any room's mask
        for i, room in enumerate(rooms):
            mask = room.get("mask")
            if mask is not None:
                h, w = mask.shape
                if 0 <= ly < h and 0 <= lx < w and mask[ly, lx] > 0:
                    room_labels.setdefault(i, []).append(label["text"])
                    assigned = True
                    break

        # Fallback: assign to nearest room whose bbox contains the label
        if not assigned:
            for i, room in enumerate(rooms):
                bx, by, bw, bh = room["bbox"]
                if bx <= lx <= bx + bw and by <= ly <= by + bh:
                    room_labels.setdefault(i, []).append(label["text"])
                    assigned = True
                    break

    # Build combined labels, filtering for room-name-like words
    result = []
    for i, room in enumerate(rooms):
        r = dict(room)
        if i in room_labels:
            words = room_labels[i]
            # Keep only words that look like room names
            filtered = [w for w in words if _is_room_label(w)]
            if filtered:
                r["label"] = " ".join(filtered)
        result.append(r)
    return result


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
