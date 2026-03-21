"""Room-level multi-strategy merging for CV pipeline.

Instead of merging wall masks (which destroys rooms by filling interiors),
we detect rooms per strategy independently, then cluster spatially
overlapping rooms. This can only ADD rooms — never destroy them.
"""
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, NamedTuple

import cv2
import numpy as np

log = logging.getLogger(__name__)


@dataclass
class MergeContext:
    """Shared state bag passed through merge pipeline steps."""
    image_shape: tuple[int, int]
    strategy_bboxes: list[tuple[int, int, int, int]]
    consensus_bbox: tuple[int, int, int, int] | None = None
    anchor_strategy: str | None = None
    strategy_masks: list[dict] | None = None
    columns: list[dict] | None = None


class MergeStepResult(NamedTuple):
    rooms: list[dict]
    removed: list[dict]
    meta: dict


def cluster_rooms(
    strategy_room_lists: list[dict],
    image_shape: tuple[int, int],
    iou_threshold: float = 0.3,
) -> list[dict]:
    """Cluster rooms across strategies by spatial overlap.

    Rooms from different strategies that overlap significantly are grouped
    into clusters. Each cluster produces one output room with confidence
    scored by how many strategies independently found it.

    Args:
        strategy_room_lists: [{"strategy": str, "rooms": list[dict]}, ...]
            Each room dict must have: bbox, area_px, centroid, mask, polygon
        image_shape: (height, width) of the image
        iou_threshold: Minimum bbox IoU to consider two rooms the same

    Returns:
        List of room dicts (same shape as input rooms) with added fields:
            confidence: float (0.3-0.9)
            found_by: list[str] (strategy names)
            agreement_count: int
    """
    h, w = image_shape
    diagonal = np.sqrt(h**2 + w**2)
    proximity = diagonal * 0.15

    # Pool all rooms tagged with source strategy, excluding giant rooms
    # that span most of the image (detection artifacts, not real rooms)
    max_area = h * w * 0.5
    tagged = []
    for entry in strategy_room_lists:
        strategy = entry["strategy"]
        for room in entry["rooms"]:
            if room.get("area_px", 0) > max_area:
                continue
            tagged.append({"room": room, "strategy": strategy})

    if not tagged:
        return []

    # Sort by area descending — larger rooms are more reliable representatives
    tagged.sort(key=lambda t: t["room"].get("area_px", 0), reverse=True)

    # Greedy clustering
    clusters: list[dict] = []

    for item in tagged:
        room = item["room"]
        best_cluster = None
        best_score = 0.0

        for cluster in clusters:
            rep = cluster["representative"]
            score = _match_score(room, rep, iou_threshold, proximity)
            if score > best_score:
                best_score = score
                best_cluster = cluster

        if best_cluster is not None and best_score > 0:
            best_cluster["members"].append(item)
            # Keep largest-area room as representative
            if room.get("area_px", 0) > best_cluster["representative"].get("area_px", 0):
                best_cluster["representative"] = room
        else:
            clusters.append({
                "representative": room,
                "members": [item],
            })

    # Build output — one room per cluster
    result = []
    for cluster in clusters:
        rep = dict(cluster["representative"])
        strategies = list(set(m["strategy"] for m in cluster["members"]))
        n = len(strategies)

        if n >= 5:
            confidence = 0.9
        elif n >= 3:
            confidence = 0.7
        elif n >= 2:
            confidence = 0.5
        else:
            confidence = 0.3

        rep["confidence"] = confidence
        rep["found_by"] = strategies
        rep["agreement_count"] = n
        result.append(rep)

    return result


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


def _match_score(room1, room2, iou_threshold, proximity):
    """Score how likely two rooms are the same. Returns > 0 if they match."""
    iou = _bbox_iou(room1["bbox"], room2["bbox"])
    if iou >= iou_threshold:
        return iou

    # Fallback: centroid proximity
    c1 = np.array(room1["centroid"], dtype=float)
    c2 = np.array(room2["centroid"], dtype=float)
    dist = np.linalg.norm(c1 - c2)
    if dist < proximity:
        return 0.5

    return 0.0


def _bbox_iou(bbox1, bbox2):
    """Compute Intersection over Union of two bounding boxes (x, y, w, h)."""
    x1, y1, w1, h1 = bbox1
    x2, y2, w2, h2 = bbox2

    xi1 = max(x1, x2)
    yi1 = max(y1, y2)
    xi2 = min(x1 + w1, x2 + w2)
    yi2 = min(y1 + h1, y2 + h2)

    if xi2 <= xi1 or yi2 <= yi1:
        return 0.0

    intersection = (xi2 - xi1) * (yi2 - yi1)
    union = w1 * h1 + w2 * h2 - intersection
    return intersection / union if union > 0 else 0.0
