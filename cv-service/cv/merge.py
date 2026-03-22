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


def _safe_dilation(thick_wall_px: float) -> int:
    """Compute dilation for polygon refinement, capped to avoid swallowing rooms."""
    raw = max(1, int(thick_wall_px / 2))
    return min(raw, 8)  # cap at 8px to preserve small rooms


def cap_wall_thickness_cm(thin_cm: float, thick_cm: float) -> tuple[float, float]:
    """Clamp wall thickness to realistic residential bounds.

    Interior walls: 5-20cm (typical 10-15cm)
    Exterior walls: 10-40cm (typical 20-30cm)
    """
    thin_cm = max(5.0, min(thin_cm, 20.0))
    thick_cm = max(10.0, min(thick_cm, 40.0))
    # Exterior must be >= interior
    thick_cm = max(thick_cm, thin_cm)
    return thin_cm, thick_cm


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


def _find_thin_wall_peak(distances: np.ndarray) -> float:
    """Find the dominant thin-wall half-thickness from the distance transform histogram.

    The distance transform of wall pixels gives half-thickness at each point.
    Thin walls produce a strong peak at low values (typically 1-3px).
    Returns the peak half-thickness value.
    """
    wall_distances = distances[distances > 0]
    if len(wall_distances) == 0:
        return 1.0

    max_dist = min(int(wall_distances.max()) + 1, 50)
    hist, bin_edges = np.histogram(wall_distances, bins=max_dist, range=(0.5, max_dist + 0.5))

    if len(hist) == 0:
        return 1.0

    peak_bin = int(np.argmax(hist))
    return bin_edges[peak_bin] + 0.5  # center of bin


