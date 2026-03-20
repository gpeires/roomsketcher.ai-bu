"""Parse dimension strings from floor plans into centimeters."""
import re

_METRIC_M = re.compile(r"^(\d+(?:\.\d+)?)\s*m$", re.IGNORECASE)
_METRIC_BARE = re.compile(r"^(\d+\.\d{2})$")
# Imperial: 10'-8", 10'- 8", 10' 8", 10'8"
_IMPERIAL = re.compile(r"^(\d+)['']\s*-?\s*(\d+)[\"\"]\s*$")
# Imperial feet-only: 10', 21'
_IMPERIAL_FEET = re.compile(r"^(\d+)['']\s*$")
# Imperial with unicode quotes and flexible spacing: 10\u2019- 8\u201d etc.
_IMPERIAL_UNICODE = re.compile(
    r"^(\d+)[\u2018\u2019\u0027\u2032']\s*-?\s*(\d+)[\u201c\u201d\u0022\u2033\"]\s*$"
)
_AREA = re.compile(r"m[²2]|sq\.?\s*(?:ft|m)|SQ\.?\s*(?:FT|M)", re.IGNORECASE)

# Compound dimension: "10'- 8" x 8'- 1"" — two imperial dims joined by x/×
_COMPOUND_SEP = re.compile(r"\s*[x×X]\s*")


def _parse_imperial(feet: int, inches: int) -> int:
    return round(feet * 30.48 + inches * 2.54)


def parse_dimension(text: str) -> int | None:
    """Parse a single dimension string into centimeters.

    Returns the first parseable dimension found. For compound strings
    like ``10'-8" x 8'-1"``, returns the first dimension only.
    Use ``parse_all_dimensions`` to get both.
    """
    text = text.strip()
    if not text:
        return None
    if _AREA.search(text):
        return None

    # Try compound first — split on x/× and parse the first half
    parts = _COMPOUND_SEP.split(text)
    if len(parts) >= 2:
        first = _parse_single(parts[0].strip())
        if first is not None:
            return first

    return _parse_single(text)


def parse_all_dimensions(text: str) -> list[int]:
    """Parse all dimensions from a compound string like ``10'-8" x 8'-1"``."""
    text = text.strip()
    if not text or _AREA.search(text):
        return []
    parts = _COMPOUND_SEP.split(text)
    results = []
    for part in parts:
        val = _parse_single(part.strip())
        if val is not None:
            results.append(val)
    return results


def _parse_single(text: str) -> int | None:
    """Parse a single (non-compound) dimension string into centimeters."""
    if not text:
        return None

    m = _METRIC_M.match(text)
    if m:
        return round(float(m.group(1)) * 100)

    m = _IMPERIAL.match(text)
    if m:
        return _parse_imperial(int(m.group(1)), int(m.group(2)))

    m = _IMPERIAL_UNICODE.match(text)
    if m:
        return _parse_imperial(int(m.group(1)), int(m.group(2)))

    m = _IMPERIAL_FEET.match(text)
    if m:
        return _parse_imperial(int(m.group(1)), 0)

    m = _METRIC_BARE.match(text)
    if m:
        return round(float(m.group(1)) * 100)

    return None
