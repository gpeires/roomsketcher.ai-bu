import pytest
from cv.dimensions import parse_dimension, parse_all_dimensions

def test_parse_metric_meters():
    assert parse_dimension("3.30m") == 330
    assert parse_dimension("1.60m") == 160
    assert parse_dimension("0.50m") == 50

def test_parse_metric_no_unit():
    assert parse_dimension("3.30") == 330

def test_parse_imperial_feet_inches():
    assert parse_dimension("10'-8\"") == 325
    assert parse_dimension("8'-1\"") == 246

def test_parse_imperial_dash_format():
    assert parse_dimension("10'- 8\"") == 325

def test_parse_imperial_space_format():
    """Tesseract sometimes outputs feet and inches with just a space."""
    assert parse_dimension("10' 8\"") == 325

def test_parse_imperial_feet_only():
    assert parse_dimension("10'") == 305
    assert parse_dimension("21'") == 640

def test_parse_compound_imperial():
    """Compound dimension strings like room size labels."""
    # parse_dimension returns the first dimension
    assert parse_dimension("10'-8\" x 8'-1\"") == 325
    # parse_all_dimensions returns both
    dims = parse_all_dimensions("10'-8\" x 8'-1\"")
    assert len(dims) == 2
    assert dims[0] == 325
    assert dims[1] == 246

def test_parse_compound_metric():
    dims = parse_all_dimensions("3.30m x 2.50m")
    assert dims == [330, 250]

def test_parse_area_sqm():
    assert parse_dimension("8.6 m²") is None
    assert parse_dimension("779 SQ.FT.") is None

def test_parse_garbage():
    assert parse_dimension("Kitchen") is None
    assert parse_dimension("") is None

def test_parse_all_dimensions_empty():
    assert parse_all_dimensions("") == []
    assert parse_all_dimensions("Kitchen") == []
    assert parse_all_dimensions("8.6 m²") == []


class TestOCRGarbledDimensions:
    """Dimensions as OCR commonly garbles them."""

    @pytest.mark.parametrize("text,expected_cm", [
        ("10'- 6\"", 320),     # space after dash
        ("10' - 6\"", 320),    # spaces around dash
        ("10'  6\"", 320),     # double space, no dash
        ("8'- 10\"", 269),     # space after dash
        ("21'- 1\"", 643),     # space after dash
        ("10' -8\"", 325),     # space before dash
        ("10'-  8\"", 325),    # double space after dash
        ("7' 6\"", 229),       # space, no dash
    ])
    def test_parses_spaced_imperial(self, text, expected_cm):
        result = parse_dimension(text)
        assert result is not None, f"Failed to parse: {text!r}"
        assert abs(result - expected_cm) < 5, f"{text!r}: got {result}, expected ~{expected_cm}"
