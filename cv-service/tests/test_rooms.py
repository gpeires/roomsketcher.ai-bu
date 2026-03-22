import cv2
import numpy as np
import pytest
from cv.preprocess import prepare
from cv.rooms import detect_rooms

def test_detect_rooms_finds_two_rooms(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)
    assert len(rooms) == 2, f"Expected 2 rooms, got {len(rooms)}"

def test_rooms_have_reasonable_area(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)
    img_area = simple_2room_image.shape[0] * simple_2room_image.shape[1]
    for room in rooms:
        ratio = room["area_px"] / img_area
        assert 0.05 < ratio < 0.8, f"Room area ratio {ratio} is unreasonable"

def test_rooms_are_left_and_right(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)
    centroids_x = sorted(r["centroid"][0] for r in rooms)
    img_mid = simple_2room_image.shape[1] // 2
    assert centroids_x[0] < img_mid, "First room should be on the left"
    assert centroids_x[1] > img_mid, "Second room should be on the right"

def test_rooms_have_polygons(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)
    for room in rooms:
        assert "polygon" in room
        assert len(room["polygon"]) >= 4, "Rectangle should have at least 4 vertices"

def test_detect_rooms_returns_closed_binary(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, closed = detect_rooms(binary)
    assert closed.shape == binary.shape
    # Closed mask should have MORE wall pixels (door gaps filled)
    assert np.count_nonzero(closed) >= np.count_nonzero(binary)


@pytest.fixture
def l_shaped_room_image() -> np.ndarray:
    """Synthetic L-shaped room: 500x400 image with one L-shaped room.

    Shape (walls = black, room = white):
    ┌─────────┐
    │         │
    │    ┌────┘
    │    │
    └────┘
    """
    img = np.ones((400, 500, 3), dtype=np.uint8) * 255
    # Draw L-shape outer walls
    pts = np.array([
        [50, 50], [350, 50], [350, 200], [250, 200],
        [250, 350], [50, 350],
    ], dtype=np.int32)
    # Fill exterior with gray, then fill room with white
    cv2.fillPoly(img, [pts], (255, 255, 255))
    cv2.polylines(img, [pts], isClosed=True, color=(0, 0, 0), thickness=15)
    # Fill outside the room with white (it's already white)
    return img


def test_l_shaped_room_detected(l_shaped_room_image):
    binary = prepare(l_shaped_room_image)
    rooms, _ = detect_rooms(binary)
    assert len(rooms) >= 1, "Should detect at least 1 room"
    # The L-shaped room should have more than 4 polygon vertices
    room = rooms[0]
    assert len(room["polygon"]) > 4, (
        f"L-shaped room should have >4 vertices, got {len(room['polygon'])}"
    )
    # Its area should be significantly less than its bbox area (it's L-shaped)
    bx, by, bw, bh = room["bbox"]
    bbox_area = bw * bh
    ratio = room["area_px"] / bbox_area
    assert ratio < 0.9, f"L-shaped room should have area ratio < 0.9, got {ratio}"


class TestWallThicknessEstimation:
    """Test that _estimate_wall_thickness correctly measures wall runs."""

    def test_thin_walls(self):
        from cv.rooms import _estimate_wall_thickness
        # 400x400 image with 3px-wide vertical wall at center
        binary = np.zeros((400, 400), dtype=np.uint8)
        binary[:, 198:201] = 255  # 3px wide wall
        thickness = _estimate_wall_thickness(binary)
        assert 2 <= thickness <= 5, f"Expected ~3px, got {thickness}"

    def test_thick_walls(self):
        from cv.rooms import _estimate_wall_thickness
        # 400x400 image with 25px-wide vertical wall at center
        binary = np.zeros((400, 400), dtype=np.uint8)
        binary[:, 188:213] = 255  # 25px wide wall
        thickness = _estimate_wall_thickness(binary)
        assert 20 <= thickness <= 30, f"Expected ~25px, got {thickness}"

    def test_empty_image(self):
        from cv.rooms import _estimate_wall_thickness
        binary = np.zeros((400, 400), dtype=np.uint8)
        assert _estimate_wall_thickness(binary) == 0.0


class TestAdaptiveGapSize:
    """Thick-walled plans should use smaller closing kernels to preserve small rooms."""

    def test_thick_walls_separate_small_rooms(self):
        """Two small rooms separated by a thick wall should remain separate."""
        # 800x800 image, two 200x300 rooms separated by 30px wall
        binary = np.zeros((800, 800), dtype=np.uint8)
        # Thick outer walls
        cv2.rectangle(binary, (50, 50), (750, 750), 255, 30)
        # Thick internal wall dividing rooms vertically
        cv2.rectangle(binary, (385, 50), (415, 750), 255, -1)
        rooms, _ = detect_rooms(binary)
        assert len(rooms) >= 2, f"Expected 2+ rooms with thick walls, got {len(rooms)}"
