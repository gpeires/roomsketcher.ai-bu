from cv.pipeline import analyze_floor_plan


def test_pipeline_end_to_end(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    assert "rooms" in result
    assert len(result["rooms"]) >= 2
    assert all("label" in r for r in result["rooms"])
    assert all("width" in r for r in result["rooms"])
    assert all("depth" in r for r in result["rooms"])
    for room in result["rooms"]:
        assert room["width"] > 0
        assert room["depth"] > 0


def test_pipeline_returns_scale_info(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    assert "meta" in result
    assert "scale_cm_per_px" in result["meta"]
    assert result["meta"]["scale_cm_per_px"] > 0


def test_pipeline_includes_merge_metadata(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    meta = result["meta"]
    assert "strategies_run" in meta
    assert meta["strategies_run"] > 0
    assert "strategies_contributing" in meta
    assert "merge_stats" in meta
    assert "preprocessing" in meta
    assert meta["preprocessing"]["strategy_used"] == "multi_strategy_merge"


def test_pipeline_rooms_have_confidence(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    for room in result["rooms"]:
        assert "confidence" in room
        assert 0.0 <= room["confidence"] <= 1.0


def test_pipeline_rooms_have_found_by(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    for room in result["rooms"]:
        assert "found_by" in room
        assert isinstance(room["found_by"], list)


def test_pipeline_includes_merge_steps(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    meta = result["meta"]
    assert "merge_steps" in meta
    steps = meta["merge_steps"]["steps"]
    step_names = [s["name"] for s in steps]
    assert "bbox_filter_pre" in step_names
    assert "cluster" in step_names
    assert "bbox_filter_post" in step_names
    assert "structural_detect" in step_names
    for step in steps:
        assert "time_ms" in step
