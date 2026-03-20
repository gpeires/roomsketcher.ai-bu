import numpy as np
from cv.preprocess import prepare
from cv.walls import detect_walls

def test_detect_walls_finds_horizontal_and_vertical(simple_2room_image):
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)
    assert len(walls) >= 5, f"Expected ≥5 walls (4 exterior + 1 interior), got {len(walls)}"
    horizontal = [w for w in walls if abs(w["start"][1] - w["end"][1]) < 10]
    vertical = [w for w in walls if abs(w["start"][0] - w["end"][0]) < 10]
    assert len(horizontal) >= 2, "Should find top and bottom walls"
    assert len(vertical) >= 3, "Should find left, right, and interior walls"

def test_walls_have_positive_thickness(simple_2room_image):
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)
    for w in walls:
        assert w["thickness"] > 0, "Every wall should have positive thickness"
