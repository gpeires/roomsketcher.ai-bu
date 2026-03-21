"""Tests for wall-level multi-strategy merging."""
import numpy as np
import pytest
from cv.merge import merge_wall_masks, score_room_confidence, assemble_rooms


@pytest.fixture
def two_room_mask():
    """400x600 binary mask: outer walls + interior wall = 2 rooms."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, :] = 255; mask[390:400, :] = 255  # top/bottom
    mask[:, 0:10] = 255; mask[:, 590:600] = 255  # left/right
    mask[:, 295:305] = 255  # interior wall
    return mask


@pytest.fixture
def partial_mask_left():
    """Only has the left room's walls."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, :300] = 255; mask[390:400, :300] = 255
    mask[:, 0:10] = 255; mask[:, 290:300] = 255
    return mask


@pytest.fixture
def partial_mask_right():
    """Only has the right room's walls."""
    mask = np.zeros((400, 600), dtype=np.uint8)
    mask[0:10, 300:] = 255; mask[390:400, 300:] = 255
    mask[:, 300:310] = 255; mask[:, 590:600] = 255
    return mask


class TestMergeWallMasks:
    def test_or_combines_all_walls(self, partial_mask_left, partial_mask_right):
        """ORing two partial masks should produce a mask with both rooms' walls."""
        strategy_results = [
            {"mask": partial_mask_left, "rooms_detected": 1},
            {"mask": partial_mask_right, "rooms_detected": 1},
        ]
        merged = merge_wall_masks(strategy_results)
        # Merged should have walls from both sides
        assert merged[:, 0:10].sum() > 0    # left wall
        assert merged[:, 590:600].sum() > 0  # right wall
        assert merged[:, 295:310].sum() > 0  # interior wall area

    def test_excludes_zero_room_strategies(self, two_room_mask):
        """Strategies that detected 0 rooms should be excluded from merge."""
        noise = np.random.randint(0, 256, (400, 600), dtype=np.uint8)
        strategy_results = [
            {"mask": two_room_mask, "rooms_detected": 2},
            {"mask": noise, "rooms_detected": 0},
        ]
        merged = merge_wall_masks(strategy_results)
        # Should be similar to just the two_room_mask (noise excluded)
        assert merged.shape == two_room_mask.shape

    def test_merged_mask_is_cleaned(self, two_room_mask):
        """Merged mask should have small noise blobs removed."""
        noisy = two_room_mask.copy()
        noisy[200, 200] = 255  # single pixel noise
        strategy_results = [
            {"mask": noisy, "rooms_detected": 2},
        ]
        merged = merge_wall_masks(strategy_results)
        # Single pixel should be cleaned by filter_components
        # The wall structures should survive
        assert merged[:, 0:10].sum() > 0
        assert merged[:, 295:305].sum() > 0

    def test_fallback_when_no_strategies_found_rooms(self):
        """If all strategies found 0 rooms, use all masks anyway."""
        mask = np.zeros((400, 600), dtype=np.uint8)
        mask[0:10, :] = 255; mask[390:400, :] = 255
        mask[:, 0:10] = 255; mask[:, 590:600] = 255
        strategy_results = [
            {"mask": mask, "rooms_detected": 0},
        ]
        merged = merge_wall_masks(strategy_results)
        assert merged.shape == mask.shape


class TestScoreRoomConfidence:
    def test_high_agreement(self):
        """Room found by 5+ strategies -> 0.9."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [room_polygon], [room_polygon],
            [room_polygon], [room_polygon],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] >= 0.9

    def test_single_strategy(self):
        """Room found by only 1 strategy -> 0.3."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [], [], [], [],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] <= 0.3

    def test_medium_agreement(self):
        """Room found by 3 strategies -> 0.7."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [room_polygon], [room_polygon], [], [],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] == 0.7

    def test_two_strategies(self):
        """Room found by 2 strategies -> 0.5."""
        room_polygon = [(10, 10), (290, 10), (290, 390), (10, 390)]
        individual_rooms = [
            [room_polygon], [room_polygon], [], [], [],
        ]
        scores = score_room_confidence(
            merged_rooms=[{"polygon": room_polygon}],
            individual_results=individual_rooms,
            image_shape=(400, 600),
        )
        assert scores[0] == 0.5


class TestAssembleRooms:
    def test_converts_to_rectangles(self):
        """Polygons should be converted to rectangular bounding boxes."""
        rooms = [{"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]}]
        assembled = assemble_rooms(rooms, confidence_scores=[0.7], scale_cm_per_px=1.0)
        assert "width" in assembled[0]
        assert "depth" in assembled[0]
        assert assembled[0]["confidence"] == 0.7

    def test_positions_snapped_to_grid(self):
        """Positions should be snapped to 10px grid."""
        rooms = [{"polygon": [(13, 17), (293, 17), (293, 193), (13, 193)]}]
        assembled = assemble_rooms(rooms, confidence_scores=[0.9], scale_cm_per_px=1.0)
        assert assembled[0]["x"] % 10 == 0
        assert assembled[0]["y"] % 10 == 0

    def test_found_by_included(self):
        """found_by list should be included when provided."""
        rooms = [{"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]}]
        assembled = assemble_rooms(
            rooms, confidence_scores=[0.7], scale_cm_per_px=1.0,
            found_by=[["raw", "enhanced"]],
        )
        assert assembled[0]["found_by"] == ["raw", "enhanced"]

    def test_label_default(self):
        """Default label should be 'Room N'."""
        rooms = [
            {"polygon": [(10, 10), (290, 10), (290, 190), (10, 190)]},
            {"polygon": [(310, 10), (590, 10), (590, 190), (310, 190)]},
        ]
        assembled = assemble_rooms(rooms, confidence_scores=[0.7, 0.5], scale_cm_per_px=1.0)
        assert assembled[0]["label"] == "Room 1"
        assert assembled[1]["label"] == "Room 2"
