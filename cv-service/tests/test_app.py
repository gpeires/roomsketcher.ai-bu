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
