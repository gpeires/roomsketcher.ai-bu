import { describe, it, expect } from 'vitest';
import { FloorPlanSchema, ChangeSchema, SimpleFloorPlanInputSchema } from './types';

describe('FloorPlanSchema', () => {
  it('validates a minimal valid floor plan', () => {
    const plan = {
      version: 1,
      id: 'test123',
      name: 'Test Plan',
      units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: {
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        source: 'ai',
      },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('validates a plan with walls, openings, and rooms', () => {
    const plan = {
      version: 1,
      id: 'test456',
      name: 'Studio',
      units: 'metric',
      canvas: { width: 1000, height: 800, gridSize: 10 },
      walls: [
        {
          id: 'w1',
          start: { x: 0, y: 0 },
          end: { x: 600, y: 0 },
          thickness: 20,
          height: 250,
          type: 'exterior',
          openings: [
            {
              id: 'd1',
              type: 'door',
              offset: 100,
              width: 90,
              properties: { swingDirection: 'left' },
            },
          ],
        },
      ],
      rooms: [
        {
          id: 'r1',
          label: 'Living Room',
          type: 'living',
          polygon: [
            { x: 0, y: 0 },
            { x: 600, y: 0 },
            { x: 600, y: 500 },
            { x: 0, y: 500 },
          ],
          color: '#E8F5E9',
        },
      ],
      furniture: [],
      annotations: [],
      metadata: {
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        source: 'ai',
      },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('rejects invalid version', () => {
    const plan = {
      version: 2,
      id: 'x',
      name: 'X',
      units: 'metric',
      canvas: { width: 100, height: 100, gridSize: 10 },
      walls: [],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: { created_at: 'x', updated_at: 'x', source: 'ai' },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it('rejects invalid wall type', () => {
    const plan = {
      version: 1,
      id: 'x',
      name: 'X',
      units: 'metric',
      canvas: { width: 100, height: 100, gridSize: 10 },
      walls: [
        {
          id: 'w1',
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          thickness: 10,
          height: 250,
          type: 'invisible',
          openings: [],
        },
      ],
      rooms: [],
      furniture: [],
      annotations: [],
      metadata: { created_at: 'x', updated_at: 'x', source: 'ai' },
    };
    const result = FloorPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe('ChangeSchema', () => {
  it('validates add_wall change', () => {
    const change = {
      type: 'add_wall',
      wall: {
        id: 'w1',
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        thickness: 20,
        height: 250,
        type: 'exterior',
        openings: [],
      },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates move_wall change', () => {
    const change = {
      type: 'move_wall',
      wall_id: 'w1',
      start: { x: 10, y: 10 },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates update_wall change with wall_type', () => {
    const change = {
      type: 'update_wall',
      wall_id: 'w1',
      thickness: 10,
      wall_type: 'interior',
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates rename_room change with room_type', () => {
    const change = {
      type: 'rename_room',
      room_id: 'r1',
      label: 'Master Bedroom',
      room_type: 'bedroom',
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates add_room change', () => {
    const change = {
      type: 'add_room',
      room: {
        id: 'r1',
        label: 'Kitchen',
        type: 'kitchen',
        polygon: [
          { x: 0, y: 0 },
          { x: 300, y: 0 },
          { x: 300, y: 300 },
          { x: 0, y: 300 },
        ],
        color: '#FFF3E0',
      },
    };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(true);
  });

  it('validates add_furniture change', () => {
    const change = {
      type: 'add_furniture',
      furniture: {
        id: 'f1',
        type: 'bed-double',
        position: { x: 100, y: 100 },
        rotation: 0,
        width: 160,
        depth: 200,
        label: 'Bed',
      },
    }
    const result = ChangeSchema.safeParse(change)
    expect(result.success).toBe(true)
  })

  it('validates move_furniture change', () => {
    const change = {
      type: 'move_furniture',
      furniture_id: 'f1',
      position: { x: 200, y: 200 },
    }
    const result = ChangeSchema.safeParse(change)
    expect(result.success).toBe(true)
  })

  it('validates remove_furniture change', () => {
    const change = {
      type: 'remove_furniture',
      furniture_id: 'f1',
    }
    const result = ChangeSchema.safeParse(change)
    expect(result.success).toBe(true)
  })

  it('rejects unknown change type', () => {
    const change = { type: 'fly_away' };
    const result = ChangeSchema.safeParse(change);
    expect(result.success).toBe(false);
  });
});

describe('SimpleFloorPlanInputSchema', () => {
  it('accepts a minimal rectangle room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts a polygon room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 500 }, { x: 0, y: 500 }] }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts openings between rooms', () => {
    const input = {
      name: 'Test',
      rooms: [
        { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
        { label: 'Living', x: 310, y: 0, width: 400, depth: 300 },
      ],
      openings: [{ type: 'door', between: ['Kitchen', 'Living'] }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts exterior openings with wall direction', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 }],
      openings: [{ type: 'window', room: 'Kitchen', wall: 'north' }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts room-relative furniture', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Bedroom', x: 0, y: 0, width: 400, depth: 350 }],
      furniture: [{ type: 'bed-double', room: 'Bedroom', x: 20, y: 20, width: 160, depth: 200 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts optional type field on room', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Den', type: 'office', x: 0, y: 0, width: 300, depth: 250 }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects room with neither rect nor polygon', () => {
    const input = {
      name: 'Test',
      rooms: [{ label: 'Bad' }],
    };
    expect(SimpleFloorPlanInputSchema.safeParse(input).success).toBe(false);
  });
});
