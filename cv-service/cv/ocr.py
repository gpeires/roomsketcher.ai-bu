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
    return merge_nearby_text(regions)


def merge_nearby_text(
    regions: list[dict],
    max_gap_ratio: float = 1.5,
) -> list[dict]:
    """Merge text regions that are on the same line and close together.

    Tesseract PSM 11 often splits dimension strings like ``10' - 8"`` into
    separate regions (``10'``, ``-``, ``8"``).  This reassembles them by
    merging horizontally-adjacent regions whose vertical centers are within
    half the text height and whose horizontal gap is less than
    ``max_gap_ratio * avg_height``.
    """
    if len(regions) < 2:
        return regions

    # Sort by vertical center, then horizontal position
    sorted_regions = sorted(regions, key=lambda r: (r["center"][1], r["bbox"][0]))

    merged: list[dict] = []
    used = set()

    for i, r in enumerate(sorted_regions):
        if i in used:
            continue
        # Start a new merged group
        group = [r]
        used.add(i)
        _, ry, _, rh = r["bbox"]
        r_cy = r["center"][1]

        for j in range(i + 1, len(sorted_regions)):
            if j in used:
                continue
            s = sorted_regions[j]
            _, sy, _, sh = s["bbox"]
            s_cy = s["center"][1]

            avg_h = max((rh + sh) / 2, 1)

            # Must be on the same line (vertical centers within half avg height)
            if abs(r_cy - s_cy) > avg_h * 0.6:
                # Past this line — stop scanning
                if s_cy - r_cy > avg_h:
                    break
                continue

            # Check horizontal gap
            last = group[-1]
            last_right = last["bbox"][0] + last["bbox"][2]
            gap = s["bbox"][0] - last_right
            if gap < 0 or gap > max_gap_ratio * avg_h:
                continue

            group.append(s)
            used.add(j)

        if len(group) == 1:
            merged.append(r)
        else:
            # Combine the group into a single region
            all_x = [g["bbox"][0] for g in group]
            all_y = [g["bbox"][1] for g in group]
            all_r = [g["bbox"][0] + g["bbox"][2] for g in group]
            all_b = [g["bbox"][1] + g["bbox"][3] for g in group]
            nx = min(all_x)
            ny = min(all_y)
            nw = max(all_r) - nx
            nh = max(all_b) - ny
            combined_text = " ".join(g["text"] for g in group)
            avg_conf = sum(g["confidence"] for g in group) // len(group)
            merged.append({
                "text": combined_text,
                "bbox": (nx, ny, nw, nh),
                "center": (nx + nw // 2, ny + nh // 2),
                "confidence": avg_conf,
            })

    return merged
