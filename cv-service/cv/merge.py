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
class StructuralElement:
    """A detected structural element (column, thick wall, or perimeter)."""
    kind: str                          # "column" | "thick_wall" | "perimeter"
    centroid: tuple[int, int]          # pixel position
    bbox: tuple[int, int, int, int]   # x, y, w, h
    area_px: int
    thickness_px: float               # measured full thickness (2x distance transform value)
    aspect_ratio: float


@dataclass
class ThicknessProfile:
    """Wall thickness analysis result from structural detection."""
    elements: list[StructuralElement]
    thin_wall_px: float               # median thin-wall full thickness
    thick_wall_px: float              # median thick-element full thickness
    grid_detected: bool = False
    grid_spacing_px: list[int] | None = None


@dataclass
class MergeContext:
    """Shared state bag passed through merge pipeline steps."""
    image_shape: tuple[int, int]
    strategy_bboxes: list[tuple[int, int, int, int]]
    consensus_bbox: tuple[int, int, int, int] | None = None
    anchor_strategy: str | None = None
    anchor_mask: np.ndarray | None = None
    strategy_masks: list[dict] | None = None
    columns: list[dict] | None = None               # deprecated: use thickness_profile
    thickness_profile: ThicknessProfile | None = None
    structural_backend: str = "distance_transform"


class MergeStepResult(NamedTuple):
    rooms: list[dict]
    removed: list[dict]
    meta: dict


def compute_consensus_bbox(
    bboxes: list[tuple[int, int, int, int]],
) -> tuple[int, int, int, int] | None:
    """Compute a robust consensus bounding box from multiple strategy bboxes."""
    if not bboxes:
        return None
    arr = np.array(bboxes)
    median = np.median(arr, axis=0).astype(int)
    return (int(median[0]), int(median[1]), int(median[2]), int(median[3]))


