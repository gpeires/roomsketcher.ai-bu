import { describe, it, expect } from 'vitest'
import { applyDefaults, ROOM_COLORS } from './defaults'
import { FloorPlanSchema } from './types'

describe('applyDefaults', () => {
  it('fills wall thickness from wall type', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior' as const, openings: [] },
        { id: 'w2', start: { x: 0, y: 0 }, end: { x: 0, y: 400 }, type: 'interior' as const, openings: [] },
      ],
      rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.walls[0].thickness).toBe(20)
    expect(result.walls[0].height).toBe(250)
    expect(result.walls[1].thickness).toBe(10)
  })

  it('auto-computes canvas from wall bounding box', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior' as const, openings: [] },
        { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, type: 'exterior' as const, openings: [] },
      ],
      rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.canvas.width).toBeGreaterThanOrEqual(700)
    expect(result.canvas.height).toBeGreaterThanOrEqual(500)
    expect(result.canvas.gridSize).toBe(10)
  })

  it('fills room color from room type', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living' as const, polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }] },
      ],
      furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.rooms[0].color).toBe(ROOM_COLORS.living)
  })

  it('fills metadata defaults', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [], rooms: [], furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    expect(result.metadata.source).toBe('ai')
    expect(result.metadata.created_at).toBeTruthy()
    expect(result.metadata.updated_at).toBeTruthy()
  })

  it('does not overwrite explicitly provided values', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      canvas: { width: 2000, height: 1500, gridSize: 20 },
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior' as const, thickness: 30, height: 300, openings: [] },
      ],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living' as const, polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], color: '#FF0000' },
      ],
      furniture: [], annotations: [],
      metadata: { created_at: 'custom', updated_at: 'custom', source: 'sketcher' as const },
    }
    const result = applyDefaults(input)
    expect(result.walls[0].thickness).toBe(30)
    expect(result.walls[0].height).toBe(300)
    expect(result.rooms[0].color).toBe('#FF0000')
    expect(result.canvas.width).toBe(2000)
    expect(result.metadata.source).toBe('sketcher')
  })

  it('output validates against strict FloorPlanSchema', () => {
    const input = {
      version: 1 as const, id: 'test', name: 'Test', units: 'metric' as const,
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, type: 'exterior' as const, openings: [] },
      ],
      rooms: [
        { id: 'r1', label: 'Living', type: 'living' as const, polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }] },
      ],
      furniture: [], annotations: [],
    }
    const result = applyDefaults(input)
    const parsed = FloorPlanSchema.safeParse(result)
    expect(parsed.success).toBe(true)
  })
})
