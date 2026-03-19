/**
 * Architectural top-down furniture symbol SVG generator.
 *
 * Each function returns raw SVG elements (no wrapping <g>) sized to the
 * given w x h dimensions using proportional coordinates so symbols work
 * at any scale.
 */

const S = 'stroke="#555" fill="none" vector-effect="non-scaling-stroke"'
const SF = (fill: string) =>
  `stroke="#555" fill="${fill}" vector-effect="non-scaling-stroke"`
const NS = 'vector-effect="non-scaling-stroke"'

export const SYMBOL_TYPES: string[] = [
  'bed-double',
  'bed-single',
  'nightstand',
  'wardrobe',
  'dresser',
  'sofa-3seat',
  'coffee-table',
  'tv-unit',
  'armchair',
  'bookshelf',
  'kitchen-counter',
  'kitchen-sink',
  'fridge',
  'stove',
  'dining-table',
  'dining-chair',
  'toilet',
  'bath-sink',
  'bathtub',
  'shower',
  'desk',
  'office-chair',
  'sideboard',
  'shoe-rack',
  'coat-hook',
]

export function furnitureSymbol(type: string, w: number, h: number): string {
  switch (type) {
    case 'bed-double':
      return bedDouble(w, h)
    case 'bed-single':
      return bedSingle(w, h)
    case 'nightstand':
      return nightstand(w, h)
    case 'wardrobe':
      return wardrobe(w, h)
    case 'dresser':
      return dresser(w, h)
    case 'sofa-3seat':
      return sofa3seat(w, h)
    case 'coffee-table':
      return coffeeTable(w, h)
    case 'tv-unit':
      return tvUnit(w, h)
    case 'armchair':
      return armchair(w, h)
    case 'bookshelf':
      return bookshelf(w, h)
    case 'kitchen-counter':
      return kitchenCounter(w, h)
    case 'kitchen-sink':
      return kitchenSink(w, h)
    case 'fridge':
      return fridge(w, h)
    case 'stove':
      return stove(w, h)
    case 'dining-table':
      return diningTable(w, h)
    case 'dining-chair':
      return diningChair(w, h)
    case 'toilet':
      return toilet(w, h)
    case 'bath-sink':
      return bathSink(w, h)
    case 'bathtub':
      return bathtub(w, h)
    case 'shower':
      return shower(w, h)
    case 'desk':
      return desk(w, h)
    case 'office-chair':
      return officeChair(w, h)
    case 'sideboard':
      return sideboard(w, h)
    case 'shoe-rack':
      return shoeRack(w, h)
    case 'coat-hook':
      return coatHook(w, h)
    default:
      return fallbackRect(w, h, type)
  }
}

// ── Bedroom ──────────────────────────────────────────────

function bedDouble(w: number, h: number): string {
  const pw = w * 0.45
  const ph = h * 0.08
  const py = h * 0.1
  const prx = h * 0.04
  const gap = w * 0.1
  const px1 = gap / 2
  const px2 = w - gap / 2 - pw
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="0" y="0" width="${w}" height="${h * 0.07}" ${SF('#ddd')}/>`,
    `<rect x="${px1}" y="${py}" width="${pw}" height="${ph}" rx="${prx}" ${SF('#F5F5F5')}/>`,
    `<rect x="${px2}" y="${py}" width="${pw}" height="${ph}" rx="${prx}" ${SF('#F5F5F5')}/>`,
  ].join('')
}

function bedSingle(w: number, h: number): string {
  const pw = w * 0.73
  const ph = h * 0.08
  const py = h * 0.1
  const prx = h * 0.04
  const px = (w - pw) / 2
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="0" y="0" width="${w}" height="${h * 0.07}" ${SF('#ddd')}/>`,
    `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="${prx}" ${SF('#F5F5F5')}/>`,
  ].join('')
}

function nightstand(w: number, h: number): string {
  const cy = h * 0.5
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="0" y1="${cy}" x2="${w}" y2="${cy}" ${S}/>`,
    `<circle cx="${w / 2}" cy="${h * 0.75}" r="${Math.min(w, h) * 0.06}" ${SF('#aaa')}/>`,
  ].join('')
}

function wardrobe(w: number, h: number): string {
  const cx = w / 2
  const r = Math.min(w, h) * 0.04
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="${cx}" y1="0" x2="${cx}" y2="${h}" ${S}/>`,
    `<circle cx="${cx - w * 0.08}" cy="${h / 2}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${cx + w * 0.08}" cy="${h / 2}" r="${r}" ${SF('#aaa')}/>`,
  ].join('')
}

