import type { FloorPlan, Wall, Opening, Room, Point } from './types';
import { shoelaceArea, centroid, boundingBox, wallLength, wallQuad } from './geometry';
import { furnitureSymbol, escXml } from './furniture-symbols';

function wallAngle(wall: Wall): number {
  return Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
}

function formatDimension(cm: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    const inches = cm / 2.54;
    const feet = Math.floor(inches / 12);
    const rem = Math.round(inches % 12);
    return `${feet}'${rem}"`;
  }
  return `${(cm / 100).toFixed(2)}m`;
}

function renderWalls(walls: Wall[]): string {
  return walls.map(w => {
    if (w.type === 'divider') {
      return `<line x1="${w.start.x}" y1="${w.start.y}" x2="${w.end.x}" y2="${w.end.y}" ` +
        `stroke="#333" stroke-width="1" stroke-linecap="round" stroke-dasharray="6,4"` +
        ` data-id="${w.id}" data-type="wall"/>`;
    }
    if (w.type === 'exterior') {
      // Exterior walls rendered as thick filled polygons
      const quad = wallQuad(w);
      const points = quad.map(p => `${p.x},${p.y}`).join(' ');
      return `<polygon points="${points}" fill="#333" stroke="#333" stroke-width="0.5" stroke-linejoin="round"` +
        ` data-id="${w.id}" data-type="wall"/>`;
    }
    // Interior walls rendered as thin lines
    return `<line x1="${w.start.x}" y1="${w.start.y}" x2="${w.end.x}" y2="${w.end.y}" ` +
      `stroke="#333" stroke-width="2" stroke-linecap="round"` +
      ` data-id="${w.id}" data-type="wall"/>`;
  }).join('\n    ');
}

function renderJunctions(walls: Wall[]): string {
  // At shared exterior wall endpoints, render filled circles to close corner gaps
  const exteriorWalls = walls.filter(w => w.type === 'exterior');
  const junctions = new Map<string, { x: number; y: number; maxThickness: number }>();
  const counts = new Map<string, number>();
  for (const w of exteriorWalls) {
    for (const p of [w.start, w.end]) {
      const key = `${p.x},${p.y}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      const existing = junctions.get(key);
      if (existing) {
        existing.maxThickness = Math.max(existing.maxThickness, w.thickness);
      } else {
        junctions.set(key, { x: p.x, y: p.y, maxThickness: w.thickness });
      }
    }
  }
  const parts: string[] = [];
  for (const [key, info] of junctions) {
    if ((counts.get(key) || 0) >= 2) {
      const r = info.maxThickness / 2;
      parts.push(`<circle cx="${info.x}" cy="${info.y}" r="${r}" fill="#333"/>`);
    }
  }
  return parts.join('\n    ');
}

function renderOpening(wall: Wall, opening: Opening): string {
  const angle = wallAngle(wall);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Position along wall
  const ox = wall.start.x + cos * opening.offset;
  const oy = wall.start.y + sin * opening.offset;

  // Gap width: thick for exterior walls (cut through polygon), thin for interior (cover line)
  const gapWidth = wall.type === 'exterior' ? wall.thickness + 2 : 6;

  if (opening.type === 'door') {
    // Draw gap (white line over wall) + swing arc
    const ex = ox + cos * opening.width;
    const ey = oy + sin * opening.width;
    const gap = `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="${gapWidth}" data-id="${opening.id}" data-type="opening"/>`;

    // Arc for door swing
    const r = opening.width;
    const dir = opening.properties.swingDirection === 'right' ? 1 : -1;
    const perpX = -sin * dir * r;
    const perpY = cos * dir * r;
    const arcEnd = { x: ox + perpX, y: oy + perpY };
    const sweep = dir === 1 ? 1 : 0;
    const arc = `<path d="M${ox},${oy} L${ex},${ey} A${r},${r} 0 0,${sweep} ${arcEnd.x},${arcEnd.y} Z" ` +
      `fill="none" stroke="#666" stroke-width="1" data-id="${opening.id}" data-type="opening"/>`;
    return gap + '\n    ' + arc;
  }

  if (opening.type === 'window') {
    // Draw gap + parallel lines at wall faces
    const ex = ox + cos * opening.width;
    const ey = oy + sin * opening.width;
    const offset = wall.type === 'exterior' ? wall.thickness / 2 : 2;
    const nx = -sin * offset;
    const ny = cos * offset;
    const oAttrs = ` data-id="${opening.id}" data-type="opening"`;
    const gap = `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="${gapWidth}"${oAttrs}/>`;
    const line1 = `<line x1="${ox + nx}" y1="${oy + ny}" x2="${ex + nx}" y2="${ey + ny}" stroke="#4FC3F7" stroke-width="2"${oAttrs}/>`;
    const line2 = `<line x1="${ox - nx}" y1="${oy - ny}" x2="${ex - nx}" y2="${ey - ny}" stroke="#4FC3F7" stroke-width="2"${oAttrs}/>`;
    return [gap, line1, line2].join('\n    ');
  }

  // Plain opening: just a gap
  const ex = ox + cos * opening.width;
  const ey = oy + sin * opening.width;
  return `<line x1="${ox}" y1="${oy}" x2="${ex}" y2="${ey}" stroke="white" stroke-width="${gapWidth}" data-id="${opening.id}" data-type="opening"/>`;
}

function renderOpenings(walls: Wall[]): string {
  const parts: string[] = [];
  for (const wall of walls) {
    for (const opening of wall.openings) {
      parts.push(renderOpening(wall, opening));
    }
  }
  return parts.join('\n    ');
}

function renderRooms(rooms: Room[], units: 'metric' | 'imperial'): string {
  return rooms.map(room => {
    const points = room.polygon.map(p => `${p.x},${p.y}`).join(' ');
    const area = room.area ?? shoelaceArea(room.polygon);
    const areaLabel = units === 'imperial'
      ? `${(area * 10.7639).toFixed(1)} ft²`
      : `${area.toFixed(1)} m²`;
    const c = centroid(room.polygon);

    const poly = `<polygon points="${points}" fill="${room.color}" fill-opacity="0.5" stroke="none" data-id="${room.id}" data-type="room"/>`;
    const label = `<text x="${c.x}" y="${c.y - 8}" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">${escXml(room.label)}</text>`;
    const areaText = `<text x="${c.x}" y="${c.y + 10}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">${areaLabel}</text>`;
    return [poly, label, areaText].join('\n    ');
  }).join('\n    ');
}

