"""OCR extraction of room labels and dimension text from floor plan images."""
import cv2
import numpy as np

try:
    import pytesseract
except ImportError:
    pytesseract = None

def extract_text_regions(image: np.ndarray, min_confidence: int = 40) -> list[dict]:
    if pytesseract is None:
        raise RuntimeError("pytesseract not installed")
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()
    # Scale up 2x to improve OCR accuracy on small text, then threshold to
    # maximise contrast before handing off to Tesseract.
    scaled = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    _, processed = cv2.threshold(scaled, 200, 255, cv2.THRESH_BINARY)
    data = pytesseract.image_to_data(
        processed,
        output_type=pytesseract.Output.DICT,
        config="--psm 11",  # sparse text: find as much text as possible
    )
    regions = []
    n = len(data["text"])
    for i in range(n):
        text = data["text"][i].strip()
        conf = int(data["conf"][i])
        if not text or conf < min_confidence:
            continue
        # Tesseract coords are in 2x-scaled space; convert back to original.
        x = data["left"][i] // 2
        y = data["top"][i] // 2
        w = data["width"][i] // 2
        h = data["height"][i] // 2
        regions.append({
            "text": text,
            "bbox": (x, y, w, h),
            "center": (x + w // 2, y + h // 2),
            "confidence": conf,
        })
    return regions
