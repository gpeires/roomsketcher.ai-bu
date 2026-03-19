import { describe, it, expect } from 'vitest'
import { FURNITURE_CATALOG } from './furniture-catalog'

describe('FURNITURE_CATALOG', () => {
  it('has at least 25 items', () => {
    expect(FURNITURE_CATALOG.length).toBeGreaterThanOrEqual(25)
  })

  it('every item has required fields', () => {
    for (const item of FURNITURE_CATALOG) {
      expect(item.type).toBeTruthy()
      expect(item.label).toBeTruthy()
      expect(item.defaultWidth).toBeGreaterThan(0)
      expect(item.defaultDepth).toBeGreaterThan(0)
      expect(item.roomTypes.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate types', () => {
    const types = FURNITURE_CATALOG.map(i => i.type)
    expect(new Set(types).size).toBe(types.length)
  })
})
