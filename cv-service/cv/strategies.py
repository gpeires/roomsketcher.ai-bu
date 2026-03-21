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


# ── Edge detection variants ──────────────────────────────────────────


def _sobel_magnitude(image: np.ndarray) -> StrategyResult:
    """Sobel gradient magnitude — catches walls Canny misses due to different hysteresis."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    sobel_x = cv2.Sobel(blurred, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(blurred, cv2.CV_64F, 0, 1, ksize=3)
    magnitude = np.sqrt(sobel_x ** 2 + sobel_y ** 2)
    magnitude = np.clip(magnitude, 0, 255).astype(np.uint8)
    _, binary = cv2.threshold(magnitude, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _log_edges(image: np.ndarray) -> StrategyResult:
    """Laplacian of Gaussian — zero-crossing edge detector for wall boundaries in noisy scans."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (7, 7), 2.0)
    laplacian = cv2.Laplacian(blurred, cv2.CV_64F, ksize=5)
    # Take absolute value and normalize
    abs_lap = np.abs(laplacian)
    abs_lap = (abs_lap / abs_lap.max() * 255).astype(np.uint8) if abs_lap.max() > 0 else abs_lap.astype(np.uint8)
    _, binary = cv2.threshold(abs_lap, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _dog_edges(image: np.ndarray) -> StrategyResult:
    """Difference of Gaussians — band-pass filter highlighting edges at wall-width scale."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blur_small = cv2.GaussianBlur(gray, (3, 3), 1.0)
    blur_large = cv2.GaussianBlur(gray, (9, 9), 3.0)
    dog = cv2.subtract(blur_small, blur_large)
    _, binary = cv2.threshold(dog, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


# ── Morphology-based ─────────────────────────────────────────────────


def _black_hat(image: np.ndarray) -> StrategyResult:
    """Black-hat transform (closing - original) — extracts thin dark structures like walls."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    bhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
    _, binary = cv2.threshold(bhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _top_hat_otsu(image: np.ndarray) -> StrategyResult:
    """Top-hat (original - opening) + Otsu — enhances bright features, catches light walls on dark."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    that = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)
    _, binary = cv2.threshold(that, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


# ── Document binarization ────────────────────────────────────────────


def _niblack(image: np.ndarray) -> StrategyResult:
    """Niblack binarization — T(x,y) = mean + k*std. Aggressive local threshold for documents."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    gray_f = gray.astype(np.float64)
    win = 51
    mean = cv2.blur(gray_f, (win, win))
    mean_sq = cv2.blur(gray_f * gray_f, (win, win))
    std = np.sqrt(np.maximum(mean_sq - mean * mean, 0))
    k = -0.2
    thresh = mean + k * std
    binary = np.where(gray_f < thresh, np.uint8(255), np.uint8(0))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _wolf(image: np.ndarray) -> StrategyResult:
    """Wolf binarization — normalizes by min/max, handles low-contrast scans.

    T(x,y) = (1-k)*mean + k*M + k*(std/R)*(mean - M)
    where M = min(image), R = max(std), k=0.5.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    gray_f = gray.astype(np.float64)
    win = 51
    mean = cv2.blur(gray_f, (win, win))
    mean_sq = cv2.blur(gray_f * gray_f, (win, win))
    std = np.sqrt(np.maximum(mean_sq - mean * mean, 0))
    M = float(gray_f.min())
    R = float(std.max()) if std.max() > 0 else 1.0
    k = 0.5
    thresh = (1 - k) * mean + k * M + k * (std / R) * (mean - M)
    binary = np.where(gray_f < thresh, np.uint8(255), np.uint8(0))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


# ── Color/channel-based ──────────────────────────────────────────────


def _lab_a_channel(image: np.ndarray) -> StrategyResult:
    """LAB a-channel — separates red-green axis. Colored walls (red/green) show up strongly."""
    if image.ndim == 3:
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        a_channel = lab[:, :, 1]
    else:
        a_channel = image
    _, binary = cv2.threshold(a_channel, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _lab_b_channel(image: np.ndarray) -> StrategyResult:
    """LAB b-channel — separates blue-yellow axis. Blue-tinted plans become high-contrast."""
    if image.ndim == 3:
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        b_channel = lab[:, :, 2]
    else:
        b_channel = image
    _, binary = cv2.threshold(b_channel, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _saturation(image: np.ndarray) -> StrategyResult:
    """HSV saturation channel — colored walls vs grayscale background become obvious."""
    if image.ndim == 3:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        s_channel = hsv[:, :, 1]
    else:
        s_channel = image
    _, binary = cv2.threshold(s_channel, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


# ── Hybrid/multi-pass ────────────────────────────────────────────────


def _bilateral_adaptive(image: np.ndarray) -> StrategyResult:
    """Heavy bilateral smoothing then adaptive threshold — noise reduction + local adaptation."""
    smoothed = cv2.bilateralFilter(image, d=15, sigmaColor=150, sigmaSpace=150)
    gray = cv2.cvtColor(smoothed, cv2.COLOR_BGR2GRAY) if smoothed.ndim == 3 else smoothed
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=51, C=10,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _median_otsu(image: np.ndarray) -> StrategyResult:
    """Median filter (kills salt-and-pepper noise) then Otsu threshold."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    filtered = cv2.medianBlur(gray, 5)
    _, binary = cv2.threshold(filtered, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    h, w = binary.shape
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


def _hough_lines(image: np.ndarray) -> StrategyResult:
    """Hough line detection — geometrically targeted for straight-walled floor plans."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.5)
    edges = cv2.Canny(blurred, 50, 150)
    h, w = gray.shape
    # Probabilistic Hough — detect line segments
    min_line_length = max(20, min(h, w) // 20)
    max_line_gap = max(5, min(h, w) // 50)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=50,
                            minLineLength=min_line_length, maxLineGap=max_line_gap)
    binary = np.zeros((h, w), dtype=np.uint8)
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            cv2.line(binary, (x1, y1), (x2, y2), 255, thickness=3)
    # Close gaps between nearby line segments
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    binary = filter_components(binary, h * w)
    return StrategyResult(binary, is_binary=True)


# ── Registry ──────────────────────────────────────────────────────────

STRATEGIES: dict[str, callable] = {
    # Original 13
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
    # Edge detection variants
    "sobel_magnitude": _sobel_magnitude,
    "log_edges": _log_edges,
    "dog_edges": _dog_edges,
    # Morphology-based
    "black_hat": _black_hat,
    "top_hat_otsu": _top_hat_otsu,
    # Document binarization
    "niblack": _niblack,
    "wolf": _wolf,
    # Color/channel-based
    "lab_a_channel": _lab_a_channel,
    "lab_b_channel": _lab_b_channel,
    "saturation": _saturation,
    # Hybrid/multi-pass
    "bilateral_adaptive": _bilateral_adaptive,
    "median_otsu": _median_otsu,
    "hough_lines": _hough_lines,
}
