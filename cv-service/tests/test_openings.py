from cv.preprocess import prepare
from cv.walls import detect_walls
from cv.rooms import detect_rooms
from cv.openings import detect_openings


def test_detect_door_in_2room(simple_2room_image):
    """The 2-room fixture has a door gap in the interior wall."""
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)
    rooms, closed = detect_rooms(binary)

    openings = detect_openings(binary, closed, rooms, walls, scale_cm_per_px=1.0)
    doors = [o for o in openings if o["type"] == "door"]
    assert len(doors) >= 1, f"Expected at least 1 door, got {len(doors)}"

    # The door should connect two different rooms
    door = doors[0]
    assert door["room_a_idx"] is not None or door["room_b_idx"] is not None, (
        "Door should be adjacent to at least one room"
    )


def test_door_has_reasonable_width(simple_2room_image):
    binary = prepare(simple_2room_image)
    walls = detect_walls(binary)
    rooms, closed = detect_rooms(binary)

    openings = detect_openings(binary, closed, rooms, walls, scale_cm_per_px=1.0)
    doors = [o for o in openings if o["type"] == "door"]
    for door in doors:
        assert door["width_px"] > 5, "Door gap should be > 5px wide"
        assert door["width_px"] < simple_2room_image.shape[0] // 2, (
            "Door gap shouldn't be wider than half the image"
        )
