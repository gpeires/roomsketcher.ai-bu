import base64
import numpy as np
import pytest
from cv.pipeline import run_single_strategy, sweep_strategies
from cv.strategies import STRATEGIES, _raw


class TestRunSingleStrategy:
    def test_returns_expected_fields(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        assert result["strategy"] == "raw"
        assert "debug_binary" in result
        assert "time_ms" in result
        assert isinstance(result["time_ms"], int)
        assert result["time_ms"] >= 0
        assert "rooms" in result
        assert "meta" in result

    def test_debug_binary_is_valid_png(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        png_bytes = base64.b64decode(result["debug_binary"])
        # PNG magic bytes
        assert png_bytes[:4] == b"\x89PNG"

    def test_detects_rooms(self, simple_2room_image):
        result = run_single_strategy(simple_2room_image, "Test", "raw", _raw)
        assert result["meta"]["rooms_detected"] >= 1


class TestSweepStrategies:
    def test_returns_all_strategies(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        assert "image_size" in result
        assert "strategies" in result
        assert len(result["strategies"]) == 27

    def test_each_strategy_has_required_fields(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        for s in result["strategies"]:
            assert "strategy" in s
            assert "rooms" in s or "error" in s
            assert "time_ms" in s

    def test_strategy_names_match_registry(self, simple_2room_image):
        result = sweep_strategies(simple_2room_image, "Test")
        names = {s["strategy"] for s in result["strategies"]}
        assert names == set(STRATEGIES.keys())

    def test_image_size_correct(self, simple_2room_image):
        h, w = simple_2room_image.shape[:2]
        result = sweep_strategies(simple_2room_image, "Test")
        assert result["image_size"] == (w, h)

    def test_failed_strategy_returns_error_entry(self, simple_2room_image, monkeypatch):
        """When a strategy raises, its entry has error set and sensible defaults."""
        from cv import strategies as strat_mod
        original = dict(strat_mod.STRATEGIES)

        def _boom(image):
            raise RuntimeError("test explosion")

        monkeypatch.setattr(strat_mod, "STRATEGIES", {**original, "raw": _boom})
        result = sweep_strategies(simple_2room_image, "Test")
        raw_entry = next(s for s in result["strategies"] if s["strategy"] == "raw")
        assert raw_entry["error"] is not None
        assert "test explosion" in raw_entry["error"]
        assert raw_entry["meta"]["rooms_detected"] == 0
        assert raw_entry["meta"]["walls_detected"] == 0
        assert raw_entry["debug_binary"] == ""
        assert raw_entry["rooms"] == []
