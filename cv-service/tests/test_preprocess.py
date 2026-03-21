import cv2
import numpy as np
from cv.preprocess import prepare, remove_letterbox

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


# --- remove_letterbox tests ---

def test_remove_letterbox_strips_black_bars():
    """Black bars on all 4 sides should be replaced with white."""
    # Create a 400x600 image with 50px black bars on all sides
    img = np.ones((400, 600), dtype=np.uint8) * 200  # light gray content
    img[:50, :] = 0   # top bar
    img[350:, :] = 0  # bottom bar
    img[:, :50] = 0   # left bar
    img[:, 550:] = 0  # right bar

    result = remove_letterbox(img)

    # Bars should now be white
    assert result[:50, :].mean() == 255, "Top bar should be white"
    assert result[350:, :].mean() == 255, "Bottom bar should be white"
    assert result[:, :50].mean() == 255, "Left bar should be white"
    assert result[:, 550:].mean() == 255, "Right bar should be white"
    # Interior should be unchanged
    assert result[200, 300] == 200, "Interior content should be unchanged"


def test_remove_letterbox_no_bars_unchanged():
    """Image without letterbox bars should be returned unchanged."""
    img = np.ones((400, 600), dtype=np.uint8) * 200
    result = remove_letterbox(img)
    np.testing.assert_array_equal(result, img)


def test_remove_letterbox_color_image():
    """Should work on BGR color images too."""
    img = np.ones((400, 600, 3), dtype=np.uint8) * 200
    img[:50, :, :] = 0   # top black bar
    img[350:, :, :] = 0  # bottom black bar

    result = remove_letterbox(img)

    assert result[:50, :, :].mean() == 255, "Top bar should be white"
    assert result[350:, :, :].mean() == 255, "Bottom bar should be white"
    assert result[200, 300, 0] == 200, "Interior should be unchanged"


def test_remove_letterbox_partial_bars():
    """Only sides with black bars should be modified."""
    img = np.ones((400, 600), dtype=np.uint8) * 200
    img[:, :60] = 0   # left bar only
    img[:, 540:] = 0  # right bar only

    result = remove_letterbox(img)

    assert result[:, :60].mean() == 255, "Left bar should be white"
    assert result[:, 540:].mean() == 255, "Right bar should be white"
    # Top and bottom unchanged (no bars there)
    assert result[0, 300] == 200, "Top edge should be unchanged"
    assert result[399, 300] == 200, "Bottom edge should be unchanged"


def test_remove_letterbox_does_not_eat_content():
    """Bars that aren't uniformly dark should not be removed."""
    img = np.ones((400, 600), dtype=np.uint8) * 200
    # Left side has dark AND light content (not a uniform bar)
    img[:, :50] = 0
    img[100:200, :50] = 150  # some light content in the "bar"

    result = remove_letterbox(img)

    # The left side has mixed content, so letterbox detection should stop
    # at the first non-dark strip. Some of it may be removed but the
    # content-bearing region should survive.
    assert result[150, 25] == 150, "Content in mixed region should survive"


def test_remove_letterbox_limits_scan_depth():
    """Should not scan more than 1/3 of the image from any edge."""
    # Image that's mostly black with a small white center
    img = np.zeros((300, 300), dtype=np.uint8)
    img[120:180, 120:180] = 200  # small white center

    result = remove_letterbox(img)

    # Should remove at most 100px (1/3 of 300) from each edge
    # The center content should survive
    assert result[150, 150] == 200, "Center content should survive"


def test_prepare_on_letterboxed_image():
    """prepare() on a letterboxed floor plan should not produce high density."""
    # Simulate: 520 W 23rd style - black bars with light content in center
    img = np.zeros((400, 800, 3), dtype=np.uint8)  # all black
    # Draw a simple floor plan in the center with white background + dark walls
    img[50:350, 200:600, :] = 240  # white background
    cv2.rectangle(img, (210, 60), (590, 340), (0, 0, 0), 8)  # outer wall
    cv2.line(img, (400, 60), (400, 340), (0, 0, 0), 6)  # interior wall

    # Without letterbox removal, prepare() would see the black bars as walls
    # With it, the bars become white background
    binary = prepare(remove_letterbox(img))
    h, w = binary.shape
    density = np.count_nonzero(binary) / (h * w)
    assert density < 0.15, f"Density should be low after letterbox removal, got {density:.3f}"
