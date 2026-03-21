"""Tests for room-level multi-strategy merging."""
import numpy as np
import pytest
from cv.merge import cluster_rooms, assemble_rooms, _bbox_iou


def _make_room(x, y, w, h):
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
        """Same room found by two strategies should cluster together."""
        room_a = _make_room(10, 10, 280, 180)
        room_b = _make_room(15, 12, 275, 178)

        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_a]},
            {"strategy": "enhanced", "rooms": [room_b]},
        ], image_shape=(400, 600))

        assert len(result) == 1
        assert result[0]["confidence"] == 0.5
        assert set(result[0]["found_by"]) == {"raw", "enhanced"}

    def test_different_rooms_separate_clusters(self):
        """Non-overlapping rooms should be in separate clusters."""
        room_left = _make_room(10, 10, 200, 380)
        room_right = _make_room(310, 10, 280, 380)

        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_left, room_right]},
        ], image_shape=(400, 600))

        assert len(result) == 2

    def test_high_confidence_five_strategies(self):
        """Room found by 5+ strategies -> confidence 0.9."""
        result = cluster_rooms([
            {"strategy": f"s{i}", "rooms": [_make_room(50 + i, 50 + i, 200, 150)]}
            for i in range(6)
        ], image_shape=(400, 600))

        assert len(result) == 1
        assert result[0]["confidence"] == 0.9
        assert result[0]["agreement_count"] == 6

    def test_medium_confidence_three_strategies(self):
        """Room found by 3 strategies -> confidence 0.7."""
        result = cluster_rooms([
            {"strategy": f"s{i}", "rooms": [_make_room(50 + i, 50 + i, 200, 150)]}
            for i in range(3)
        ], image_shape=(400, 600))

        assert len(result) == 1
        assert result[0]["confidence"] == 0.7

    def test_single_strategy_low_confidence(self):
        """Room found by only 1 strategy -> confidence 0.3."""
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [_make_room(10, 10, 200, 150)]},
            {"strategy": "enhanced", "rooms": []},
        ], image_shape=(400, 600))

        assert len(result) == 1
        assert result[0]["confidence"] == 0.3

    def test_empty_input(self):
        """No rooms from any strategy -> empty result."""
        result = cluster_rooms([
            {"strategy": "raw", "rooms": []},
        ], image_shape=(400, 600))
        assert result == []

    def test_union_discovers_more_rooms(self):
        """Different strategies finding different rooms should all appear."""
        room_a = _make_room(10, 10, 200, 180)
        room_b = _make_room(310, 10, 280, 180)
        room_c = _make_room(10, 210, 200, 180)

        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room_a, room_b]},
            {"strategy": "enhanced", "rooms": [room_a, room_c]},
        ], image_shape=(400, 600))

        assert len(result) == 3  # Union: a, b, c

    def test_preserves_representative_fields(self):
        """Clustered rooms should preserve bbox, polygon, centroid, mask, area_px."""
        room = _make_room(10, 10, 200, 150)
        result = cluster_rooms([
            {"strategy": "raw", "rooms": [room]},
        ], image_shape=(400, 600))

        assert "bbox" in result[0]
        assert "polygon" in result[0]
        assert "centroid" in result[0]
        assert "area_px" in result[0]
        assert "mask" in result[0]

    def test_largest_area_becomes_representative(self):
        """The largest room in a cluster should be the representative."""
        small = _make_room(20, 20, 150, 100)  # area = 15000
        large = _make_room(10, 10, 200, 150)  # area = 30000

        result = cluster_rooms([
            {"strategy": "raw", "rooms": [small]},
            {"strategy": "enhanced", "rooms": [large]},
        ], image_shape=(400, 600))

        assert len(result) == 1
        assert result[0]["area_px"] == 30000


    def test_giant_room_excluded(self):
        """Rooms exceeding 50% of image area should be excluded as artifacts."""
        normal = _make_room(10, 10, 100, 100)   # 10000 px
        giant = _make_room(0, 0, 590, 390)       # 230100 px > 50% of 400*600=240000

        result = cluster_rooms([
            {"strategy": "raw", "rooms": [normal, giant]},
        ], image_shape=(400, 600))

        # Only the normal room should survive
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
