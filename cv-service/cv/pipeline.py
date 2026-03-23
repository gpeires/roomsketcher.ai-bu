"""Main pipeline: image → SimpleFloorPlanInput JSON."""
import base64
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from cv.preprocess import prepare, find_floor_plan_bbox, remove_letterbox
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.ocr import extract_text_regions
from cv.dimensions import parse_dimension
from cv.openings import detect_openings
from cv.topology import detect_adjacency
from cv.output import build_floor_plan_input
from cv.merge import run_merge_pipeline, MergeContext, cap_wall_thickness_cm
from cv.outline import extract_outline, build_spatial_grid
import cv.enhance as _enhance_mod

log = logging.getLogger(__name__)

# Strategies that produced 0 rooms across all test images — skip to save time
EXCLUDED_STRATEGIES = {"lab_a_channel", "lab_b_channel", "saturation", "top_hat_otsu", "black_hat"}


def analyze_floor_plan(image_path: str, name: str = "Extracted Floor Plan") -> dict:
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not load image: {image_path}")
    return analyze_image(image, name=name)


def analyze_image(image: np.ndarray, name: str = "Extracted Floor Plan") -> dict:
    """Run all strategies, detect rooms per strategy, cluster, run pipeline once."""
    from cv.strategies import STRATEGIES, StrategyResult

    # Normalize: remove black letterbox bars before any strategy runs
    image = remove_letterbox(image)

    h, w = image.shape[:2]
    start = time.monotonic()

    # Step 1: Run all strategies in parallel to get binary masks
    def _get_strategy_mask(strategy_name, strategy_fn):
        try:
            sr: StrategyResult = strategy_fn(image.copy())
            binary = sr.image if sr.is_binary else prepare(sr.image)
            return {"mask": binary, "strategy": strategy_name}
        except Exception as e:
            log.warning("Strategy %s mask failed: %s", strategy_name, e)
            return None

    active_strategies = {
        k: v for k, v in STRATEGIES.items() if k not in EXCLUDED_STRATEGIES
    }

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            sname: pool.submit(_get_strategy_mask, sname, fn)
            for sname, fn in active_strategies.items()
        }
        strategy_masks = []
        for sname, future in futures.items():
            try:
                result = future.result(timeout=120)
                if result is not None:
                    strategy_masks.append(result)
            except Exception as e:
                log.warning("Strategy %s timed out: %s", sname, e)

    if not strategy_masks:
        log.error("All strategies failed, falling back to raw pipeline")
        return _run_pipeline(image, name)

    # Step 2: Detect rooms per strategy (parallel)
    def _detect_rooms_for(entry):
        try:
            rooms, _ = detect_rooms(entry["mask"])
            return {"strategy": entry["strategy"], "rooms": rooms, "count": len(rooms)}
        except Exception:
            return {"strategy": entry["strategy"], "rooms": [], "count": 0}

    with ThreadPoolExecutor(max_workers=8) as pool:
        room_futures = [pool.submit(_detect_rooms_for, s) for s in strategy_masks]
        strategy_room_data = []
        for future in room_futures:
            try:
                strategy_room_data.append(future.result(timeout=60))
            except Exception:
                pass

    # Step 3: Compute per-strategy bboxes and run merge pipeline
    strategy_bboxes = []
    for s in strategy_masks:
        x, y, bw, bh = find_floor_plan_bbox(s["mask"])
        strategy_bboxes.append((x, y, x + bw, y + bh))  # convert to (x0, y0, x1, y1)

    # Select anchor strategy: pick the one closest to the median room count.
    # Using max(count) risks selecting a noisy strategy with false positives.
    counts = sorted(s["count"] for s in strategy_room_data if s["count"] > 0)
    if counts:
        median_count = counts[len(counts) // 2]
    else:
        median_count = 0
    anchor_name = min(
        (s for s in strategy_room_data if s["count"] > 0),
        key=lambda s: abs(s["count"] - median_count),
        default=max(strategy_room_data, key=lambda s: s["count"]),
    )["strategy"]
    anchor_mask = next(s["mask"] for s in strategy_masks if s["strategy"] == anchor_name)

    merge_context = MergeContext(
        image_shape=(h, w),
        strategy_bboxes=strategy_bboxes,
        strategy_masks=strategy_masks,
        anchor_strategy=anchor_name,
        anchor_mask=anchor_mask,
    )
    clustered, merge_meta = run_merge_pipeline(strategy_room_data, merge_context)

    if not clustered:
        log.warning("Room clustering produced 0 rooms, falling back to raw pipeline")
        return _run_pipeline(image, name)

    # Step 5: Run full pipeline on anchor mask with clustered rooms
    result = _run_pipeline(image, name, binary_override=anchor_mask, rooms_override=clustered)

    # Step 6: Attach confidence/found_by to output rooms
    for i, room in enumerate(result.get("rooms", [])):
        if i < len(clustered):
            room["confidence"] = clustered[i]["confidence"]
            room["found_by"] = clustered[i]["found_by"]

    # Step 7: Merge metadata
    contributing = [s for s in strategy_room_data if s["count"] > 0]
    elapsed_ms = int((time.monotonic() - start) * 1000)
    confidence_scores = [r["confidence"] for r in clustered]

    result["meta"]["strategies_run"] = len(strategy_masks)
    result["meta"]["strategies_contributing"] = len(contributing)
    result["meta"]["merge_stats"] = _compute_merge_stats(confidence_scores)
    result["meta"]["merge_time_ms"] = elapsed_ms
    result["meta"]["merge_steps"] = merge_meta

    # Wall thickness data from structural detection
    wall_thickness = None
    if merge_context.thickness_profile:
        tp = merge_context.thickness_profile
        scale = result.get("meta", {}).get("scale_cm_per_px", 1.0)
        raw_thin = round(tp.thin_wall_px * scale, 1)
        raw_thick = round(tp.thick_wall_px * scale, 1)
        thin_cm, thick_cm = cap_wall_thickness_cm(raw_thin, raw_thick)
        wall_thickness = {
            "thin_cm": thin_cm,
            "thick_cm": thick_cm,
            "structural_elements": [
                {
                    "kind": e.kind,
                    "centroid_cm": [round(e.centroid[0] * scale, 1), round(e.centroid[1] * scale, 1)],
                    "size_cm": [round(e.bbox[2] * scale, 1), round(e.bbox[3] * scale, 1)],
                    "thickness_cm": round(e.thickness_px * scale, 1),
                }
                for e in tp.elements
                if e.kind != "perimeter"
            ],
        }
    result["meta"]["wall_thickness"] = wall_thickness
    result["meta"]["preprocessing"] = {
        "strategy_used": "multi_strategy_merge",
        "anchor_strategy": anchor_name,
        "strategies_run": len(strategy_masks),
        "strategies_contributing": len(contributing),
    }

    log.info(
        "Multi-strategy merge: %d strategies, %d contributing, %d rooms (time=%dms)",
        len(strategy_masks), len(contributing), len(clustered), elapsed_ms,
    )
    return result


def _run_pipeline(
    image: np.ndarray,
    name: str,
    binary_override: np.ndarray | None = None,
    rooms_override: list[dict] | None = None,
) -> dict:
    """Run the full CV pipeline on a single image.

    Args:
        image: Original color image (used for OCR).
        name: Floor plan name.
        binary_override: Pre-processed binary wall mask. If provided, skip prepare().
        rooms_override: Pre-detected rooms. If provided, skip detect_rooms() for room
            output but still run it internally to get closed_binary for openings.
    """
    h, w = image.shape[:2]
    binary = binary_override if binary_override is not None else prepare(image)
    fp_bbox = find_floor_plan_bbox(binary)
    walls = detect_walls(binary)
    detected_rooms, closed_binary = detect_rooms(binary)
    rooms = rooms_override if rooms_override is not None else detected_rooms
    text_regions = extract_text_regions(image)
    scale, scale_confidence = _calibrate_scale(walls, text_regions, image_shape=(h, w))
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
        "scale_confidence": scale_confidence,
        "walls_detected": len(walls),
        "rooms_detected": len(rooms),
        "text_regions": len(text_regions),
        "openings_detected": len(openings),
    }

    # Extract building outline and spatial grid
    outline = extract_outline(binary, scale, floor_plan_bbox=fp_bbox)
    if outline:
        result["outline"] = outline
    grid = build_spatial_grid(rooms, text_regions, scale, fp_bbox)
    if grid:
        result["spatial_grid"] = grid

    return result


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

    Returns:
        Tuple of (scale_cm_per_px, scale_confidence) where confidence is:
        - "measured": scale derived from matched dimension labels
        - "fallback": no dimension labels matched, using 1000cm/image_width guess
    """
    matches = []
    max_dist = max(image_shape) * 0.20
    for tr in text_regions:
        cm = parse_dimension(tr["text"])
        if cm is None or cm <= 0:
            continue
        tx, ty = tr["center"]
        tw, th = tr["bbox"][2], tr["bbox"][3]
        label_horizontal = tw >= th
        log.debug("Scale: dim %r → %.1fcm at (%d,%d) horiz=%s", tr["text"], cm, tx, ty, label_horizontal)

        best_wall = None
        best_dist = float("inf")
        for wall in walls:
            sx, sy = wall["start"]
            ex, ey = wall["end"]
            wall_horizontal = abs(ey - sy) < abs(ex - sx)

            # Orientation mismatch penalty: compound dims (e.g. "10'-6" x 8'-10"")
            # are always horizontal text but may label vertical walls.
            # Allow mismatch but penalize distance by 2x.
            orientation_penalty = 1.0 if (wall_horizontal == label_horizontal) else 2.0

            if wall_horizontal:
                wall_y = (sy + ey) / 2
                perp_dist = abs(ty - wall_y) * orientation_penalty
                wall_min_x = min(sx, ex)
                wall_max_x = max(sx, ex)
                margin = (wall_max_x - wall_min_x) * 0.2
                if tx < wall_min_x - margin or tx > wall_max_x + margin:
                    continue
            else:
                wall_x = (sx + ex) / 2
                perp_dist = abs(tx - wall_x) * orientation_penalty
                wall_min_y = min(sy, ey)
                wall_max_y = max(sy, ey)
                margin = (wall_max_y - wall_min_y) * 0.2
                if ty < wall_min_y - margin or ty > wall_max_y + margin:
                    continue

            if perp_dist < best_dist:
                best_dist = perp_dist
                best_wall = wall

        if best_wall is not None and best_dist <= max_dist:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            wall_px = math.hypot(ex - sx, ey - sy)
            if wall_px > 10:
                scale_ratio = cm / wall_px
                matches.append(scale_ratio)
                log.debug("Scale: matched %r (%.1fcm) → wall (%d,%d)-(%d,%d) len=%.0fpx dist=%.0fpx → ratio=%.4f",
                          tr["text"], cm, sx, sy, ex, ey, wall_px, best_dist, scale_ratio)
            else:
                log.debug("Scale: wall too short (%.0fpx) for %r", wall_px, tr["text"])
        elif best_wall is not None:
            sx, sy = best_wall["start"]
            ex, ey = best_wall["end"]
            log.debug("Scale: nearest wall for %r at dist=%.0fpx > max=%.0fpx (wall (%d,%d)-(%d,%d))",
                      tr["text"], best_dist, max_dist, sx, sy, ex, ey)
        else:
            log.debug("Scale: no candidate wall for %r (no wall in span)", tr["text"])

    if matches:
        matches.sort()
        return matches[len(matches) // 2], "measured"
    log.warning("Scale calibration: no dimension labels matched walls, using fallback (1000cm/image_width)")
    return 1000.0 / image_shape[1], "fallback"


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

    # Normalize: remove black letterbox bars before strategy runs
    image = remove_letterbox(image)

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
        scale, scale_confidence = _calibrate_scale(walls, text_regions, image_shape=(h, w))
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
            "scale_confidence": scale_confidence,
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
