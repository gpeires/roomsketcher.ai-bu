"""Preprocessing strategy registry for sweep diagnostic endpoint."""
from typing import NamedTuple

import cv2
import numpy as np

from cv.preprocess import prepare, filter_components
from cv.enhance import enhance as _enhance_standard


class StrategyResult(NamedTuple):
    image: np.ndarray
    is_binary: bool  # True = skip prepare(), False = run prepare()


# ── Strategy functions ────────────────────────────────────────────────


def _raw(image: np.ndarray) -> StrategyResult:
    """Baseline — no preprocessing, let prepare() handle binarization."""
    return StrategyResult(image, is_binary=False)


def _enhanced(image: np.ndarray) -> StrategyResult:
    """Current standard preset: CLAHE + bilateral + unsharp mask."""
    return StrategyResult(_enhance_standard(image, preset="standard"), is_binary=False)


def _otsu(image: np.ndarray) -> StrategyResult:
    """Otsu's automatic threshold — good for bimodal histograms."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _adaptive_large(image: np.ndarray) -> StrategyResult:
    """Adaptive threshold with large block — handles uneven scan lighting."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=51, C=10,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _invert(image: np.ndarray) -> StrategyResult:
    """Invert grayscale — catches light-walls-on-dark-background plans.

    Returns inverted grayscale (2D) with is_binary=False.
    prepare() handles single-channel input via its ndim != 3 branch.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    inverted = 255 - gray
    return StrategyResult(inverted, is_binary=False)


def _canny_dilate(image: np.ndarray) -> StrategyResult:
    """Edge-first approach — Canny edges dilated into wall-width bands."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    edges = cv2.Canny(blurred, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.dilate(edges, kernel, iterations=2)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _downscale(image: np.ndarray) -> StrategyResult:
    """Downscale 50% → binarize → upscale. Thickens thin walls, reduces noise.

    Unique: calls prepare() internally. Returns binary mask with is_binary=True
    so the pipeline does NOT call prepare() again.
    """
    h, w = image.shape[:2]
    small = cv2.resize(image, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    binary_small = prepare(small)
    binary = cv2.resize(binary_small, (w, h), interpolation=cv2.INTER_NEAREST)
    return StrategyResult(binary, is_binary=True)


def _heavy_bilateral(image: np.ndarray) -> StrategyResult:
    """Aggressive bilateral smoothing + strong unsharp mask."""
    result = cv2.bilateralFilter(image, d=15, sigmaColor=150, sigmaSpace=150)
    blurred = cv2.GaussianBlur(result, (0, 0), sigmaX=3.0)
    result = cv2.addWeighted(result, 2.0, blurred, -1.0, 0)
    return StrategyResult(result, is_binary=False)


def _morphological_gradient(image: np.ndarray) -> StrategyResult:
    """Morphological gradient (dilate - erode) highlights boundaries regardless of wall color."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, kernel)
    _, binary = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _sauvola(image: np.ndarray) -> StrategyResult:
    """Sauvola document binarization — designed for scanned paper with uneven lighting.

    Sauvola threshold: T(x,y) = mean(x,y) * (1 + k * (std(x,y)/R - 1))
    where k=0.2, R=128, window=51x51.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    gray_f = gray.astype(np.float64)
    win = 51
    mean = cv2.blur(gray_f, (win, win))
    mean_sq = cv2.blur(gray_f * gray_f, (win, win))
    std = np.sqrt(np.maximum(mean_sq - mean * mean, 0))
    k, R = 0.2, 128.0
    thresh = mean * (1.0 + k * (std / R - 1.0))
    binary = np.where(gray_f < thresh, np.uint8(255), np.uint8(0))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _clahe_aggressive(image: np.ndarray) -> StrategyResult:
    """Aggressive CLAHE (clipLimit=8.0, tileGrid=4x4) then Otsu threshold."""
    if image.ndim == 3:
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        l_channel = lab[:, :, 0]
    else:
        l_channel = image
    clahe = cv2.createCLAHE(clipLimit=8.0, tileGridSize=(4, 4))
    enhanced = clahe.apply(l_channel)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 1.5)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _hsv_value(image: np.ndarray) -> StrategyResult:
    """Extract V channel from HSV — separates structure from color better than grayscale."""
    if image.ndim == 3:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        v_channel = hsv[:, :, 2]
    else:
        v_channel = image
    # Invert so dark walls become white
    inverted = 255 - v_channel
    _, binary = cv2.threshold(inverted, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _multi_scale(image: np.ndarray) -> StrategyResult:
    """Run prepare() at 3 scales (100%, 66%, 50%), upscale all, OR the masks.

    Catches walls at different thicknesses — thin walls detected at lower scales,
    thick walls at full scale.
    """
    h, w = image.shape[:2]
    scales = [1.0, 0.66, 0.5]
    masks = []
    for s in scales:
        sh, sw = int(h * s), int(w * s)
        if sh < 10 or sw < 10:
            continue
        resized = cv2.resize(image, (sw, sh), interpolation=cv2.INTER_AREA)
        mask = prepare(resized)
        upscaled = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
        masks.append(upscaled)
    combined = masks[0]
    for m in masks[1:]:
        combined = cv2.bitwise_or(combined, m)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=1)
    ch, cw = combined.shape
    combined = filter_components(combined, ch * cw)
    return StrategyResult(combined, is_binary=True)


# ── Registry ──────────────────────────────────────────────────────────

STRATEGIES: dict[str, callable] = {
    "raw": _raw,
    "enhanced": _enhanced,
    "otsu": _otsu,
    "adaptive_large": _adaptive_large,
    "invert": _invert,
    "canny_dilate": _canny_dilate,
    "downscale": _downscale,
    "heavy_bilateral": _heavy_bilateral,
    "morph_gradient": _morphological_gradient,
    "sauvola": _sauvola,
    "clahe_aggressive": _clahe_aggressive,
    "hsv_value": _hsv_value,
    "multi_scale": _multi_scale,
}
