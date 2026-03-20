"""Parse dimension strings from floor plans into centimeters."""
import re

_METRIC_M = re.compile(r"^(\d+(?:\.\d+)?)\s*m$", re.IGNORECASE)
_METRIC_BARE = re.compile(r"^(\d+\.\d{2})$")
_IMPERIAL = re.compile(r"^(\d+)['']\s*-?\s*(\d+)[\"\"]\s*$")
_AREA = re.compile(r"m[²2]|sq\.?\s*(?:ft|m)", re.IGNORECASE)

def parse_dimension(text: str) -> int | None:
    text = text.strip()
    if not text:
        return None
    if _AREA.search(text):
        return None
    m = _METRIC_M.match(text)
    if m:
        return round(float(m.group(1)) * 100)
    m = _IMPERIAL.match(text)
    if m:
        feet = int(m.group(1))
        inches = int(m.group(2))
        return round(feet * 30.48 + inches * 2.54)
    m = _METRIC_BARE.match(text)
    if m:
        return round(float(m.group(1)) * 100)
    return None
