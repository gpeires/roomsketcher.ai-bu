"""Tests for room-level multi-strategy merging."""
import cv2
import numpy as np
import pytest
from cv.merge import cluster_rooms, assemble_rooms, _bbox_iou
from cv.merge import (
    MergeContext, MergeStepResult, compute_consensus_bbox, filter_by_bbox,
    cluster_rooms_step, filter_clusters_by_bbox, detect_columns_step,
    run_merge_pipeline, DEFAULT_MERGE_PIPELINE, EXCLUDED_MERGE_STEPS,
    PRE_CLUSTER_STEPS, POST_CLUSTER_STEPS, CLUSTER_STEP,
)


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


class TestFilterByBbox:
    def test_removes_rooms_outside_bbox(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(50, 50, 550, 350)] * 3,
        )
        strategy_rooms = [
            {"strategy": "raw", "rooms": [_make_room((300, 200)), _make_room((10, 10))]},
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        total_kept = sum(len(e["rooms"]) for e in result.rooms)
        assert total_kept == 1
        assert len(result.removed) == 1
        assert result.removed[0]["removal_reason"] == "outside_floor_plan_bbox"

    def test_keeps_rooms_inside_bbox(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 3,
        )
        strategy_rooms = [
            {"strategy": "raw", "rooms": [_make_room((300, 200)), _make_room((100, 100))]},
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        total_kept = sum(len(e["rooms"]) for e in result.rooms)
        assert total_kept == 2
        assert len(result.removed) == 0

    def test_sets_consensus_bbox_on_context(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(50, 50, 550, 350), (55, 55, 545, 345)],
        )
        strategy_rooms = [{"strategy": "raw", "rooms": []}]
        filter_by_bbox(strategy_rooms, ctx)
        assert ctx.consensus_bbox is not None

    def test_preserves_strategy_structure(self):
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
        )
        strategy_rooms = [
            {"strategy": "raw", "rooms": [_make_room((300, 200))]},
            {"strategy": "otsu", "rooms": [_make_room((100, 100))]},
        ]
        result = filter_by_bbox(strategy_rooms, ctx)
        assert len(result.rooms) == 2
        assert result.rooms[0]["strategy"] == "raw"
        assert result.rooms[1]["strategy"] == "otsu"


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


class TestClusterRoomsStep:
    def test_matches_existing_cluster_rooms(self):
        rooms = [_make_room((150, 200), area_px=5000), _make_room((450, 200), area_px=5000)]
        strategy_rooms = [
            {"strategy": "raw", "rooms": rooms},
            {"strategy": "otsu", "rooms": rooms},
        ]
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)])

        old_result = cluster_rooms(strategy_rooms, (400, 600))
        step_result = cluster_rooms_step(strategy_rooms, ctx)

        assert len(step_result.rooms) == len(old_result)
        for old, new in zip(old_result, step_result.rooms):
            assert old["centroid"] == new["centroid"]
            assert old["confidence"] == new["confidence"]

    def test_surfaces_giant_room_removals(self):
        giant = _make_room((300, 200), area_px=300000)
        normal = _make_room((150, 200), area_px=5000)
        strategy_rooms = [{"strategy": "raw", "rooms": [giant, normal]}]
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)])
        result = cluster_rooms_step(strategy_rooms, ctx)
        assert any(r.get("removal_reason") == "giant_room" for r in result.removed)


class TestFilterClustersByBbox:
    def test_removes_clusters_outside_bbox(self):
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(50, 50, 550, 350)] * 3)
        ctx.consensus_bbox = (50, 50, 550, 350)
        rooms = [
            {**_make_room((300, 200)), "confidence": 0.9, "found_by": ["raw"], "agreement_count": 5},
            {**_make_room((10, 10)), "confidence": 0.3, "found_by": ["raw"], "agreement_count": 1},
        ]
        result = filter_clusters_by_bbox(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.rooms[0]["centroid"] == (300, 200)
        assert len(result.removed) == 1

    def test_noop_when_no_consensus_bbox(self):
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[])
        rooms = [{**_make_room((300, 200)), "confidence": 0.9, "found_by": ["raw"], "agreement_count": 5}]
        result = filter_clusters_by_bbox(rooms, ctx)
        assert len(result.rooms) == 1
        assert len(result.removed) == 0


