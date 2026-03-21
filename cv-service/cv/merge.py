"""Wall-level multi-strategy merging for CV pipeline."""
import cv2
import numpy as np
from cv.preprocess import filter_components


def merge_wall_masks(strategy_results: list[dict]) -> np.ndarray:
    """OR binary wall masks from strategies that detected >= 1 room.

    Args:
        strategy_results: list of {"mask": np.ndarray, "rooms_detected": int}

    Returns:
        Cleaned merged binary mask.
    """
    # Filter to strategies that found at least 1 room
    contributing = [s for s in strategy_results if s["rooms_detected"] > 0]
    if not contributing:
        # Fallback: use all masks if none found rooms
        contributing = strategy_results

    if not contributing:
        raise ValueError("No strategy results provided")

    # OR all contributing masks
    merged = contributing[0]["mask"].copy()
    for s in contributing[1:]:
        merged = cv2.bitwise_or(merged, s["mask"])

    # Clean: close small gaps, remove noise
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    merged = cv2.morphologyEx(merged, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = merged.shape
    merged = filter_components(merged, h * w)

    return merged


def score_room_confidence(
    merged_rooms: list[dict],
    individual_results: list[list],
    image_shape: tuple[int, int],
) -> list[float]:
    """Score each merged room's confidence by cross-strategy agreement.

    For each merged room, count how many individual strategy results
    detected a room overlapping the same area.

    Returns list of confidence scores (0.3-0.9), one per merged room.
    """
    scores = []
    h, w = image_shape
    diagonal = np.sqrt(h**2 + w**2)
    proximity_threshold = diagonal * 0.15  # 15% of image diagonal

    for room in merged_rooms:
        centroid = _polygon_centroid(room["polygon"])
        agreement = 0
        for strategy_rooms in individual_results:
            for sr in strategy_rooms:
                sr_centroid = _polygon_centroid(sr)
                dist = np.sqrt((centroid[0] - sr_centroid[0])**2 +
                               (centroid[1] - sr_centroid[1])**2)
                if dist < proximity_threshold:
                    agreement += 1
                    break  # count each strategy at most once

        if agreement >= 5:
            scores.append(0.9)
        elif agreement >= 3:
            scores.append(0.7)
        elif agreement >= 2:
            scores.append(0.5)
        else:
            scores.append(0.3)

    return scores


def assemble_rooms(
    rooms: list[dict],
    confidence_scores: list[float],
    scale_cm_per_px: float,
    found_by: list[list[str]] | None = None,
) -> list[dict]:
    """Convert raw room polygons to clean rectangular room specs.

    Produces structured output suitable for AI model consumption:
    snapped positions, simplified dimensions, confidence, sources.
    """
    assembled = []
    for i, room in enumerate(rooms):
        poly = np.array(room["polygon"])
        x_min, y_min = poly.min(axis=0)
        x_max, y_max = poly.max(axis=0)

        # Snap to 10px grid
        x = int(round(x_min / 10) * 10)
        y = int(round(y_min / 10) * 10)
        width_px = int(round((x_max - x_min) / 10) * 10)
        depth_px = int(round((y_max - y_min) / 10) * 10)

        assembled.append({
            "label": room.get("label", f"Room {i+1}"),
            "x": x,
            "y": y,
            "width": round(width_px * scale_cm_per_px),
            "depth": round(depth_px * scale_cm_per_px),
            "polygon": room["polygon"],
            "confidence": confidence_scores[i],
            "found_by": found_by[i] if found_by else [],
        })

    return assembled


def _polygon_centroid(polygon):
    """Compute centroid of a polygon (list of (x,y) tuples or similar)."""
    pts = np.array(polygon)
    return pts.mean(axis=0)
