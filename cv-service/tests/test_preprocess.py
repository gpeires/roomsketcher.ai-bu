import numpy as np
from cv.preprocess import prepare

def test_prepare_returns_binary_image(simple_2room_image):
    binary = prepare(simple_2room_image)
    assert binary.ndim == 2, "Should be single-channel"
    unique = set(np.unique(binary))
    assert unique <= {0, 255}, "Should be binary (0 and 255 only)"

def test_prepare_walls_are_white_on_black(simple_2room_image):
    binary = prepare(simple_2room_image)
    center_of_left_wall = binary[200, 5]
    center_of_room = binary[200, 150]
    assert center_of_left_wall == 255, "Wall pixels should be 255"
    assert center_of_room == 0, "Room interior should be 0"
