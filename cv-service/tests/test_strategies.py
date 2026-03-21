import numpy as np
import pytest
from cv.strategies import STRATEGIES, StrategyResult


@pytest.fixture
def bgr_image():
    """Simple 400x600 BGR image with black walls on white background."""
    img = np.ones((400, 600, 3), dtype=np.uint8) * 255
    # Outer walls
    img[0:20, :] = 0
    img[380:400, :] = 0
    img[:, 0:20] = 0
    img[:, 580:600] = 0
    # Interior wall
    img[:, 295:305] = 0
    return img


class TestStrategyRegistry:
    def test_has_26_strategies(self):
        assert len(STRATEGIES) == 26

    def test_expected_names(self):
        expected = {"raw", "enhanced", "otsu", "adaptive_large",
                    "invert", "canny_dilate", "downscale", "heavy_bilateral",
                    "morph_gradient", "sauvola", "clahe_aggressive",
                    "hsv_value", "multi_scale",
                    "sobel_magnitude", "log_edges", "dog_edges",
                    "black_hat", "top_hat_otsu",
                    "niblack", "wolf",
                    "lab_a_channel", "lab_b_channel", "saturation",
                    "bilateral_adaptive", "median_otsu", "hough_lines"}
        assert set(STRATEGIES.keys()) == expected


class TestStrategyOutputs:
    @pytest.mark.parametrize("name", list(STRATEGIES.keys()))
    def test_returns_strategy_result(self, name, bgr_image):
        fn = STRATEGIES[name]
        result = fn(bgr_image.copy())
        assert isinstance(result, StrategyResult)
        assert isinstance(result.is_binary, bool)

    @pytest.mark.parametrize("name", ["raw", "enhanced", "heavy_bilateral"])
    def test_bgr_strategies_return_3channel(self, name, bgr_image):
        result = STRATEGIES[name](bgr_image.copy())
        assert result.is_binary is False
        assert result.image.ndim == 3
        assert result.image.shape[2] == 3

    @pytest.mark.parametrize("name", [
        "otsu", "adaptive_large", "canny_dilate", "downscale",
        "morph_gradient", "sauvola", "clahe_aggressive", "hsv_value", "multi_scale",
        "sobel_magnitude", "log_edges", "dog_edges",
        "black_hat", "top_hat_otsu",
        "niblack", "wolf",
        "lab_a_channel", "lab_b_channel", "saturation",
        "bilateral_adaptive", "median_otsu", "hough_lines",
    ])
    def test_binary_strategies_return_mask(self, name, bgr_image):
        result = STRATEGIES[name](bgr_image.copy())
        assert result.is_binary is True
        assert result.image.ndim == 2
        assert result.image.dtype == np.uint8
        unique = set(np.unique(result.image))
        assert unique <= {0, 255}

    def test_invert_returns_grayscale_non_binary(self, bgr_image):
        result = STRATEGIES["invert"](bgr_image.copy())
        assert result.is_binary is False
        # Grayscale — single channel
        assert result.image.ndim == 2

    def test_all_strategies_preserve_height_width(self, bgr_image):
        h, w = bgr_image.shape[:2]
        for name, fn in STRATEGIES.items():
            result = fn(bgr_image.copy())
            assert result.image.shape[:2] == (h, w), f"{name} changed image dimensions"
