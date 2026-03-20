from cv.dimensions import parse_dimension

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

def test_parse_area_sqm():
    assert parse_dimension("8.6 m²") is None

def test_parse_garbage():
    assert parse_dimension("Kitchen") is None
    assert parse_dimension("") is None
