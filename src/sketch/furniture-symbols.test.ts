import { describe, it, expect } from 'vitest'
import { furnitureSymbol, SYMBOL_TYPES } from './furniture-symbols'
import { FURNITURE_CATALOG } from './furniture-catalog'

describe('furnitureSymbol', () => {
  it('returns non-empty SVG for every catalog type', () => {
    for (const item of FURNITURE_CATALOG) {
      const svg = furnitureSymbol(item.type, item.defaultWidth, item.defaultDepth)
      expect(svg, `${item.type} should produce SVG`).toBeTruthy()
      expect(svg).toContain('<')
    }
  })

  it('scales output to given dimensions', () => {
    const svg = furnitureSymbol('bed-double', 160, 200)
    expect(svg).toContain('160')
    expect(svg).toContain('200')
  })

  it('returns fallback rect for unknown types', () => {
    const svg = furnitureSymbol('unknown-thing', 100, 50)
    expect(svg).toContain('rect')
  })

  it('covers all catalog items', () => {
    const catalogTypes = FURNITURE_CATALOG.map(i => i.type)
    for (const t of catalogTypes) {
      expect(SYMBOL_TYPES).toContain(t)
    }
  })
})
