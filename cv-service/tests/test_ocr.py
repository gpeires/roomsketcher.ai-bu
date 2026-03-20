from cv.ocr import extract_text_regions

def test_extract_finds_room_labels(simple_2room_image):
    regions = extract_text_regions(simple_2room_image)
    texts = [r["text"].lower() for r in regions]
    assert any("kitchen" in t for t in texts), f"Should find 'Kitchen', got {texts}"
    assert any("living" in t for t in texts), f"Should find 'Living', got {texts}"

def test_extract_finds_dimensions(simple_2room_image):
    regions = extract_text_regions(simple_2room_image)
    texts = [r["text"] for r in regions]
    assert any("3.00" in t or "3.0" in t for t in texts), f"Should find dimension, got {texts}"
