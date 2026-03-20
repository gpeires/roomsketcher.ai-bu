import numpy as np
import pytest
from cv.enhance import enhance, pick_winner


class TestEnhance:
    def test_returns_same_shape_as_input(self, simple_2room_image):
        result = enhance(simple_2room_image)
        assert result.shape == simple_2room_image.shape

    def test_returns_bgr_image(self, simple_2room_image):
        result = enhance(simple_2room_image)
        assert result.ndim == 3
        assert result.shape[2] == 3

    def test_modifies_pixel_values(self, simple_2room_image):
        result = enhance(simple_2room_image)
        # Enhancement should change at least some pixels
        assert not np.array_equal(result, simple_2room_image)

    def test_increases_contrast_on_low_contrast_image(self, low_contrast_2room_image):
        original = low_contrast_2room_image
        enhanced = enhance(original)
        # Standard deviation of pixel values should increase (more contrast)
        orig_std = np.std(original.astype(float))
        enhanced_std = np.std(enhanced.astype(float))
        assert enhanced_std > orig_std, (
            f"Enhanced contrast ({enhanced_std:.1f}) should exceed "
            f"original ({orig_std:.1f})"
        )

    def test_unknown_preset_raises(self, simple_2room_image):
        with pytest.raises(ValueError, match="Unknown preset"):
            enhance(simple_2room_image, preset="nonexistent")

    def test_standard_preset_is_default(self, simple_2room_image):
        default_result = enhance(simple_2room_image)
        explicit_result = enhance(simple_2room_image, preset="standard")
        assert np.array_equal(default_result, explicit_result)


class TestPickWinner:
    def _make_result(self, rooms_detected, walls_detected=10):
        return {
            "meta": {
                "rooms_detected": rooms_detected,
                "walls_detected": walls_detected,
            }
        }

    def test_more_rooms_wins(self):
        raw = self._make_result(2)
        enhanced = self._make_result(5)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "enhanced"
        assert winner is enhanced

    def test_raw_wins_when_more_rooms(self):
        raw = self._make_result(5)
        enhanced = self._make_result(3)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
        assert winner is raw

    def test_tie_goes_to_raw(self):
        raw = self._make_result(3)
        enhanced = self._make_result(3)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
        assert winner is raw

    def test_zero_rooms_both(self):
        raw = self._make_result(0)
        enhanced = self._make_result(0)
        winner, strategy = pick_winner(raw, enhanced)
        assert strategy == "raw"
