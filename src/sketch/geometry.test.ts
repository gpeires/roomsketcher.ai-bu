import { describe, it, expect } from 'vitest';
import { shoelaceArea, centroid, boundingBox } from './geometry';
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
    expect(bb).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 400 });
  });

  it('returns zero box for empty walls', () => {
    const bb = boundingBox([]);
    expect(bb).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});
