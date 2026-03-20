from cv.output import build_floor_plan_input

def test_build_basic_output():
    rooms = [
        {"bbox": (20, 20, 270, 370), "area_px": 99900, "centroid": (155, 200), "mask": None},
        {"bbox": (310, 20, 270, 370), "area_px": 99900, "centroid": (445, 200), "mask": None},
    ]
    text_regions = [
        {"text": "Kitchen", "center": (150, 200), "bbox": (100, 190, 100, 20), "confidence": 90},
        {"text": "Living", "center": (450, 200), "bbox": (370, 190, 80, 20), "confidence": 90},
        {"text": "3.00m", "center": (150, 385), "bbox": (120, 380, 60, 15), "confidence": 80},
    ]
    image_shape = (400, 600)
    result = build_floor_plan_input(rooms, text_regions, image_shape, scale_cm_per_px=1.0)
    assert result["name"] == "Extracted Floor Plan"
    assert len(result["rooms"]) == 2
    labels = {r["label"] for r in result["rooms"]}
    assert "Kitchen" in labels
    assert "Living" in labels
    kitchen = next(r for r in result["rooms"] if r["label"] == "Kitchen")
    assert kitchen["x"] >= 0
    assert kitchen["y"] >= 0
    assert kitchen["width"] > 0
    assert kitchen["depth"] > 0

def test_build_labels_assigned_by_proximity():
    rooms = [
        {"bbox": (10, 10, 100, 100), "area_px": 10000, "centroid": (60, 60), "mask": None},
        {"bbox": (200, 10, 100, 100), "area_px": 10000, "centroid": (250, 60), "mask": None},
    ]
    text_regions = [
        {"text": "Bedroom", "center": (55, 65), "bbox": (30, 60, 50, 10), "confidence": 90},
        {"text": "Bath", "center": (245, 65), "bbox": (230, 60, 30, 10), "confidence": 90},
    ]
    result = build_floor_plan_input(rooms, text_regions, (200, 400), scale_cm_per_px=1.0)
    labels = {r["label"] for r in result["rooms"]}
    assert "Bedroom" in labels
    assert "Bath" in labels
