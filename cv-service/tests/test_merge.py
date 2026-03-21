"""Tests for room-level multi-strategy merging."""
import cv2
import numpy as np
import pytest
from cv.merge import cluster_rooms, assemble_rooms, _bbox_iou
from cv.merge import MergeContext, MergeStepResult, compute_consensus_bbox


def _make_room(centroid, bbox=None, area_px=1000):
    cx, cy = centroid
    if bbox is None:
        bbox = (cx - 50, cy - 50, 100, 100)
    return {
        "bbox": bbox,
        "area_px": area_px,
        "centroid": centroid,
        "mask": np.zeros((10, 10), dtype=np.uint8),
        "polygon": [(cx - 50, cy - 50), (cx + 50, cy - 50),
                     (cx + 50, cy + 50), (cx - 50, cy + 50)],
    }


def _make_room_old(x, y, w, h):
    """Create a synthetic room dict matching detect_rooms() output."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[y:y+h, x:x+w] = 255
    return {
        "bbox": (x, y, w, h),
        "area_px": w * h,
        "centroid": (x + w // 2, y + h // 2),
        "mask": mask,
        "polygon": [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
    }


class TestMergeDataStructures:
    def test_merge_context_creation(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(10, 10, 590, 390), (15, 12, 585, 388)],
        )
        assert ctx.image_shape == (400, 600)
        assert len(ctx.strategy_bboxes) == 2
        assert ctx.consensus_bbox is None
        assert ctx.anchor_strategy is None
        assert ctx.strategy_masks is None
        assert ctx.columns is None

    def test_merge_step_result_creation(self):
        rooms = [{"bbox": (10, 10, 100, 100), "centroid": (60, 60)}]
        removed = [{"bbox": (0, 0, 10, 10), "removal_reason": "test"}]
        meta = {"rooms_removed": 1}
        result = MergeStepResult(rooms=rooms, removed=removed, meta=meta)
        assert len(result.rooms) == 1
        assert len(result.removed) == 1
        assert result.meta["rooms_removed"] == 1


class TestConsensusBbox:
    def test_median_of_bboxes(self):
        bboxes = [
            (10, 20, 500, 380),
            (15, 25, 510, 385),
            (12, 22, 505, 382),
        ]
        result = compute_consensus_bbox(bboxes)
        assert result == (12, 22, 505, 382)

    def test_robust_to_outlier(self):
        bboxes = [
            (10, 20, 500, 380),
            (12, 22, 502, 382),
            (11, 21, 501, 381),
            (10, 20, 500, 380),
            (0, 0, 1000, 1000),
        ]
        result = compute_consensus_bbox(bboxes)
        assert result == (10, 20, 501, 381)

    def test_degrades_to_full_image(self):
        bboxes = [(0, 0, 600, 400)] * 3
        result = compute_consensus_bbox(bboxes)
        assert result == (0, 0, 600, 400)

    def test_single_bbox(self):
        result = compute_consensus_bbox([(10, 20, 500, 380)])
        assert result == (10, 20, 500, 380)

    def test_empty_returns_none(self):
        result = compute_consensus_bbox([])
        assert result is None


class TestBboxIou:
    def test_identical_boxes(self):
        assert _bbox_iou((10, 10, 100, 100), (10, 10, 100, 100)) == 1.0

    def test_no_overlap(self):
        assert _bbox_iou((0, 0, 50, 50), (200, 200, 50, 50)) == 0.0

    def test_partial_overlap(self):
        iou = _bbox_iou((0, 0, 100, 100), (50, 50, 100, 100))
        assert 0.0 < iou < 1.0

    def test_one_inside_other(self):
        iou = _bbox_iou((0, 0, 200, 200), (50, 50, 50, 50))
        assert 0.0 < iou < 1.0


class TestClusterRooms:
    def test_same_room_two_strategies(self):
        room_a = _make_room_old(10, 10, 280, 180)
        room_b = _make_room_old(15, 12, 275, 178)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_a]},
            {"strategy": "enhanced", "rooms": [room_b]},
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["confidence"] == 0.5
        assert set(result[0]["found_by"]) == {"raw", "enhanced"}

    def test_different_rooms_separate_clusters(self):
        room_left = _make_room_old(10, 10, 200, 380)
        room_right = _make_room_old(310, 10, 280, 380)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_left, room_right]},
        ], image_shape=(400, 600))
        assert len(result) == 2

    def test_high_confidence_five_strategies(self):
        result = cluster_rooms([
            {"strategy": f"s{i}", "rooms": [_make_room_old(50 + i, 50 + i, 200, 150)]}
            for i in range(6)
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["confidence"] == 0.9
        assert result[0]["agreement_count"] == 6

    def test_medium_confidence_three_strategies(self):
        result = cluster_rooms([
            {"strategy": f"s{i}", "rooms": [_make_room_old(50 + i, 50 + i, 200, 150)]}
            for i in range(3)
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["confidence"] == 0.7

    def test_single_strategy_low_confidence(self):
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [_make_room_old(10, 10, 200, 150)]},
            {"strategy": "enhanced", "rooms": []},
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["confidence"] == 0.3

    def test_empty_input(self):
        result = cluster_rooms([
            {"strategy": "raw", "rooms": []},
        ], image_shape=(400, 600))
        assert result == []

    def test_union_discovers_more_rooms(self):
        room_a = _make_room_old(10, 10, 200, 180)
        room_b = _make_room_old(310, 10, 280, 180)
        room_c = _make_room_old(10, 210, 200, 180)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_a, room_b]},
            {"strategy": "enhanced", "rooms": [room_a, room_c]},
        ], image_shape=(400, 600))
        assert len(result) == 3

    def test_preserves_representative_fields(self):
        room = _make_room_old(10, 10, 200, 150)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room]},
        ], image_shape=(400, 600))
        assert "bbox" in result[0]
        assert "polygon" in result[0]
        assert "centroid" in result[0]
        assert "area_px" in result[0]
        assert "mask" in result[0]

    def test_largest_area_becomes_representative(self):
        small = _make_room_old(20, 20, 150, 100)
        large = _make_room_old(10, 10, 200, 150)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [small]},
            {"strategy": "enhanced", "rooms": [large]},
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["area_px"] == 30000

    def test_giant_room_excluded(self):
        normal = _make_room_old(10, 10, 100, 100)
        giant = _make_room_old(0, 0, 590, 390)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [normal, giant]},
        ], image_shape=(400, 600))
        assert len(result) == 1
        assert result[0]["area_px"] == 10000


class TestAssembleRooms:
    def test_converts_to_rectangles(self):
        rooms = [{"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]}]
        assembled = assemble_rooms(rooms, confidence_scores=[0.7], scale_cm_per_px=1.0)
        assert "width" in assembled[0]
        assert "depth" in assembled[0]
        assert assembled[0]["confidence"] == 0.7

    def test_positions_snapped_to_grid(self):
        rooms = [{"polygon": [(13, 17), (293, 17), (293, 193), (13, 193)]}]
        assembled = assemble_rooms(rooms, confidence_scores=[0.9], scale_cm_per_px=1.0)
        assert assembled[0]["x"] % 10 == 0
        assert assembled[0]["y"] % 10 == 0

    def test_found_by_included(self):
        rooms = [{"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]}]
        assembled = assemble_rooms(
            rooms, confidence_scores=[0.7], scale_cm_per_px=1.0,
            found_by=[["raw", "enhanced"]],
        )
        assert assembled[0]["found_by"] == ["raw", "enhanced"]

    def test_label_default(self):
        rooms = [
            {"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]},
            {"polygon": [(310, 10), (590, 10), (590, 190), (310, 190)]},
        ]
        assembled = assemble_rooms(rooms, confidence_scores=[0.7, 0.5], scale_cm_per_px=1.0)
        assert assembled[0]["label"] == "Room 1"
        assert assembled[1]["label"] == "Room 2"
