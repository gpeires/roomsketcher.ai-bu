import numpy as np
from cv.preprocess import prepare
from cv.rooms import detect_rooms

def test_detect_rooms_finds_two_rooms(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)
    assert len(rooms) == 2, f"Expected 2 rooms, got {len(rooms)}"

def test_rooms_have_reasonable_area(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)
    img_area = simple_2room_image.shape[0] * simple_2room_image.shape[1]
    for room in rooms:
        ratio = room["area_px"] / img_area
        assert 0.05 < ratio < 0.8, f"Room area ratio {ratio} is unreasonable"

def test_rooms_are_left_and_right(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms = detect_rooms(binary)
    centroids_x = sorted(r["centroid"][0] for r in rooms)
    img_mid = simple_2room_image.shape[1] // 2
    assert centroids_x[0] < img_mid, "First room should be on the left"
    assert centroids_x[1] > img_mid, "Second room should be on the right"
