import base64
import logging
import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from cv.pipeline import analyze_image

app = FastAPI(title="Floor Plan CV Service")
log = logging.getLogger(__name__)

class HealthResponse(BaseModel):
    status: str

class AnalyzeRequest(BaseModel):
    image: str | None = Field(default=None, description="Base64-encoded PNG/JPG image")
    image_url: str | None = Field(default=None, description="URL to fetch the image from")
    name: str = Field(default="Extracted Floor Plan")

class RoomOutput(BaseModel):
    label: str
    x: int
    y: int
    width: int
    depth: int

class MetaOutput(BaseModel):
    image_size: tuple[int, int]
    scale_cm_per_px: float
    walls_detected: int
    rooms_detected: int
    text_regions: int

class AnalyzeResponse(BaseModel):
    name: str
    rooms: list[RoomOutput]
    openings: list[dict] = []
    meta: MetaOutput

@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")

@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    if req.image:
        try:
            raw = base64.b64decode(req.image)
        except Exception:
            raise HTTPException(400, "Invalid base64 image data")
    elif req.image_url:
        try:
            resp = httpx.get(req.image_url, follow_redirects=True, timeout=15.0)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Failed to fetch image from URL: {e}")
        content_type = resp.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            raise HTTPException(400, f"URL did not return an image (content-type: {content_type})")
        raw = resp.content
    else:
        raise HTTPException(400, "Provide either 'image' (base64) or 'image_url'")

    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "Could not decode image (not a valid PNG/JPG)")
    try:
        result = analyze_image(image, name=req.name)
    except Exception as e:
        log.exception("CV pipeline failed")
        raise HTTPException(500, f"Analysis failed: {e}")
    return AnalyzeResponse(**result)