function renderDimensions(walls: Wall[], units: 'metric' | 'imperial'): string {
  return walls.map(w => {
    const len = wallLength(w);
    if (len < 1) return '';
    const label = formatDimension(len, units);
    const mx = (w.start.x + w.end.x) / 2;
    const my = (w.start.y + w.end.y) / 2;
    let angle = wallAngle(w) * (180 / Math.PI);
    // Normalize so text is always readable (never upside down)
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    // Offset label perpendicular to wall (always toward outside/top-left)
    const offsetPx = 14;
    const perpAngle = wallAngle(w) + Math.PI / 2;
    const lx = mx + Math.cos(perpAngle) * offsetPx;
    const ly = my + Math.sin(perpAngle) * offsetPx;

    return `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#999" ` +
      `transform="rotate(${angle}, ${lx}, ${ly})">${label}</text>`;
  }).filter(Boolean).join('\n    ');
}

function renderFurniture(furniture: FloorPlan['furniture']): string {
  return furniture.map(item => {
    const cx = item.position.x + item.width / 2;
    const cy = item.position.y + item.depth / 2;
    const transform = item.rotation
      ? ` transform="rotate(${item.rotation}, ${cx}, ${cy})"`
      : '';
    const inner = furnitureSymbol(item.type, item.width, item.depth);
    return `<g${transform} data-id="${item.id}" data-type="furniture">` +
      `<g transform="translate(${item.position.x}, ${item.position.y})">${inner}</g>` +
      `</g>`;
  }).join('\n    ');
}

function renderWatermark(maxX: number, maxY: number): string {
  return `<text x="${maxX}" y="${maxY + 30}" text-anchor="end" font-size="10" font-family="sans-serif" fill="#ccc">Powered by RoomSketcher</text>`;
}

export function floorPlanToSvg(plan: FloorPlan): string {
  const bb = boundingBox(plan.walls);

  // Expand bounding box to include door swing arcs
  for (const wall of plan.walls) {
    const angle = wallAngle(wall)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (const opening of wall.openings) {
      if (opening.type !== 'door') continue
      const ox = wall.start.x + cos * opening.offset
      const oy = wall.start.y + sin * opening.offset
      const ex = ox + cos * opening.width
      const ey = oy + sin * opening.width
      const r = opening.width
      const dir = opening.properties.swingDirection === 'right' ? 1 : -1
      const perpX = -sin * dir * r
      const perpY = cos * dir * r
      const arcEnd = { x: ox + perpX, y: oy + perpY }
      // Include door endpoints and arc endpoint
      for (const p of [
        { x: ox, y: oy },
        { x: ex, y: ey },
        arcEnd,
      ]) {
        if (p.x < bb.minX) bb.minX = p.x
        if (p.y < bb.minY) bb.minY = p.y
        if (p.x > bb.maxX) bb.maxX = p.x
        if (p.y > bb.maxY) bb.maxY = p.y
      }
    }
  }

  // Expand bounding box to include furniture
  for (const item of plan.furniture) {
    const x1 = item.position.x;
    const y1 = item.position.y;
    const x2 = x1 + item.width;
    const y2 = y1 + item.depth;
    if (x1 < bb.minX) bb.minX = x1;
    if (y1 < bb.minY) bb.minY = y1;
    if (x2 > bb.maxX) bb.maxX = x2;
    if (y2 > bb.maxY) bb.maxY = y2;
  }

  const pad = 50;
  const vbX = bb.minX - pad;
  const vbY = bb.minY - pad;
  const vbW = (bb.maxX - bb.minX) + pad * 2;
  const vbH = (bb.maxY - bb.minY) + pad * 2;

  // For empty plans, use canvas dimensions
  const hasWalls = plan.walls.length > 0;
  const viewBox = hasWalls
    ? `${vbX} ${vbY} ${vbW} ${vbH}`
    : `0 0 ${plan.canvas.width} ${plan.canvas.height}`;

  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" style="background:#fff">
  <g id="rooms">
    ${renderRooms(plan.rooms, plan.units)}
  </g>
  <g id="walls">
    ${renderWalls(plan.walls)}
    ${renderJunctions(plan.walls)}
  </g>
  <g id="openings">
    ${renderOpenings(plan.walls)}
  </g>
  <g id="furniture">
    ${renderFurniture(plan.furniture)}
  </g>
  <g id="dimensions">
    ${renderDimensions(plan.walls, plan.units)}
  </g>
  <g id="labels"></g>
  <g id="watermark">
    ${renderWatermark(vbX + vbW, vbY + vbH)}
  </g>
</svg>`;
}