function dresser(w: number, h: number): string {
  const r = Math.min(w, h) * 0.04
  const cx = w / 2
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="0" y1="${h * 0.33}" x2="${w}" y2="${h * 0.33}" ${S}/>`,
    `<line x1="0" y1="${h * 0.66}" x2="${w}" y2="${h * 0.66}" ${S}/>`,
    `<circle cx="${cx}" cy="${h * 0.165}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${cx}" cy="${h * 0.495}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${cx}" cy="${h * 0.83}" r="${r}" ${SF('#aaa')}/>`,
  ].join('')
}

// ── Living ───────────────────────────────────────────────

function sofa3seat(w: number, h: number): string {
  const armW = w * 0.07
  const backH = h * 0.22
  const innerL = armW
  const innerR = w - armW
  const innerW = innerR - innerL
  const d1 = innerL + innerW / 3
  const d2 = innerL + (innerW * 2) / 3
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="0" y="0" width="${w}" height="${backH}" ${SF('#eee')}/>`,
    `<rect x="0" y="0" width="${armW}" height="${h}" ${SF('#eee')}/>`,
    `<rect x="${w * 0.93}" y="0" width="${armW}" height="${h}" ${SF('#eee')}/>`,
    `<line x1="${d1}" y1="${backH}" x2="${d1}" y2="${h}" ${S}/>`,
    `<line x1="${d2}" y1="${backH}" x2="${d2}" y2="${h}" ${S}/>`,
  ].join('')
}

function coffeeTable(w: number, h: number): string {
  return `<rect x="0" y="0" width="${w}" height="${h}" rx="3" ${S}/>`
}

function tvUnit(w: number, h: number): string {
  const inset = 0.15
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="${w * inset}" y="${h * inset}" width="${w * (1 - 2 * inset)}" height="${h * (1 - 2 * inset)}" ${S}/>`,
  ].join('')
}

function armchair(w: number, h: number): string {
  const armW = w * 0.15
  const backH = h * 0.22
  const seatInset = armW
  const seatW = w - 2 * armW
  const seatH = h - backH
  const seatRx = Math.min(seatW, seatH) * 0.1
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="0" y="0" width="${w}" height="${backH}" ${SF('#eee')}/>`,
    `<rect x="0" y="0" width="${armW}" height="${h}" ${SF('#eee')}/>`,
    `<rect x="${w - armW}" y="0" width="${armW}" height="${h}" ${SF('#eee')}/>`,
    `<rect x="${seatInset}" y="${backH}" width="${seatW}" height="${seatH}" rx="${seatRx}" ${SF('#F5F5F5')}/>`,
  ].join('')
}

function bookshelf(w: number, h: number): string {
  const lines = [1, 2, 3, 4].map(
    (i) => `<line x1="0" y1="${(h * i) / 5}" x2="${w}" y2="${(h * i) / 5}" ${S}/>`
  )
  return [`<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`, ...lines].join('')
}

// ── Kitchen ──────────────────────────────────────────────

function kitchenCounter(w: number, h: number): string {
  return `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`
}

function kitchenSink(w: number, h: number): string {
  const inset = 0.1
  const basinW = w * 0.35
  const basinH = h * (1 - 2 * inset)
  const by = h * inset
  const rx = Math.min(basinW, basinH) * 0.15
  const b1x = w * inset
  const b2x = w - w * inset - basinW
  const faucetR = Math.min(w, h) * 0.05
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<rect x="${b1x}" y="${by}" width="${basinW}" height="${basinH}" rx="${rx}" ${S}/>`,
    `<rect x="${b2x}" y="${by}" width="${basinW}" height="${basinH}" rx="${rx}" ${S}/>`,
    `<circle cx="${w / 2}" cy="${h * 0.15}" r="${faucetR}" ${SF('#aaa')}/>`,
  ].join('')
}

function fridge(w: number, h: number): string {
  const splitY = h * 0.3
  const r = Math.min(w, h) * 0.03
  const hx = w * 0.85
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="0" y1="${splitY}" x2="${w}" y2="${splitY}" ${S}/>`,
    `<circle cx="${hx}" cy="${splitY * 0.5}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${hx}" cy="${splitY + (h - splitY) * 0.5}" r="${r}" ${SF('#aaa')}/>`,
  ].join('')
}

function stove(w: number, h: number): string {
  const cols = [w * 0.3, w * 0.7]
  const rows = [h * 0.35, h * 0.7]
  const rOuter = Math.min(w, h) * 0.12
  const rInner = rOuter * 0.55
  const burners = cols.flatMap((cx) =>
    rows.map(
      (cy) =>
        `<circle cx="${cx}" cy="${cy}" r="${rOuter}" ${S}/>` +
        `<circle cx="${cx}" cy="${cy}" r="${rInner}" ${S}/>`
    )
  )
  return [`<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`, ...burners].join('')
}

function diningTable(w: number, h: number): string {
  return `<rect x="0" y="0" width="${w}" height="${h}" rx="3" ${S}/>`
}

function diningChair(w: number, h: number): string {
  const backH = h * 0.18
  return [
    `<rect x="0" y="${backH}" width="${w}" height="${h - backH}" ${S}/>`,
    `<rect x="0" y="0" width="${w}" height="${backH}" ${SF('#ddd')}/>`,
  ].join('')
}

// ── Bathroom ─────────────────────────────────────────────

