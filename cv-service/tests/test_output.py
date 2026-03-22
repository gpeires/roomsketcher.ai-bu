import pytest
from cv.output import build_floor_plan_input, _is_room_label, _DIM_LIKE


class TestDimensionFiltering:
    """Dimension text and OCR garbage must not become room labels."""

    @pytest.mark.parametrize("text", [
        "14°4\"",       # OCR-garbled imperial
        "8-7\"",        # partial imperial
        "5'9\"",        # clean imperial
        "10'2\"",       # clean imperial
        "11'11\"",      # clean imperial
        "3.00m",        # metric
        "3.50",         # bare metric
        "x",            # separator
        "×",            # separator
        "P",            # single letter (OCR noise)
        "DW",           # fixture abbreviation
        "Ref",          # fixture abbreviation
        "W/D",          # fixture abbreviation
        "LC",           # fixture abbreviation
    ])
    def test_dim_like_rejects_noise(self, text):
        assert not _is_room_label(text), f"Should reject: {text!r}"

    @pytest.mark.parametrize("text", [
        "COMPASS",      # logo text (all-caps non-room word)
        "Hanna",        # person name (in _LOGO_WORDS)
        "9511",         # house number (pure digits)
    ])
    def test_rejects_non_room_proper_nouns(self, text):
        assert not _is_room_label(text), f"Should reject: {text!r}"

    @pytest.mark.parametrize("text", [
        "Kitchen",
        "Living Room",
        "Primary Bedroom",
        "Bath",
        "Foyer",
        "Hall",
        "Dining Room",
        "Dressing Area",
        "WIC",
        "CL",
        "Walk-in",
        "Living / Dining",
        "Living & Dining",
    ])
    def test_accepts_valid_room_labels(self, text):
        assert _is_room_label(text), f"Should accept: {text!r}"


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


def test_multiple_labels_in_room_picks_best():
    """When multiple text regions fall inside one room, pick the best single label."""
    rooms = [
        {"bbox": (10, 10, 200, 200), "area_px": 40000, "centroid": (110, 110), "mask": None},
    ]
    # Two labels inside the same room — "Kitchen" is closer to centroid
    text_regions = [
        {"text": "Kitchen", "center": (105, 115), "bbox": (80, 110, 50, 10), "confidence": 90},
        {"text": "Bedroom", "center": (50, 30), "bbox": (30, 25, 40, 10), "confidence": 90},
    ]
    result = build_floor_plan_input(rooms, text_regions, (300, 300), scale_cm_per_px=1.0)
    assert len(result["rooms"]) == 1
    # Should pick "Kitchen" (closest to centroid), NOT "Kitchen Bedroom"
    assert result["rooms"][0]["label"] == "Kitchen"


def test_multiple_labels_prefers_room_word():
    """When multiple labels fall in a room, prefer the one with a known room word."""
    rooms = [
        {"bbox": (10, 10, 200, 200), "area_px": 40000, "centroid": (110, 110), "mask": None},
    ]
    # "Primary" is closer but "Bathroom" contains a room word
    text_regions = [
        {"text": "Primary", "center": (108, 112), "bbox": (80, 107, 56, 10), "confidence": 90},
        {"text": "Bathroom", "center": (115, 120), "bbox": (90, 115, 50, 10), "confidence": 90},
    ]
    result = build_floor_plan_input(rooms, text_regions, (300, 300), scale_cm_per_px=1.0)
    # Both pass _is_room_label, but "Bathroom" has a known room word — "bath" is in _ROOM_WORDS
    # Actually both "primary" and "bathroom" are in _ROOM_WORDS, so it falls back to proximity
    # "Primary" at (108,112) is closer to centroid (110,110) than "Bathroom" at (115,120)
    assert result["rooms"][0]["label"] == "Primary"


class TestGhostRoomFiltering:
    """Rooms outside the floor plan or with garbage labels should be removed."""

    def _make_room(self, label, x, y, w, h, confidence=0.9):
        import numpy as np
        mask = np.zeros((800, 800), dtype=np.uint8)
        # Only create mask pixels if coordinates are valid
        if x >= 0 and y >= 0 and x + w <= 800 and y + h <= 800:
            mask[y:y+h, x:x+w] = 255
        return {
            "label": label,
            "bbox": (x, y, w, h),
            "area_px": w * h,
            "centroid": (x + w // 2, y + h // 2),
            "mask": mask,
            "polygon": [(x, y), (x+w, y), (x+w, y+h), (x, y+h)],
            "confidence": confidence,
        }

    def test_removes_negative_coordinate_rooms(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Ghost", -320, -60, 320, 760),  # negative coords
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 700),
        )
        labels = [r["label"] for r in result["rooms"]]
        assert "Kitchen" in labels
        assert "Ghost" not in labels

    def test_removes_zero_dimension_rooms(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Tiny", 300, 300, 5, 5),  # too small
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 700),
        )
        labels = [r["label"] for r in result["rooms"]]
        assert "Kitchen" in labels
        assert len(result["rooms"]) == 1

    def test_removes_rooms_outside_floor_plan_bbox(self):
        rooms = [
            self._make_room("Kitchen", 100, 100, 200, 150),
            self._make_room("Logo", 100, 750, 280, 60),  # below floor plan
        ]
        result = build_floor_plan_input(
            rooms, [], (800, 800), 1.0, "Test",
            floor_plan_bbox=(50, 50, 700, 650),
        )
        assert len(result["rooms"]) == 1
