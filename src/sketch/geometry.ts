import type { Point, Wall, Room } from './types';

/**
 * Euclidean length of a wall segment.
 */
export function wallLength(wall: Wall): number {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  return Math.sqrt(dx * dx + dy * dy);
}

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
 * Compute the 4-corner polygon for a wall based on its centerline and thickness.
 * Returns [startLeft, endLeft, endRight, startRight] offset perpendicular to the wall.
 */
export function wallQuad(wall: Wall): [Point, Point, Point, Point] {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) {
    return [wall.start, wall.start, wall.end, wall.end];
  }
  const nx = -dy / len * (wall.thickness / 2);
  const ny = dx / len * (wall.thickness / 2);
  return [
    { x: wall.start.x + nx, y: wall.start.y + ny },
    { x: wall.end.x + nx, y: wall.end.y + ny },
    { x: wall.end.x - nx, y: wall.end.y - ny },
    { x: wall.start.x - nx, y: wall.start.y - ny },
  ];
}

/**
 * Bounding box of all wall endpoints, expanded by wall thickness.
 */
export function boundingBox(walls: Wall[], envelope?: Point[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  if (walls.length === 0 && !envelope) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const wall of walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  // Also include envelope points if provided
  if (envelope) {
    for (const p of envelope) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  // Expand by max exterior wall thickness to account for wall quads extending beyond centerline
  const exteriorThicknesses = walls.filter(w => w.type === 'exterior').map(w => w.thickness);
  const maxThickness = exteriorThicknesses.length > 0 ? Math.max(...exteriorThicknesses) : 0;
  const expand = envelope ? 0 : maxThickness / 2; // Envelope already includes wall thickness
  return { minX: minX - expand, minY: minY - expand, maxX: maxX + expand, maxY: maxY + expand };
}

/**
 * Sum of all room areas (m²). Handles rooms with missing area gracefully.
 */
export function totalArea(rooms: Room[]): number {
  return rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if point is inside the polygon (edge behavior is undefined).
 */
// ─── Envelope geometry functions ────────────────────────────────────────────

export function polygonBoundingBox(polygon: Point[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export interface GridResult {
  grid: boolean[][];
  originX: number;
  originY: number;
  cols: number;
  rows: number;
}

/**
 * Rasterize axis-aligned polygons onto a boolean grid.
 * Each cell is true if the cell center is inside any polygon.
 */
export function rasterizeToGrid(polygons: Point[][], gridSize: number): GridResult {
  // Find global bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const originX = Math.floor(minX / gridSize) * gridSize;
  const originY = Math.floor(minY / gridSize) * gridSize;
  const cols = Math.ceil((maxX - originX) / gridSize);
  const rows = Math.ceil((maxY - originY) / gridSize);

  const grid: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false)
  );

  // For each cell, test if its center is inside any polygon
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = originX + c * gridSize + gridSize / 2;
      const cy = originY + r * gridSize + gridSize / 2;
      for (const poly of polygons) {
        if (pointInPolygon({ x: cx, y: cy }, poly)) {
          grid[r][c] = true;
          break;
        }
      }
    }
  }

  return { grid, originX, originY, cols, rows };
}

/**
 * Trace the outer boundary of filled cells in a boolean grid.
 * Returns an axis-aligned polygon (vertices in order).
 * Uses a boundary-following algorithm on the grid edges.
 */
export function traceContour(
  grid: boolean[][], gridSize: number, originX: number, originY: number,
): Point[] {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  if (rows === 0 || cols === 0) return [];

  // Helper: is cell (r,c) filled?
  const filled = (r: number, c: number) =>
    r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c];

  // Collect all boundary edges between filled and unfilled cells.
  // Each edge is a segment between two grid-corner points.
  // Grid corners are at (originX + c*gridSize, originY + r*gridSize).
  type BEdge = { x1: number; y1: number; x2: number; y2: number };
  const edges: BEdge[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue;
      const x = originX + c * gridSize;
      const y = originY + r * gridSize;
      const s = gridSize;
      // Top edge: if cell above is not filled
      if (!filled(r - 1, c)) edges.push({ x1: x, y1: y, x2: x + s, y2: y });
      // Bottom edge
      if (!filled(r + 1, c)) edges.push({ x1: x + s, y1: y + s, x2: x, y2: y + s });
      // Left edge
      if (!filled(r, c - 1)) edges.push({ x1: x, y1: y + s, x2: x, y2: y });
      // Right edge
      if (!filled(r, c + 1)) edges.push({ x1: x + s, y1: y, x2: x + s, y2: y + s });
    }
  }

  if (edges.length === 0) return [];

  // Chain edges into a polygon: each edge's end point matches the next edge's start point
  const edgeMap = new Map<string, BEdge[]>();
  for (const e of edges) {
    const key = `${e.x1},${e.y1}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key)!.push(e);
  }

  const used = new Set<number>();
  const polygon: Point[] = [];
  let current = edges[0];
  used.add(0);
  polygon.push({ x: current.x1, y: current.y1 });

  for (let i = 0; i < edges.length - 1; i++) {
    const nextKey = `${current.x2},${current.y2}`;
    const candidates = edgeMap.get(nextKey);
    if (!candidates) break;
    const next = candidates.find((candidate) => {
      const globalIdx = edges.indexOf(candidate);
      return !used.has(globalIdx);
    });
    if (!next) break;
    used.add(edges.indexOf(next));
    // Only add point if direction changes (avoid collinear points)
    const prev = polygon[polygon.length - 1];
    const mid = { x: current.x2, y: current.y2 };
    const nxt = { x: next.x2, y: next.y2 };
    const sameLine = (prev.x === mid.x && mid.x === nxt.x) ||
                     (prev.y === mid.y && mid.y === nxt.y);
    if (!sameLine) {
      polygon.push(mid);
    }
    current = next;
  }

  return polygon;
}

/**
 * Offset an axis-aligned polygon outward by `distance`.
 * Each edge shifts outward along its normal. At convex corners edges meet naturally.
 * At concave corners (inward notch), an extra vertex is inserted.
 * Polygon must be wound counter-clockwise (standard SVG winding).
 */
export function offsetAxisAlignedPolygon(polygon: Point[], distance: number): Point[] {
  const n = polygon.length;
  if (n < 3) return [...polygon];

  // Compute outward normal for each edge
  // Formula (dy/len, -dx/len) = 90° CW rotation — correct for CW winding in screen coords (Y down)
  const normals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) { normals.push({ x: 0, y: 0 }); continue; }
    normals.push({ x: dy / len, y: -dx / len });
  }

  // Offset each edge and find intersections at corners
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prevIdx = (i - 1 + n) % n;
    const prevNormal = normals[prevIdx];
    const currNormal = normals[i];

    const p = polygon[i];

    // For axis-aligned polygons, normals are either (0,1), (0,-1), (1,0), (-1,0)
    // Cross product determines convex vs concave
    const cross = prevNormal.x * currNormal.y - prevNormal.y * currNormal.x;

    if (Math.abs(cross) < 0.001) {
      // Collinear edges — just offset
      result.push({ x: p.x + currNormal.x * distance, y: p.y + currNormal.y * distance });
    } else if (cross > 0) {
      // Convex corner — single offset point at intersection
      result.push({
        x: p.x + (prevNormal.x + currNormal.x) * distance,
        y: p.y + (prevNormal.y + currNormal.y) * distance,
      });
    } else {
      // Concave corner — insert two points (one per edge) to avoid self-intersection
      result.push({
        x: p.x + prevNormal.x * distance,
        y: p.y + prevNormal.y * distance,
      });
      result.push({
        x: p.x + currNormal.x * distance,
        y: p.y + currNormal.y * distance,
      });
    }
  }

  return result;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
