import cv2
import numpy as np
import pytest
from pathlib import Path

FIXTURES = Path(__file__).parent.parent / "fixtures"

@pytest.fixture
def simple_2room_image() -> np.ndarray:
    """Generate a synthetic 2-room floor plan: Kitchen (left) + Living (right).
    Layout (600x400 image):
    - Outer walls: 20px thick black lines
    - Interior wall: 10px thick at x=300
    - Door gap: 80px opening in interior wall centered vertically
    - Room labels: "Kitchen" at (150, 200), "Living" at (450, 200)
    - Dimensions: "3.00m" below Kitchen, "3.00m" below Living, "4.00m" on left side
    """
    img = np.ones((400, 600, 3), dtype=np.uint8) * 255
    cv2.rectangle(img, (0, 0), (599, 399), (0, 0, 0), 20)
    cv2.line(img, (300, 10), (300, 160), (0, 0, 0), 10)
    cv2.line(img, (300, 240), (300, 390), (0, 0, 0), 10)
    cv2.putText(img, "Kitchen", (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 80), 2)
    cv2.putText(img, "Living", (370, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 80), 2)
    cv2.putText(img, "3.00m", (120, 385), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "3.00m", (400, 385), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "4.00m", (5, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    return img

@pytest.fixture
def simple_2room_path(simple_2room_image: np.ndarray, tmp_path: Path) -> Path:
    path = tmp_path / "simple-2room.png"
    cv2.imwrite(str(path), simple_2room_image)
    return path
