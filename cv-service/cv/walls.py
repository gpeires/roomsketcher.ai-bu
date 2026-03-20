"""Wall detection using morphological line extraction and contour analysis."""
import cv2
import numpy as np


def detect_walls(binary: np.ndarray) -> list[dict]:
    """Detect wall segments from a binary wall mask.

    Uses morphological opening with elongated kernels to isolate horizontal
    and vertical line structures, then extracts bounding-box segments from
    the resulting connected components.

    Returns a list of dicts with keys:
        start: (x, y) tuple for the segment start
        end:   (x, y) tuple for the segment end
        thickness: pixel thickness of the wall
    """
    h, w = binary.shape
    walls = []

    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(w // 10, 30), 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)
    walls.extend(_extract_segments(h_lines, orientation="horizontal"))

    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(h // 10, 30)))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)
    walls.extend(_extract_segments(v_lines, orientation="vertical"))

    return walls


def _extract_segments(mask: np.ndarray, orientation: str) -> list[dict]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    segments = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if orientation == "horizontal":
            if w < 20:
                continue
            mid_y = y + h // 2
            segments.append({"start": (x, mid_y), "end": (x + w, mid_y), "thickness": h})
        else:
            if h < 20:
                continue
            mid_x = x + w // 2
            segments.append({"start": (mid_x, y), "end": (mid_x, y + h), "thickness": w})
    return segments
