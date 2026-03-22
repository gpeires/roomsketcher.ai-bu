import base64
import cv2
import numpy as np
import pytest
from httpx import AsyncClient, ASGITransport
from app import app

@pytest.fixture
def b64_simple_image(simple_2room_image) -> str:
    _, buf = cv2.imencode(".png", simple_2room_image)
    return base64.b64encode(buf.tobytes()).decode()

@pytest.mark.anyio
async def test_analyze_endpoint(b64_simple_image):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/analyze", json={
            "image": b64_simple_image,
            "name": "Test Plan",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert "rooms" in data
    assert len(data["rooms"]) >= 1
    assert "meta" in data

@pytest.mark.anyio
async def test_analyze_rejects_invalid_image():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/analyze", json={
            "image": "not-valid-base64!@#$",
        })
    assert resp.status_code == 422 or resp.status_code == 400


@pytest.mark.anyio
async def test_sweep_endpoint(b64_simple_image):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/sweep", json={
            "image": b64_simple_image,
            "name": "Sweep Test",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert "image_size" in data
    assert "strategies" in data
    assert len(data["strategies"]) == 28
    # Each strategy has required fields
    for s in data["strategies"]:
        assert "strategy" in s
        assert "time_ms" in s
        assert "meta" in s


def test_analyze_response_includes_wall_thickness():
    """Verify wall_thickness appears in API response meta."""
    from app import MetaOutput
    meta_data = {
        "image_size": (100, 100),
        "scale_cm_per_px": 1.0,
        "walls_detected": 4,
        "rooms_detected": 2,
        "text_regions": 0,
        "wall_thickness": {
            "thin_cm": 10.0,
            "thick_cm": 20.0,
            "structural_elements": [],
        },
    }
    meta = MetaOutput(**meta_data)
    assert meta.wall_thickness is not None
    assert meta.wall_thickness.thin_cm == 10.0


@pytest.mark.anyio
async def test_sweep_rejects_missing_image():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/sweep", json={"name": "No Image"})
    assert resp.status_code == 400
