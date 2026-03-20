from cv.preprocess import prepare
from cv.rooms import detect_rooms
from cv.topology import detect_adjacency


def test_two_adjacent_rooms(simple_2room_image):
    """Two rooms sharing an interior wall should be detected as adjacent."""
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)

    adj = detect_adjacency(rooms, binary)
    assert len(adj) >= 1, f"Expected at least 1 adjacency, got {len(adj)}"

    # The two rooms should be adjacent via a vertical wall
    a = adj[0]
    assert a["room_a_idx"] != a["room_b_idx"]
    assert a["orientation"] == "vertical"
    assert a["shared_length_px"] > 50, "Shared wall should be substantial"


def test_adjacency_has_center(simple_2room_image):
    binary = prepare(simple_2room_image)
    rooms, _ = detect_rooms(binary)

    adj = detect_adjacency(rooms, binary)
    for a in adj:
        cx, cy = a["shared_center_px"]
        assert 0 < cx < simple_2room_image.shape[1]
        assert 0 < cy < simple_2room_image.shape[0]
