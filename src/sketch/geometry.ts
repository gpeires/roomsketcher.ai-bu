import type { Point, Wall } from './types';

/**
 * Shoelace formula for polygon area.
 * Input: polygon vertices in cm. Output: area in m².
 */
export function shoelaceArea(polygon: Point[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    sum += polygon[i].x * polygon[j].y;
    sum -= polygon[j].x * polygon[i].y;
  }
  const areaCm2 = Math.abs(sum) / 2;
  return areaCm2 / 10000; // cm² → m²
}

/**
 * Geometric centroid of a polygon (average of vertices).
 */
export function centroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  const sum = polygon.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );
  return {
    x: sum.x / polygon.length,
    y: sum.y / polygon.length,
  };
}

/**
 * Bounding box of all wall endpoints.
 */
export function boundingBox(walls: Wall[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  if (walls.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const wall of walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}
