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
