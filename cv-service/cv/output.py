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
    labels = []
    dimensions = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is not None:
            dimensions.append({**tr, "cm": cm})
        elif tr["text"].isalpha() or " " in tr["text"]:
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

    result = []
    for i, room in enumerate(rooms):
        r = dict(room)
        if i in room_labels:
            r["label"] = " ".join(room_labels[i])
        result.append(r)
    return result
