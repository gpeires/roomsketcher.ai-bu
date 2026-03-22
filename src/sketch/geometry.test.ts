import { describe, it, expect } from 'vitest';
import { shoelaceArea, centroid, boundingBox, pointInPolygon, wallQuad } from './geometry';
import type { Point, Wall } from './types';

describe('shoelaceArea', () => {
  it('calculates area of a 3x4 rectangle (in cm², converted to m²)', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 400 },
      { x: 0, y: 400 },
    ];
    // 300cm × 400cm = 120000 cm² = 12 m²
    expect(shoelaceArea(polygon)).toBeCloseTo(12, 2);
  });

  it('calculates area of a triangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 200, y: 300 },
    ];
    // Triangle: base=400cm, height=300cm → 60000cm² = 6m²
    expect(shoelaceArea(polygon)).toBeCloseTo(6, 2);
  });

  it('returns 0 for degenerate polygon', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(shoelaceArea(polygon)).toBe(0);
  });
});

describe('centroid', () => {
  it('calculates centroid of a rectangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 400 },
      { x: 0, y: 400 },
    ];
    const c = centroid(polygon);
    expect(c.x).toBeCloseTo(300);
    expect(c.y).toBeCloseTo(200);
  });

  it('calculates centroid of a triangle', () => {
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 0, y: 300 },
    ];
    const c = centroid(polygon);
    expect(c.x).toBeCloseTo(100);
    expect(c.y).toBeCloseTo(100);
  });
});

describe('boundingBox', () => {
  it('calculates bounding box of walls', () => {
    const walls: Wall[] = [
      { id: 'w1', start: { x: 100, y: 50 }, end: { x: 500, y: 50 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w2', start: { x: 500, y: 50 }, end: { x: 500, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ];
    const bb = boundingBox(walls);
    // Expanded by max thickness/2 = 10
    expect(bb).toEqual({ minX: 90, minY: 40, maxX: 510, maxY: 410 });
  });

  it('returns zero box for empty walls', () => {
    const bb = boundingBox([]);
    expect(bb).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('wallQuad', () => {
  it('computes quad for horizontal wall', () => {
    const wall: Wall = { id: 'w', start: { x: 0, y: 100 }, end: { x: 400, y: 100 }, thickness: 20, height: 250, type: 'exterior', openings: [] };
    const quad = wallQuad(wall);
    // Horizontal wall: perpendicular offset is vertical (±10)
    expect(quad[0]).toEqual({ x: 0, y: 110 });
    expect(quad[1]).toEqual({ x: 400, y: 110 });
    expect(quad[2]).toEqual({ x: 400, y: 90 });
    expect(quad[3]).toEqual({ x: 0, y: 90 });
  });

  it('computes quad for vertical wall', () => {
    const wall: Wall = { id: 'w', start: { x: 200, y: 0 }, end: { x: 200, y: 300 }, thickness: 10, height: 250, type: 'interior', openings: [] };
    const quad = wallQuad(wall);
    // Vertical wall: perpendicular offset is horizontal (±5)
    expect(quad[0]).toEqual({ x: 195, y: 0 });
    expect(quad[1]).toEqual({ x: 195, y: 300 });
    expect(quad[2]).toEqual({ x: 205, y: 300 });
    expect(quad[3]).toEqual({ x: 205, y: 0 });
  });

  it('handles zero-length wall', () => {
    const wall: Wall = { id: 'w', start: { x: 50, y: 50 }, end: { x: 50, y: 50 }, thickness: 20, height: 250, type: 'exterior', openings: [] };
    const quad = wallQuad(wall);
    // All points collapse to the same location
    expect(quad[0]).toEqual({ x: 50, y: 50 });
  });
});

describe('pointInPolygon', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ]

  it('returns true for point inside polygon', () => {
    expect(pointInPolygon({ x: 200, y: 200 }, square)).toBe(true)
  })

  it('returns false for point outside polygon', () => {
    expect(pointInPolygon({ x: 500, y: 500 }, square)).toBe(false)
  })

  it('returns true for point just inside top edge', () => {
    expect(pointInPolygon({ x: 200, y: 1 }, square)).toBe(true)
  })

  it('works with triangle', () => {
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 150, y: 300 },
    ]
    expect(pointInPolygon({ x: 150, y: 100 }, tri)).toBe(true)
    expect(pointInPolygon({ x: 0, y: 300 }, tri)).toBe(false)
  })
})