def filter_by_bbox(
    strategy_room_lists: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Pre-cluster filter: remove rooms whose centroid falls outside consensus bbox."""
    consensus = compute_consensus_bbox(context.strategy_bboxes)
    if consensus is None:
        return MergeStepResult(rooms=strategy_room_lists, removed=[], meta={"skipped": True})
    context.consensus_bbox = consensus
    x0, y0, x1, y1 = consensus

    filtered = []
    removed = []
    rooms_in = 0
    for entry in strategy_room_lists:
        kept = []
        for room in entry["rooms"]:
            rooms_in += 1
            cx, cy = room["centroid"]
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                kept.append(room)
            else:
                room_copy = dict(room)
                room_copy["removal_reason"] = "outside_floor_plan_bbox"
                room_copy["_strategy"] = entry["strategy"]
                removed.append(room_copy)
        filtered.append({"strategy": entry["strategy"], "rooms": kept})

    meta = {
        "consensus_bbox": (x0, y0, x1 - x0, y1 - y0),
        "rooms_in": rooms_in,
        "rooms_removed": len(removed),
        "strategies_with_bbox": len(context.strategy_bboxes),
    }
    return MergeStepResult(rooms=filtered, removed=removed, meta=meta)


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


def cluster_rooms_step(
    strategy_room_lists: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Pipeline step wrapper around cluster_rooms that surfaces removal reasons."""
    h, w = context.image_shape
    max_area = h * w * 0.5

    removed = []
    for entry in strategy_room_lists:
        for room in entry["rooms"]:
            if room.get("area_px", 0) > max_area:
                room_copy = dict(room)
                room_copy["removal_reason"] = "giant_room"
                room_copy["_strategy"] = entry["strategy"]
                removed.append(room_copy)

    rooms_in = sum(len(e["rooms"]) for e in strategy_room_lists)
    clustered = cluster_rooms(strategy_room_lists, context.image_shape)

    meta = {
        "rooms_in": rooms_in,
        "clusters_out": len(clustered),
        "giant_rooms_removed": len(removed),
    }
    return MergeStepResult(rooms=clustered, removed=removed, meta=meta)


def filter_clusters_by_bbox(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Post-cluster filter: remove clustered rooms outside consensus bbox."""
    if context.consensus_bbox is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    x0, y0, x1, y1 = context.consensus_bbox
    kept = []
    removed = []
    for room in rooms:
        cx, cy = room["centroid"]
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            kept.append(room)
        else:
            room_copy = dict(room)
            room_copy["removal_reason"] = "outside_floor_plan_bbox_post"
            removed.append(room_copy)

    meta = {"rooms_in": len(rooms), "rooms_removed": len(removed)}
    return MergeStepResult(rooms=kept, removed=removed, meta=meta)


def detect_columns_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Detect structural columns (small square blobs) in the anchor mask."""
    if context.strategy_masks is None or context.anchor_strategy is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    anchor_mask = None
    for s in context.strategy_masks:
        if s["strategy"] == context.anchor_strategy:
            anchor_mask = s["mask"]
            break
    if anchor_mask is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    h, w = anchor_mask.shape
    total_px = h * w
    min_area = max(20, int(total_px * 0.0001))
    max_area = max(500, int(total_px * 0.005))

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        anchor_mask, connectivity=8
    )

    candidates = []
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area or area > max_area:
            continue
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        if aspect > 1.3:
            continue
        bb_area = cw * ch
        solidity = area / bb_area if bb_area > 0 else 0
        if solidity < 0.8:
            continue
        cx, cy = centroids[i]
        candidates.append({
            "centroid": (int(cx), int(cy)),
            "bbox": (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                     int(cw), int(ch)),
            "area_px": int(area),
            "solidity": round(solidity, 2),
        })

    grid_detected = False
    grid_spacing = None
    if len(candidates) >= 3:
        xs = sorted(c["centroid"][0] for c in candidates)
        ys = sorted(c["centroid"][1] for c in candidates)
        grid_detected, grid_spacing = _check_grid_regularity(xs, ys)

    context.columns = candidates

    meta = {
        "columns_found": len(candidates),
        "grid_detected": grid_detected,
        "grid_spacing_px": grid_spacing,
    }
    return MergeStepResult(rooms=rooms, removed=[], meta=meta)


def _check_grid_regularity(
    xs: list[int], ys: list[int],
) -> tuple[bool, list[int] | None]:
    """Check if a set of x/y coordinates form a regular grid."""

    def _find_spacing(coords: list[int], tolerance: int = 10) -> int | None:
        if len(coords) < 3:
            return None
        clusters: list[list[int]] = []
        for c in coords:
            placed = False
            for cl in clusters:
                if abs(c - cl[-1]) <= tolerance:
                    cl.append(c)
                    placed = True
                    break
            if not placed:
                clusters.append([c])
        if len(clusters) < 3:
            return None
        centers = sorted(sum(cl) / len(cl) for cl in clusters)
        diffs = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
        if not diffs:
            return None
        median_diff = sorted(diffs)[len(diffs) // 2]
        if median_diff < 10:
            return None
        consistent = all(abs(d - median_diff) / median_diff < 0.3 for d in diffs)
        return int(median_diff) if consistent else None

    x_spacing = _find_spacing(xs)
    y_spacing = _find_spacing(ys)
    if x_spacing is not None and y_spacing is not None:
        return True, [x_spacing, y_spacing]
    return False, None


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


# ── Registry ──────────────────────────────────────────────────────────

PRE_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_pre": filter_by_bbox,
}

CLUSTER_STEP: tuple[str, Callable] = ("cluster", cluster_rooms_step)

POST_CLUSTER_STEPS: dict[str, Callable] = {
    "bbox_filter_post": filter_clusters_by_bbox,
    "column_detect": detect_columns_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "column_detect",
]

EXCLUDED_MERGE_STEPS: set[str] = set()


def run_merge_pipeline(
    strategy_room_lists: list[dict],
    context: MergeContext,
    pipeline: list[str] | None = None,
    excluded: set[str] | None = None,
) -> tuple[list[dict], dict]:
    """Run the merge pipeline: a sequence of named steps over room data.

    Returns (rooms, meta) where meta contains per-step timing and diagnostics.
    """
    steps = pipeline or DEFAULT_MERGE_PIPELINE
    skip = excluded if excluded is not None else EXCLUDED_MERGE_STEPS
    meta_steps: list[dict] = []

    cluster_name = CLUSTER_STEP[0]
    current_data = strategy_room_lists
    clustered = False

    for step_name in steps:
        if step_name in skip:
            continue

        t0 = time.monotonic()

        if step_name == cluster_name:
            fn = CLUSTER_STEP[1]
            result = fn(current_data, context)
            current_data = result.rooms
            clustered = True
        elif not clustered and step_name in PRE_CLUSTER_STEPS:
            fn = PRE_CLUSTER_STEPS[step_name]
            result = fn(current_data, context)
            current_data = result.rooms
        elif clustered and step_name in POST_CLUSTER_STEPS:
            fn = POST_CLUSTER_STEPS[step_name]
            result = fn(current_data, context)
            current_data = result.rooms
        else:
            log.warning("Merge step %s not found or wrong phase, skipping", step_name)
            continue

        elapsed = int((time.monotonic() - t0) * 1000)
        step_meta = {"name": step_name, "time_ms": elapsed, **result.meta}
        meta_steps.append(step_meta)

    return current_data, {"steps": meta_steps}