class TestDetectColumnsStep:
    def _make_grid_mask(self):
        mask = np.zeros((400, 600), dtype=np.uint8)
        for row in range(3):
            for col in range(4):
                y, x = 50 + row * 100, 80 + col * 120
                mask[y:y+10, x:x+10] = 255
        mask[0:5, :] = 255
        mask[:, 0:5] = 255
        return mask

    def test_finds_grid(self):
        mask = self._make_grid_mask()
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_columns_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.rooms[0]["centroid"] == (300, 200)
        assert ctx.columns is not None
        assert result.meta["columns_found"] >= 6

    def test_ignores_elongated_components(self):
        mask = np.zeros((400, 600), dtype=np.uint8)
        mask[100:102, 100:200] = 255
        mask[200:220, 200:202] = 255
        rooms = []
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)],
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        result = detect_columns_step(rooms, ctx)
        assert result.meta["columns_found"] == 0

    def test_noop_when_no_masks(self):
        rooms = [_make_room((300, 200))]
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)])
        result = detect_columns_step(rooms, ctx)
        assert len(result.rooms) == 1
        assert result.meta.get("skipped") is True


class TestMergePipeline:
    def _make_strategy_data(self):
        rooms = [_make_room((150, 200), area_px=5000), _make_room((450, 200), area_px=5000)]
        return [
            {"strategy": "raw", "rooms": rooms, "count": 2},
            {"strategy": "otsu", "rooms": rooms, "count": 2},
        ]

    def test_runs_all_steps(self):
        strategy_rooms = self._make_strategy_data()
        mask = np.zeros((400, 600), dtype=np.uint8)
        mask[0:20, :] = 255
        ctx = MergeContext(
            image_shape=(400, 600),
            strategy_bboxes=[(0, 0, 600, 400)] * 2,
            anchor_strategy="raw",
            strategy_masks=[{"strategy": "raw", "mask": mask}],
        )
        rooms, meta = run_merge_pipeline(strategy_rooms, ctx)
        assert len(rooms) >= 1
        assert "steps" in meta
        step_names = [s["name"] for s in meta["steps"]]
        assert "bbox_filter_pre" in step_names
        assert "cluster" in step_names
        assert "bbox_filter_post" in step_names
        assert "column_detect" in step_names

    def test_excludes_steps(self):
        strategy_rooms = self._make_strategy_data()
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)] * 2)
        rooms, meta = run_merge_pipeline(strategy_rooms, ctx, excluded={"bbox_filter_pre", "column_detect"})
        step_names = [s["name"] for s in meta["steps"]]
        assert "bbox_filter_pre" not in step_names
        assert "column_detect" not in step_names
        assert "cluster" in step_names

    def test_step_meta_has_timing(self):
        strategy_rooms = self._make_strategy_data()
        ctx = MergeContext(image_shape=(400, 600), strategy_bboxes=[(0, 0, 600, 400)] * 2)
        _, meta = run_merge_pipeline(strategy_rooms, ctx)
        for step in meta["steps"]:
            assert "time_ms" in step
            assert "name" in step

    def test_registry_populated(self):
        assert "bbox_filter_pre" in PRE_CLUSTER_STEPS
        assert CLUSTER_STEP[0] == "cluster"
        assert "bbox_filter_post" in POST_CLUSTER_STEPS
        assert "column_detect" in POST_CLUSTER_STEPS

    def test_default_pipeline_order(self):
        assert DEFAULT_MERGE_PIPELINE == ["bbox_filter_pre", "cluster", "bbox_filter_post", "column_detect"]

    def test_excluded_merge_steps_empty(self):
        assert len(EXCLUDED_MERGE_STEPS) == 0


class TestMergeContextFields:
    def test_has_anchor_mask(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
            anchor_mask=mask,
        )
        assert ctx.anchor_mask is not None
        assert ctx.anchor_mask.shape == (100, 100)

    def test_has_thickness_profile(self):
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
        )
        assert ctx.thickness_profile is None

    def test_has_structural_backend(self):
        ctx = MergeContext(
            image_shape=(100, 100),
            strategy_bboxes=[(0, 0, 100, 100)],
        )
        assert ctx.structural_backend == "distance_transform"


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
