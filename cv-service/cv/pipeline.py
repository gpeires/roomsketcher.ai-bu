"""Main pipeline: image → SimpleFloorPlanInput JSON."""
import math
import cv2
import numpy as np
from cv.preprocess import prepare
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.ocr import extract_text_regions
from cv.dimensions import parse_dimension
from cv.output import build_floor_plan_input

def analyze_floor_plan(image_path: str, name: str = "Extracted Floor Plan") -> dict:
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")
    return analyze_image(image, name=name)

def analyze_image(image: np.ndarray, name: str = "Extracted Floor Plan") -> dict:
    h, w = image.shape[:2]
    binary = prepare(image)
    walls = detect_walls(binary)
    rooms = detect_rooms(binary)
    text_regions = extract_text_regions(image)
    scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))
    result = build_floor_plan_input(
        rooms=rooms, text_regions=text_regions,
        image_shape=(h, w), scale_cm_per_px=scale, name=name,
    )
    result["meta"] = {
        "image_size": (w, h),
        "scale_cm_per_px": scale,
        "walls_detected": len(walls),
        "rooms_detected": len(rooms),
        "text_regions": len(text_regions),
    }
    return result

def _calibrate_scale(walls, text_regions, image_shape):
    matches = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is None or cm <= 0:
            continue
        tx, ty = tr["center"]
        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)
            mx, my = (sx + ex) / 2, (sy + ey) / 2
            dx, dy = abs(tx - mx), abs(ty - my)
            if wall_horizontal and dy > dx:
                dist = dy
            elif not wall_horizontal and dx > dy:
                dist = dx
            else:
                continue
            if dist < best_dist:
                best_dist = dist
                best_wall = wall
        if best_wall is not None and best_dist < max(image_shape) * 0.3:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            wall_px = math.hypot(ex - sx, ey - sy)
            if wall_px > 10:
                matches.append(cm / wall_px)
    if matches:
        matches.sort()
        return matches[len(matches) // 2]
    return 1000.0 / image_shape[1]
