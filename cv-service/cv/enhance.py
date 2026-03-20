"""Image enhancement presets for improving CV wall detection."""
import cv2
import numpy as np


def enhance(image: np.ndarray, preset: str = "standard") -> np.ndarray:
    """Apply preprocessing to improve wall/line visibility in floor plans.

    Takes a BGR image, returns a BGR image of the same shape.
    The existing prepare() binarization runs after this, unchanged.

    Args:
        image: BGR color image (np.ndarray, shape H x W x 3)
        preset: Enhancement preset name. Currently: "standard".
    """
    presets = {
        "standard": _preset_standard,
    }
    fn = presets.get(preset)
    if fn is None:
        raise ValueError(f"Unknown preset: {preset!r}. Available: {list(presets.keys())}")
    return fn(image)


def pick_winner(
    raw_result: dict, enhanced_result: dict
) -> tuple[dict, str]:
    """Compare two pipeline results and return (winner, strategy_name).

    More rooms wins. Ties go to raw (conservative — avoid regression).
    """
    raw_rooms = raw_result["meta"]["rooms_detected"]
    enhanced_rooms = enhanced_result["meta"]["rooms_detected"]

    if enhanced_rooms > raw_rooms:
        return enhanced_result, "enhanced"
    return raw_result, "raw"


def _preset_standard(image: np.ndarray) -> np.ndarray:
    """Standard enhancement: CLAHE on luminance + bilateral filter + unsharp mask."""
    # 1. CLAHE on L channel of LAB color space (preserves color for OCR)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_channel)

    lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])
    result = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

    # 2. Bilateral filter — reduces noise while preserving edges
    result = cv2.bilateralFilter(result, d=9, sigmaColor=75, sigmaSpace=75)

    # 3. Unsharp mask — sharpen faint wall edges
    blurred = cv2.GaussianBlur(result, (0, 0), sigmaX=2.0)
    result = cv2.addWeighted(result, 1.5, blurred, -0.5, 0)

    return result