def detect_structural_elements_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Detect structural elements (columns, thick walls) via distance transform.

    Replaces detect_columns_step. Uses distance transform on the anchor mask
    to measure wall thickness, then classifies thick regions as columns or
    thick walls based on shape.
    """
    anchor_mask = context.anchor_mask
    if anchor_mask is None:
        # Fallback: try to find anchor mask from strategy_masks
        if context.strategy_masks and context.anchor_strategy:
            for s in context.strategy_masks:
                if s["strategy"] == context.anchor_strategy:
                    anchor_mask = s["mask"]
                    break
        if anchor_mask is None:
            return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    h, w = anchor_mask.shape
    total_px = h * w

    # Distance transform: each wall pixel gets its distance to the nearest room pixel.
    dist = cv2.distanceTransform(anchor_mask, cv2.DIST_L2, 5)

    # Find the thin-wall baseline
    thin_half = _find_thin_wall_peak(dist)
    thin_full = thin_half * 2

    # Threshold: pixels with distance > 2x the thin-wall peak are "thick"
    thick_threshold = thin_half * 2
    thick_mask = (dist > thick_threshold).astype(np.uint8) * 255

    # Connected components on thick regions
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        thick_mask, connectivity=8
    )

    elements: list[StructuralElement] = []
    min_area = max(20, int(total_px * 0.0001))

    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        cx, cy = int(centroids[i][0]), int(centroids[i][1])
        bx = int(stats[i, cv2.CC_STAT_LEFT])
        by = int(stats[i, cv2.CC_STAT_TOP])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        aspect = max(bw, bh) / max(min(bw, bh), 1)

        # Measure thickness: max distance value within this blob
        blob_mask = (labels == i)
        max_thickness = float(dist[blob_mask].max()) * 2  # full thickness

        # Junction false-positive filter
        if area < max(2000, int(total_px * 0.005)):
            margin = 3
            y0 = max(0, by - margin)
            y1 = min(h, by + bh + margin)
            x0 = max(0, bx - margin)
            x1 = min(w, bx + bw + margin)
            edges_wall = 0
            if y0 > 0:
                edges_wall += int(np.sum(anchor_mask[y0, x0:x1] > 0))
            if y1 < h:
                edges_wall += int(np.sum(anchor_mask[y1 - 1, x0:x1] > 0))
            if x0 > 0:
                edges_wall += int(np.sum(anchor_mask[y0:y1, x0] > 0))
            if x1 < w:
                edges_wall += int(np.sum(anchor_mask[y0:y1, x1 - 1] > 0))
            perimeter_len = 2 * (x1 - x0) + 2 * (y1 - y0)
            wall_ratio = edges_wall / max(perimeter_len, 1)
            if wall_ratio > 0.6 and aspect < 2.0:
                continue

        # Classify
        if area > total_px * 0.2:
            kind = "perimeter"
        elif aspect < 3 and area < max(5000, int(total_px * 0.01)):
            kind = "column"
        else:
            kind = "thick_wall"

        elements.append(StructuralElement(
            kind=kind,
            centroid=(cx, cy),
            bbox=(bx, by, bw, bh),
            area_px=area,
            thickness_px=max_thickness,
            aspect_ratio=round(aspect, 2),
        ))

    # Compute median thick-wall thickness
    thick_thicknesses = [e.thickness_px for e in elements if e.kind != "perimeter"]
    thick_wall_px = float(np.median(thick_thicknesses)) if thick_thicknesses else thin_full

    # Grid detection
    column_elements = [e for e in elements if e.kind == "column"]
    grid_detected = False
    grid_spacing = None
    if len(column_elements) >= 3:
        xs = sorted(e.centroid[0] for e in column_elements)
        ys = sorted(e.centroid[1] for e in column_elements)
        grid_detected, grid_spacing = _check_grid_regularity(xs, ys)

    profile = ThicknessProfile(
        elements=elements,
        thin_wall_px=thin_full,
        thick_wall_px=thick_wall_px,
        grid_detected=grid_detected,
        grid_spacing_px=grid_spacing,
    )
    context.thickness_profile = profile

    # Backward-compat: also set context.columns
    context.columns = [
        {"centroid": e.centroid, "bbox": e.bbox, "area_px": e.area_px}
        for e in column_elements
    ]

    meta = {
        "columns_found": len(column_elements),
        "grid_detected": grid_detected,
        "grid_spacing_px": grid_spacing,
        "structural_elements": len(elements),
        "thin_wall_px": round(thin_full, 1),
        "thick_wall_px": round(thick_wall_px, 1),
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


def refine_polygons_step(
    rooms: list[dict],
    context: MergeContext,
) -> MergeStepResult:
    """Refine room polygons using wall thickness data.

    Dilates thick wall regions in the wall mask so room contours follow the
    inner face of thick walls. This can split merged rooms and preserve
    protrusions/alcoves created by structural elements.
    """
    if context.anchor_mask is None or context.thickness_profile is None:
        return MergeStepResult(rooms=rooms, removed=[], meta={"skipped": True})

    profile = context.thickness_profile
    if not profile.elements:
        return MergeStepResult(rooms=rooms, removed=[], meta={
            "skipped": False, "reason": "no_thick_elements", "rooms_in": len(rooms),
        })

    anchor_mask = context.anchor_mask.copy()
    h, w = anchor_mask.shape
    min_room_area = int(h * w * 0.005)

    # Build dilation mask: only dilate in regions around structural elements
    dilation_amount = _safe_dilation(profile.thick_wall_px)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                                       (dilation_amount * 2 + 1, dilation_amount * 2 + 1))

    # Create a region mask covering structural element bboxes (with padding)
    region_mask = np.zeros((h, w), dtype=np.uint8)
    pad = dilation_amount * 2
    for elem in profile.elements:
        bx, by, bw, bh = elem.bbox
        y0 = max(0, by - pad)
        y1 = min(h, by + bh + pad)
        x0 = max(0, bx - pad)
        x1 = min(w, bx + bw + pad)
        region_mask[y0:y1, x0:x1] = 255

    # Dilate the wall mask, but only apply changes in structural regions
    dilated = cv2.dilate(anchor_mask, kernel, iterations=1)
    refined_mask = anchor_mask.copy()
    structural_region = region_mask > 0
    refined_mask[structural_region] = dilated[structural_region]

    # Re-trace room contours on the refined mask
    gap_size = max(15, min(80, max(h, w) // 10))
    v_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap_size))
    closed = cv2.morphologyEx(refined_mask, cv2.MORPH_CLOSE, v_kern, iterations=1)
    h_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (gap_size, 1))
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, h_kern, iterations=1)

    inv = cv2.bitwise_not(closed)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(inv, connectivity=4)

    # Collect refined room contours
    refined_rooms: list[dict] = []
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_room_area:
            continue
        rx = int(stats[i, cv2.CC_STAT_LEFT])
        ry = int(stats[i, cv2.CC_STAT_TOP])
        rw = int(stats[i, cv2.CC_STAT_WIDTH])
        rh = int(stats[i, cv2.CC_STAT_HEIGHT])
        rcx, rcy = int(centroids[i][0]), int(centroids[i][1])

        # Skip exterior background
        touches_border = rx == 0 or ry == 0 or (rx + rw) >= w or (ry + rh) >= h
        if touches_border and area > (h * w * 0.3):
            continue

        # Extract polygon
        room_mask = (labels == i).astype(np.uint8) * 255
        contours, _ = cv2.findContours(room_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        largest_contour = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest_contour, True)
        epsilon = 0.015 * perimeter
        approx = cv2.approxPolyDP(largest_contour, epsilon, True)
        polygon = [(int(pt[0][0]), int(pt[0][1])) for pt in approx]

        refined_rooms.append({
            "centroid": (rcx, rcy),
            "bbox": (rx, ry, rw, rh),
            "area_px": int(area),
            "polygon": polygon,
            "mask": room_mask,
        })

    # Match refined rooms to originals
    max_match_dist = max(h, w) * 0.3
    matches: dict[int, list[dict]] = {}  # orig_idx -> list of refined rooms
    unmatched_refined: list[dict] = []

    for refined in refined_rooms:
        rcx, rcy = refined["centroid"]
        best_idx = -1
        best_dist = float("inf")
        for j, orig in enumerate(rooms):
            ocx, ocy = orig.get("centroid", (0, 0))
            if isinstance(ocx, float):
                ocx, ocy = int(ocx), int(ocy)
            ox, oy, ow, oh = orig.get("bbox", (0, 0, w, h))
            inside = ox <= rcx <= ox + ow and oy <= rcy <= oy + oh
            d = ((rcx - ocx) ** 2 + (rcy - ocy) ** 2) ** 0.5
            if (inside or d < max_match_dist) and d < best_dist:
                best_dist = d
                best_idx = j

        if best_idx >= 0:
            matches.setdefault(best_idx, []).append(refined)
        else:
            unmatched_refined.append(refined)

    output_rooms: list[dict] = []
    matched_originals: set[int] = set()

    for orig_idx, refined_list in matches.items():
        matched_originals.add(orig_idx)
        orig = rooms[orig_idx]
        if len(refined_list) == 1:
            output_rooms.append({
                **orig,
                "polygon": refined_list[0]["polygon"],
                "centroid": refined_list[0]["centroid"],
                "bbox": refined_list[0]["bbox"],
                "area_px": refined_list[0]["area_px"],
            })
        else:
            # Split: largest inherits original, others get split_from
            sorted_by_area = sorted(refined_list, key=lambda r: r["area_px"], reverse=True)
            largest = sorted_by_area[0]
            output_rooms.append({
                **orig,
                "polygon": largest["polygon"],
                "centroid": largest["centroid"],
                "bbox": largest["bbox"],
                "area_px": largest["area_px"],
            })
            for split_room in sorted_by_area[1:]:
                output_rooms.append({
                    **split_room,
                    "confidence": 0.5,
                    "found_by": orig.get("found_by", []),
                    "split_from": orig.get("centroid"),
                    "source": "polygon_refine",
                })

    # Unmatched refined rooms = newly discovered
    for refined in unmatched_refined:
        output_rooms.append({
            **refined,
            "confidence": 0.3,
            "found_by": [],
            "source": "polygon_refine",
        })

    # Preserve lost rooms (originals with no match)
    for j, orig in enumerate(rooms):
        if j not in matched_originals:
            log.warning("polygon_refine: room at %s lost, preserving original", orig.get("centroid"))
            output_rooms.append(orig)

    meta = {
        "rooms_in": len(rooms),
        "rooms_out": len(output_rooms),
        "rooms_split": max(0, len(output_rooms) - len(rooms)),
        "rooms_lost_preserved": len(rooms) - len(matched_originals),
        "dilation_px": dilation_amount,
    }
    return MergeStepResult(rooms=output_rooms, removed=[], meta=meta)


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
    "structural_detect": detect_structural_elements_step,
    "polygon_refine": refine_polygons_step,
}

DEFAULT_MERGE_PIPELINE = [
    "bbox_filter_pre",
    "cluster",
    "bbox_filter_post",
    "structural_detect",
    "polygon_refine",
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