function toilet(w: number, h: number): string {
  const tankW = w * 0.8
  const tankH = h * 0.28
  const tankX = w * 0.1
  return [
    `<rect x="${tankX}" y="0" width="${tankW}" height="${tankH}" rx="3" ${SF('#eee')}/>`,
    `<ellipse cx="${w / 2}" cy="${h * 0.65}" rx="${w * 0.42}" ry="${h * 0.33}" ${S}/>`,
    `<ellipse cx="${w / 2}" cy="${h * 0.6}" rx="${w * 0.25}" ry="${h * 0.2}" stroke="#aaa" fill="none" ${NS}/>`,
  ].join('')
}

function bathSink(w: number, h: number): string {
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<ellipse cx="${w / 2}" cy="${h * 0.6}" rx="${w * 0.35}" ry="${h * 0.3}" ${S}/>`,
    `<circle cx="${w / 2}" cy="${h * 0.2}" r="${h * 0.05}" ${SF('#aaa')}/>`,
  ].join('')
}

function bathtub(w: number, h: number): string {
  const inset = 0.08
  const ix = w * inset
  const iy = h * inset
  const iw = w * (1 - 2 * inset)
  const ih = h * (1 - 2 * inset)
  const irx = w * 0.15
  const drainR = Math.min(w, h) * 0.03
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" rx="5" ${S}/>`,
    `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="${irx}" ${S}/>`,
    `<circle cx="${w / 2}" cy="${h * 0.88}" r="${drainR}" ${SF('#aaa')}/>`,
  ].join('')
}

function shower(w: number, h: number): string {
  const r = Math.min(w, h)
  const drainR = r * 0.05
  const sprayR = r * 0.17
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" rx="3" ${S}/>`,
    `<circle cx="${w / 2}" cy="${h / 2}" r="${drainR}" ${SF('#aaa')}/>`,
    `<circle cx="${w / 2}" cy="${h / 2}" r="${sprayR}" stroke="#999" fill="none" stroke-dasharray="4 3" ${NS}/>`,
  ].join('')
}

// ── Office ───────────────────────────────────────────────

function desk(w: number, h: number): string {
  const lineY = h * 0.7
  const lineW = w * 0.6
  const lineX = (w - lineW) / 2
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="${lineX}" y1="${lineY}" x2="${lineX + lineW}" y2="${lineY}" ${S}/>`,
  ].join('')
}

function officeChair(w: number, h: number): string {
  const seatR = Math.min(w, h) * 0.38
  const cy = h * 0.55
  const backH = h * 0.15
  const backW = w * 0.7
  const backX = (w - backW) / 2
  return [
    `<circle cx="${w / 2}" cy="${cy}" r="${seatR}" ${S}/>`,
    `<rect x="${backX}" y="0" width="${backW}" height="${backH}" rx="3" ${SF('#ddd')}/>`,
  ].join('')
}

// ── Dining ───────────────────────────────────────────────

function sideboard(w: number, h: number): string {
  const r = Math.min(w, h) * 0.04
  const d1 = w / 3
  const d2 = (w * 2) / 3
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`,
    `<line x1="${d1}" y1="0" x2="${d1}" y2="${h}" ${S}/>`,
    `<line x1="${d2}" y1="0" x2="${d2}" y2="${h}" ${S}/>`,
    `<circle cx="${d1 / 2}" cy="${h / 2}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${(d1 + d2) / 2}" cy="${h / 2}" r="${r}" ${SF('#aaa')}/>`,
    `<circle cx="${(d2 + w) / 2}" cy="${h / 2}" r="${r}" ${SF('#aaa')}/>`,
  ].join('')
}

// ── Hallway ──────────────────────────────────────────────

function shoeRack(w: number, h: number): string {
  const lines = [1, 2, 3].map(
    (i) => `<line x1="0" y1="${(h * i) / 4}" x2="${w}" y2="${(h * i) / 4}" ${S}/>`
  )
  return [`<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`, ...lines].join('')
}

function coatHook(w: number, h: number): string {
  const n = 4
  const r = Math.min(w, h) * 0.08
  const cy = h / 2
  const hooks = Array.from({ length: n }, (_, i) => {
    const cx = (w * (i + 1)) / (n + 1)
    return `<circle cx="${cx}" cy="${cy}" r="${r}" ${SF('#aaa')}/>`
  })
  return [`<rect x="0" y="0" width="${w}" height="${h}" ${S}/>`, ...hooks].join('')
}

// ── Fallback ─────────────────────────────────────────────

function fallbackRect(w: number, h: number, type: string): string {
  return [
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#F5F5F5" stroke="#BDBDBD" ${NS}/>`,
    `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="central" font-size="12" fill="#999" ${NS}>${type}</text>`,
  ].join('')
}

export function furnitureDefsBlock(): string {
  const symbols = SYMBOL_TYPES.map(type => {
    const inner = furnitureSymbol(type, 100, 100);
    return `<symbol id="fs-${type}" viewBox="0 0 100 100" preserveAspectRatio="none">${inner}</symbol>`;
  }).join('\n');
  return `<defs>${symbols}</defs>`;
}
