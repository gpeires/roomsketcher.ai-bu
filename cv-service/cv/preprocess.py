"""Image preprocessing: convert floor plan image to clean binary wall mask."""
import cv2
import numpy as np


def prepare(image: np.ndarray) -> np.ndarray:
    """Convert a floor plan image to a binary wall mask (walls=255, rooms=0).

    Strategy:
    - Use a fixed dark-pixel threshold (< 50) to capture true black walls
      without picking up gray text/annotations.
    - Apply adaptive threshold on the same image for robustness on real photos
      with uneven lighting; combine with OR.
    - Morphological close to bridge minor gaps in wall lines.
    - Connected-component filter to drop tiny noise blobs.
    """
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    # Strict dark-pixel threshold: only capture near-black wall pixels
    _, binary_strict = cv2.threshold(gray, 50, 255, cv2.THRESH_BINARY_INV)

    # Adaptive threshold for real-photo robustness (may pick up text too,
    # but the area filter below removes isolated small blobs)
    binary_adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 10
    )
    # Restrict adaptive to only pixels already near-dark (< 128) to avoid
    # picking up medium-gray text on white backgrounds
    dark_mask = (gray < 128).astype(np.uint8) * 255
    binary_adaptive = cv2.bitwise_and(binary_adaptive, dark_mask)

    # Combine both passes
    binary = cv2.bitwise_or(binary_strict, binary_adaptive)

    # Close small gaps in wall lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Remove tiny noise blobs via connected-component area filtering.
    # Ratio 0.005 ensures text labels (~0.4% of image) are excluded while
    # wall structures (typically ≥5% when connected) are retained.
    min_wall_area = int((image.shape[0] * image.shape[1]) * 0.005)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    mask = np.zeros_like(binary)
    for i in range(1, num_labels):  # skip background (label 0)
        if stats[i, cv2.CC_STAT_AREA] >= min_wall_area:
            mask[labels == i] = 255

    return mask
