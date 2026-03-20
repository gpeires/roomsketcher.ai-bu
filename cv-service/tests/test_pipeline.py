from cv.pipeline import analyze_floor_plan

def test_pipeline_end_to_end(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    assert "rooms" in result
    assert len(result["rooms"]) == 2
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


def test_pipeline_includes_preprocessing_metadata(simple_2room_path):
    result = analyze_floor_plan(str(simple_2room_path))
    assert "preprocessing" in result["meta"]
    pre = result["meta"]["preprocessing"]
    assert "raw_rooms" in pre
    assert "enhanced_rooms" in pre
    assert "raw_walls" in pre
    assert "enhanced_walls" in pre
    assert pre["strategy_used"] in ("raw", "enhanced")


def test_pipeline_preprocessing_raw_wins_tie(simple_2room_path):
    """When raw and enhanced find the same rooms, raw should win.
    The synthetic image has perfect black-on-white contrast, so both
    paths should find 2 rooms — making this a reliable tie scenario."""
    result = analyze_floor_plan(str(simple_2room_path))
    pre = result["meta"]["preprocessing"]
    assert pre["raw_rooms"] == pre["enhanced_rooms"], (
        f"Expected tie on synthetic image, got raw={pre['raw_rooms']} vs enhanced={pre['enhanced_rooms']}"
    )
    assert pre["strategy_used"] == "raw"


def test_pipeline_enhancement_failure_falls_back_to_raw(simple_2room_path, monkeypatch):
    """If enhance() throws, the pipeline should still return raw results."""
    import cv.enhance
    monkeypatch.setattr(cv.enhance, "enhance", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    result = analyze_floor_plan(str(simple_2room_path))
    assert "preprocessing" in result["meta"]
    assert result["meta"]["preprocessing"]["strategy_used"] == "raw"
    assert result["meta"]["preprocessing"]["enhanced_rooms"] == 0
    assert len(result["rooms"]) == 2  # raw still works
