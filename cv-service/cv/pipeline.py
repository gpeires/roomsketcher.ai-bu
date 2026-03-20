"""Main pipeline: image → SimpleFloorPlanInput JSON."""
import logging
import math
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from cv.preprocess import prepare, find_floor_plan_bbox
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.ocr import extract_text_regions
from cv.dimensions import parse_dimension
from cv.openings import detect_openings
from cv.topology import detect_adjacency
from cv.output import build_floor_plan_input
import cv.enhance as _enhance_mod
from cv.enhance import pick_winner

log = logging.getLogger(__name__)


def analyze_floor_plan(image_path: str, name: str = "Extracted Floor Plan") -> dict:
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")
    return analyze_image(image, name=name)


def analyze_image(image: np.ndarray, name: str = "Extracted Floor Plan") -> dict:
    """Run raw and enhanced pipelines in parallel, return the better result."""

    def _run_enhanced():
        try:
            # .copy() ensures thread safety — raw and enhanced branches
            # never share the same numpy array in memory
            enhanced_img = _enhance_mod.enhance(image.copy(), preset="standard")
            return _run_pipeline(enhanced_img, name)
        except Exception as e:
            log.warning(f"Enhancement failed, skipping: {e}")
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        raw_future = pool.submit(_run_pipeline, image, name)
        enhanced_future = pool.submit(_run_enhanced)

        raw_result = raw_future.result()
        enhanced_result = enhanced_future.result()

    if enhanced_result is None:
        winner, strategy = raw_result, "raw"
    else:
        winner, strategy = pick_winner(raw_result, enhanced_result)

    winner["meta"]["preprocessing"] = {
        "raw_rooms": raw_result["meta"]["rooms_detected"],
        "enhanced_rooms": enhanced_result["meta"]["rooms_detected"] if enhanced_result else 0,
        "raw_walls": raw_result["meta"]["walls_detected"],
        "enhanced_walls": enhanced_result["meta"]["walls_detected"] if enhanced_result else 0,
        "strategy_used": strategy,
    }
    log.info(
        "Preprocessing: strategy=%s, raw_rooms=%d, enhanced_rooms=%d",
        strategy,
        raw_result["meta"]["rooms_detected"],
        enhanced_result["meta"]["rooms_detected"] if enhanced_result else 0,
    )
    return winner


def _run_pipeline(image: np.ndarray, name: str) -> dict:
    """Run the full CV pipeline on a single image. Pure function, no side effects."""
    h, w = image.shape[:2]
    binary = prepare(image)
    fp_bbox = find_floor_plan_bbox(binary)
    walls = detect_walls(binary)
    rooms, closed_binary = detect_rooms(binary)
    text_regions = extract_text_regions(image)
    scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))
    openings = detect_openings(binary, closed_binary, rooms, walls, scale)
    adjacency = detect_adjacency(rooms, binary)
    result = build_floor_plan_input(
        rooms=rooms, text_regions=text_regions,
        image_shape=(h, w), scale_cm_per_px=scale, name=name,
        floor_plan_bbox=fp_bbox,
        openings=openings,
        adjacency=adjacency,
    )
    result["meta"] = {
        "image_size": (w, h),
        "scale_cm_per_px": scale,
        "walls_detected": len(walls),
        "rooms_detected": len(rooms),
        "text_regions": len(text_regions),
        "openings_detected": len(openings),
    }
    return result


def _calibrate_scale(walls, text_regions, image_shape):
    """Match dimension labels to their nearest parallel wall and compute scale.

    Strategy: for each dimension text, find the nearest wall that is
    parallel to the dimension's likely orientation.  A horizontal dimension
    label (wider than tall) should match a horizontal wall, and vice versa.
    We use perpendicular distance (not center-to-center) for matching,
    and require the text to fall within the wall's span along the
    parallel axis.
    """
    matches = []
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is None or cm <= 0:
            continue
        tx, ty = tr["center"]
        tw, th = tr["bbox"][2], tr["bbox"][3]
        label_horizontal = tw >= th

        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)

            if wall_horizontal != label_horizontal:
                continue

            if wall_horizontal:
                wall_y = (sy + ey) / 2
                perp_dist = abs(ty - wall_y)
                wall_min_x = min(sx, ex)
                wall_max_x = max(sx, ex)
                margin = (wall_max_x - wall_min_x) * 0.2
                if tx < wall_min_x - margin or tx > wall_max_x + margin:
                    continue
            else:
                wall_x = (sx + ex) / 2
                perp_dist = abs(tx - wall_x)
                wall_min_y = min(sy, ey)
                wall_max_y = max(sy, ey)
                margin = (wall_max_y - wall_min_y) * 0.2
                if ty < wall_min_y - margin or ty > wall_max_y + margin:
                    continue

            if perp_dist < best_dist:
                best_dist = perp_dist
                best_wall = wall

        max_dist = max(image_shape) * 0.15
        if best_wall is not None and best_dist < max_dist:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            wall_px = math.hypot(ex - sx, ey - sy)
            if wall_px > 10:
                matches.append(cm / wall_px)

    if matches:
        matches.sort()
        return matches[len(matches) // 2]
    return 1000.0 / image_shape[1]
