"""Main pipeline: image → SimpleFloorPlanInput JSON."""
import base64
import logging
import math
import time
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
from cv.merge import merge_wall_masks, score_room_confidence, assemble_rooms
import cv.enhance as _enhance_mod
from cv.enhance import pick_winner

log = logging.getLogger(__name__)


def analyze_floor_plan(image_path: str, name: str = "Extracted Floor Plan") -> dict:
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")
    return analyze_image(image, name=name)


def analyze_image(image: np.ndarray, name: str = "Extracted Floor Plan") -> dict:
    """Run all strategies, merge wall masks, detect rooms once on merged mask."""
    from cv.strategies import STRATEGIES, StrategyResult

    h, w = image.shape[:2]
    start = time.monotonic()

    # Step 1: Run all strategies in parallel to get binary masks
    def _get_strategy_mask(strategy_name, strategy_fn):
        try:
            sr: StrategyResult = strategy_fn(image.copy())
            if sr.is_binary:
                binary = sr.image
            else:
                binary = prepare(sr.image)
            return {"mask": binary, "strategy": strategy_name, "error": None}
        except Exception as e:
            log.warning("Strategy %s mask extraction failed: %s", strategy_name, e)
            return {"mask": None, "strategy": strategy_name, "error": str(e)}

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            name: pool.submit(_get_strategy_mask, name, fn)
            for name, fn in STRATEGIES.items()
        }
        strategy_masks = []
        for sname, future in futures.items():
            try:
                result = future.result(timeout=120)
                if result["mask"] is not None:
                    strategy_masks.append(result)
            except Exception as e:
                log.warning("Strategy %s timed out: %s", sname, e)

    if not strategy_masks:
        log.error("All strategies failed, falling back to raw pipeline")
        return _run_pipeline(image, name)

    # Step 2: Quick room count per strategy (parallel)
    def _quick_room_count(mask):
        try:
            rooms, _ = detect_rooms(mask)
            return rooms
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=8) as pool:
        room_futures = {
            i: pool.submit(_quick_room_count, s["mask"])
            for i, s in enumerate(strategy_masks)
        }
        for i, future in room_futures.items():
            try:
                rooms = future.result(timeout=60)
                strategy_masks[i]["rooms_detected"] = len(rooms)
                strategy_masks[i]["rooms"] = rooms
            except Exception:
                strategy_masks[i]["rooms_detected"] = 0
                strategy_masks[i]["rooms"] = []

    # Step 3: Merge wall masks
    merged_mask = merge_wall_masks(strategy_masks)

    # Step 4: Run full pipeline once on merged mask
    result = _run_pipeline(image, name, binary_override=merged_mask)

    # Step 5: Score confidence per room
    # Get individual room polygons from contributing strategies
    individual_rooms = []
    contributing_strategies = []
    for s in strategy_masks:
        if s["rooms_detected"] > 0:
            individual_rooms.append(
                [r["polygon"] for r in s["rooms"] if r.get("polygon")]
            )
            contributing_strategies.append(s["strategy"])

    # Get the merged rooms (raw detect_rooms output for scoring)
    merged_rooms_raw, _ = detect_rooms(merged_mask)
    confidence_scores = score_room_confidence(
        merged_rooms_raw, individual_rooms, (h, w),
    )

    # Step 6: Determine which strategies found each room
    found_by = _compute_found_by(
        merged_rooms_raw, strategy_masks, (h, w),
    )

    # Step 7: Assemble clean rooms with confidence
    scale = result["meta"]["scale_cm_per_px"]
    assembled = assemble_rooms(
        merged_rooms_raw, confidence_scores, scale, found_by=found_by,
    )

    # Attach confidence and found_by to the output rooms
    for i, room in enumerate(result.get("rooms", [])):
        if i < len(assembled):
            room["confidence"] = assembled[i]["confidence"]
            room["found_by"] = assembled[i]["found_by"]

    # Step 8: Add merge metadata
    elapsed_ms = int((time.monotonic() - start) * 1000)
    result["meta"]["strategies_run"] = len(strategy_masks)
    result["meta"]["strategies_contributing"] = len(contributing_strategies)
    result["meta"]["merge_stats"] = _compute_merge_stats(confidence_scores)
    result["meta"]["merge_time_ms"] = elapsed_ms
    result["meta"]["preprocessing"] = {
        "strategy_used": "multi_strategy_merge",
        "strategies_run": len(strategy_masks),
        "strategies_contributing": len(contributing_strategies),
    }

    log.info(
        "Multi-strategy merge: %d strategies run, %d contributing, %d rooms detected (time=%dms)",
        len(strategy_masks),
        len(contributing_strategies),
        result["meta"]["rooms_detected"],
        elapsed_ms,
    )
    return result


