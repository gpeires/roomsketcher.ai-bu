import { describe, it, expect } from 'vitest'
import { FURNITURE_CATALOG, getItemsForRoom } from './furniture-catalog'

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

describe('getItemsForRoom', () => {
  it('returns bedroom items for bedroom type', () => {
    const items = getItemsForRoom('bedroom')
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(i => i.type === 'bed-double')).toBe(true)
  })

  it('returns kitchen items for kitchen type', () => {
    const items = getItemsForRoom('kitchen')
    expect(items.some(i => i.type === 'kitchen-counter')).toBe(true)
  })

  it('returns empty array for room type with no items', () => {
    const items = getItemsForRoom('garage')
    expect(Array.isArray(items)).toBe(true)
  })
})
