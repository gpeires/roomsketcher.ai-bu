"""Image preprocessing: convert floor plan image to clean binary wall mask."""
import cv2
import numpy as np


def remove_letterbox(image: np.ndarray) -> np.ndarray:
    """Remove black letterbox bars from floor plan images.

    Scans inward from each edge of the image. If a strip is uniformly dark
    (mean < 30, std < 15), it's a letterbox bar — fill with white (255) so
    it becomes background, not wall, during binarization.

    Works on both grayscale (H,W) and color (H,W,3) images.
    Returns the same dtype/shape with letterbox regions set to white.
    """
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    h, w = gray.shape
    strip = 10
    max_dark_mean = 30
    max_dark_std = 15
    # Don't scan more than 1/3 of the image from any edge
    max_top = h // 3
    max_left = w // 3

    top = 0
    while top + strip <= max_top:
        s = gray[top:top + strip, :]
        if s.mean() < max_dark_mean and s.std() < max_dark_std:
            top += strip
        else:
            break

    bottom = h
    while bottom - strip >= h - max_top:
        s = gray[bottom - strip:bottom, :]
        if s.mean() < max_dark_mean and s.std() < max_dark_std:
            bottom -= strip
        else:
            break

    left = 0
    while left + strip <= max_left:
        s = gray[:, left:left + strip]
        if s.mean() < max_dark_mean and s.std() < max_dark_std:
            left += strip
        else:
            break

    right = w
    while right - strip >= w - max_left:
        s = gray[:, right - strip:right]
        if s.mean() < max_dark_mean and s.std() < max_dark_std:
            right -= strip
        else:
            break

    # Only modify if we actually found letterbox bars
    if top == 0 and bottom == h and left == 0 and right == w:
        return image

    result = image.copy()
    fill = 255 if image.ndim == 2 else (255, 255, 255)
    if top > 0:
        result[:top, :] = fill
    if bottom < h:
        result[bottom:, :] = fill
    if left > 0:
        result[:, :left] = fill
    if right < w:
        result[:, right:] = fill

    return result


def prepare(image: np.ndarray) -> np.ndarray:
    """Convert a floor plan image to a binary wall mask (walls=255, rooms=0).

    Strategy:
    1. Try threshold-based detection first (works for clean, dark-walled plans).
    2. If too few wall pixels are found (< 1% of image), fall back to
       edge-based detection using Canny + morphological thickening.
       This handles real-world floor plans where walls are medium-gray.
    3. Connected-component filtering removes noise while preserving
       elongated wall segments.
    """
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    h, w = gray.shape
    total_pixels = h * w

    # --- Pass 1: threshold-based (fast, reliable for dark walls) ---
    binary = _threshold_pass(gray)

    # Check if we got enough wall pixels — if < 1%, walls are probably
    # not black and we need edge-based detection.
    wall_ratio = np.count_nonzero(binary) / total_pixels
    if wall_ratio < 0.01:
        binary = _edge_pass(gray)

    # Close small gaps in wall lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Remove noise blobs while keeping interior wall segments.
    binary = filter_components(binary, total_pixels)

    return binary


def _threshold_pass(gray: np.ndarray) -> np.ndarray:
    """Dark-pixel threshold for plans with black/near-black walls."""
    _, binary_strict = cv2.threshold(gray, 50, 255, cv2.THRESH_BINARY_INV)

    binary_adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 10
    )
    # Restrict adaptive to genuinely dark pixels
    dark_mask = (gray < 80).astype(np.uint8) * 255
    binary_adaptive = cv2.bitwise_and(binary_adaptive, dark_mask)

    return cv2.bitwise_or(binary_strict, binary_adaptive)


def _edge_pass(gray: np.ndarray) -> np.ndarray:
    """Adaptive detection for plans where walls aren't near-black.

    Uses Otsu's method to find the optimal foreground/background threshold,
    then combines with edge-based detection to capture wall structures.
    """
    h, w = gray.shape

    # Otsu automatically finds the threshold that best separates the two
    # main populations (bright background vs. darker walls/content)
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    otsu_val, binary_otsu = cv2.threshold(
        blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )

    # Also detect strong edges and thicken them
    edges = cv2.Canny(blurred, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    thick_edges = cv2.dilate(edges, kernel, iterations=1)

    # Combine: Otsu provides filled regions, edges reinforce boundaries
    combined = cv2.bitwise_or(binary_otsu, thick_edges)

    # Close small gaps
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, close_kernel, iterations=1)

    return combined


def filter_components(binary: np.ndarray, total_pixels: int) -> np.ndarray:
    """Remove noise blobs, keeping large or elongated (wall-like) components."""
    min_noise_area = max(50, int(total_pixels * 0.0003))
    min_wall_area = int(total_pixels * 0.003)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    mask = np.zeros_like(binary)
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_noise_area:
            continue
        if area >= min_wall_area:
            mask[labels == i] = 255
            continue
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        if aspect > 3:
            mask[labels == i] = 255
    return mask


def find_floor_plan_bbox(binary: np.ndarray, margin: int = 10) -> tuple[int, int, int, int]:
    """Find the bounding box of the actual floor plan within the image.

    Returns (x, y, w, h) of the region containing the dense wall structure,
    excluding header/legend areas that have little or no wall content.
    """
    h, w = binary.shape

    row_density = np.count_nonzero(binary, axis=1).astype(float)
    col_density = np.count_nonzero(binary, axis=0).astype(float)

    row_thresh = row_density.max() * 0.15
    col_thresh = col_density.max() * 0.15

    row_mask = row_density > row_thresh
    col_mask = col_density > col_thresh

    rows = np.where(row_mask)[0]
    cols = np.where(col_mask)[0]

    if len(rows) == 0 or len(cols) == 0:
        return (0, 0, w, h)

    y0 = max(0, int(rows[0]) - margin)
    y1 = min(h, int(rows[-1]) + margin)
    x0 = max(0, int(cols[0]) - margin)
    x1 = min(w, int(cols[-1]) + margin)

    return (x0, y0, x1 - x0, y1 - y0)