def _run_pipeline(
    image: np.ndarray, name: str, binary_override: np.ndarray | None = None,
) -> dict:
    """Run the full CV pipeline on a single image. Pure function, no side effects.

    Args:
        image: Original color image (used for OCR).
        name: Floor plan name.
        binary_override: Pre-processed binary wall mask. If provided, skip prepare().
    """
    h, w = image.shape[:2]
    if binary_override is not None:
        binary = binary_override
    else:
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


def _compute_found_by(
    merged_rooms: list[dict],
    strategy_masks: list[dict],
    image_shape: tuple[int, int],
) -> list[list[str]]:
    """For each merged room, list which strategies found an overlapping room."""
    h, w = image_shape
    diagonal = np.sqrt(h**2 + w**2)
    proximity = diagonal * 0.15

    found_by = []
    for room in merged_rooms:
        centroid = np.array(room["centroid"], dtype=float)
        sources = []
        for s in strategy_masks:
            if s["rooms_detected"] == 0:
                continue
            for sr in s["rooms"]:
                sr_centroid = np.array(sr["centroid"], dtype=float)
                dist = np.linalg.norm(centroid - sr_centroid)
                if dist < proximity:
                    sources.append(s["strategy"])
                    break
        found_by.append(sources)
    return found_by


def _compute_merge_stats(confidence_scores: list[float]) -> dict:
    """Compute summary stats for confidence distribution."""
    high = sum(1 for s in confidence_scores if s >= 0.7)
    medium = sum(1 for s in confidence_scores if 0.5 <= s < 0.7)
    low = sum(1 for s in confidence_scores if s < 0.5)
    return {"high": high, "medium": medium, "low": low, "total": len(confidence_scores)}


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


def run_single_strategy(
    image: np.ndarray,
    plan_name: str,
    strategy_name: str,
    strategy_fn,
) -> dict:
    """Run one preprocessing strategy through the full CV pipeline.

    Returns the standard pipeline result dict plus:
    - strategy: name of the strategy used
    - debug_binary: base64-encoded PNG of the binary wall mask
    - time_ms: wall-clock time in milliseconds
    """
    from cv.strategies import StrategyResult

    start = time.monotonic()
    try:
        h, w = image.shape[:2]
        sr: StrategyResult = strategy_fn(image.copy())

        if sr.is_binary:
            binary = sr.image
        else:
            binary = prepare(sr.image)

        # Capture binary mask as debug PNG
        _, png_buf = cv2.imencode(".png", binary)
        debug_binary = base64.b64encode(png_buf.tobytes()).decode()

        fp_bbox = find_floor_plan_bbox(binary)
        walls = detect_walls(binary)
        rooms, closed_binary = detect_rooms(binary)
        # OCR needs the original color image, not the preprocessed one
        text_regions = extract_text_regions(image)
        scale = _calibrate_scale(walls, text_regions, image_shape=(h, w))
        openings = detect_openings(binary, closed_binary, rooms, walls, scale)
        adjacency = detect_adjacency(rooms, binary)

        result = build_floor_plan_input(
            rooms=rooms, text_regions=text_regions,
            image_shape=(h, w), scale_cm_per_px=scale, name=plan_name,
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
        result["strategy"] = strategy_name
        result["debug_binary"] = debug_binary
        result["time_ms"] = int((time.monotonic() - start) * 1000)
        return result

    except Exception as e:
        elapsed = int((time.monotonic() - start) * 1000)
        log.warning("Strategy %s failed: %s", strategy_name, e)
        return {
            "strategy": strategy_name,
            "name": plan_name,
            "rooms": [],
            "openings": [],
            "adjacency": [],
            "meta": {
                "image_size": (image.shape[1], image.shape[0]),
                "scale_cm_per_px": 0.0,
                "walls_detected": 0,
                "rooms_detected": 0,
                "text_regions": 0,
                "openings_detected": 0,
            },
            "debug_binary": "",
            "time_ms": elapsed,
            "error": str(e),
        }


def sweep_strategies(image: np.ndarray, plan_name: str) -> dict:
    """Run all registered strategies in parallel, return all results."""
    from cv.strategies import STRATEGIES

    h, w = image.shape[:2]

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            name: pool.submit(run_single_strategy, image, plan_name, name, fn)
            for name, fn in STRATEGIES.items()
        }
        results = []
        for name, future in futures.items():
            try:
                results.append(future.result(timeout=120))
            except Exception as e:
                log.warning("Strategy %s timed out or crashed: %s", name, e)
                results.append({
                    "strategy": name,
                    "name": plan_name,
                    "rooms": [],
                    "openings": [],
                    "adjacency": [],
                    "meta": {
                        "image_size": (w, h),
                        "scale_cm_per_px": 0.0,
                        "walls_detected": 0,
                        "rooms_detected": 0,
                        "text_regions": 0,
                        "openings_detected": 0,
                    },
                    "debug_binary": "",
                    "time_ms": 0,
                    "error": f"Timed out or crashed: {e}",
                })

    return {"image_size": (w, h), "strategies": results}
