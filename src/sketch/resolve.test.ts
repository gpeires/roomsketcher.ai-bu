import { describe, it, expect } from 'vitest';
import type { FloorPlan } from './types';
import {
  findRoomByLabel,
  findRoomWalls,
  findRoomWallOnSide,
  findSharedWall,
  findFurnitureInRoom,
  resolvePosition,
} from './resolve';

function makeTestPlan(): FloorPlan {
  return {
    version: 1,
    id: 'test-plan',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w2', start: { x: 400, y: 0 }, end: { x: 400, y: 300 }, thickness: 10, height: 250, type: 'interior', openings: [] },
      { id: 'w3', start: { x: 400, y: 0 }, end: { x: 800, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w4', start: { x: 0, y: 0 }, end: { x: 0, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w5', start: { x: 0, y: 300 }, end: { x: 400, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w6', start: { x: 400, y: 300 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      { id: 'w7', start: { x: 800, y: 0 }, end: { x: 800, y: 300 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ],
    rooms: [
      { id: 'r1', label: 'Kitchen', type: 'kitchen', polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], color: '#E8F5E9', area: 12 },
      { id: 'r2', label: 'Living Room', type: 'living', polygon: [{ x: 400, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 400, y: 300 }], color: '#FFF3E0', area: 12 },
    ],
    furniture: [
      { id: 'f1', type: 'fridge', position: { x: 50, y: 50 }, rotation: 0, width: 70, depth: 70 },
      { id: 'f2', type: 'sofa-3seat', position: { x: 500, y: 100 }, rotation: 0, width: 200, depth: 90 },
    ],
    annotations: [],
    metadata: { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', source: 'ai' },
  };
}

// ─── findRoomByLabel ─────────────────────────────────────────────────────────

describe('findRoomByLabel', () => {
  it('finds room by exact match', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'Kitchen');
    expect(room.id).toBe('r1');
  });

  it('finds room case-insensitively', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'kitchen');
    expect(room.id).toBe('r1');
  });

  it('finds room by partial match (label contains query)', () => {
    const plan = makeTestPlan();
    const room = findRoomByLabel(plan, 'Living');
    expect(room.id).toBe('r2');
  });

  it('finds room by partial match (query contains label)', () => {
    const plan = makeTestPlan();
    // 'Kitchen Area' includes 'Kitchen'
    const room = findRoomByLabel(plan, 'Kitchen Area');
    expect(room.id).toBe('r1');
  });

  it('throws with available rooms listed when not found', () => {
    const plan = makeTestPlan();
    expect(() => findRoomByLabel(plan, 'Bedroom')).toThrow(/Kitchen.*Living Room|Living Room.*Kitchen/);
  });

  it('throws descriptive error message', () => {
    const plan = makeTestPlan();
    expect(() => findRoomByLabel(plan, 'Bathroom')).toThrow(/Bathroom|not found/i);
  });
});

// ─── findRoomWalls ───────────────────────────────────────────────────────────

describe('findRoomWalls', () => {
  it('finds all walls belonging to Kitchen', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const walls = findRoomWalls(plan, kitchen);
    const ids = walls.map(w => w.id).sort();
    // w1 (north), w2 (east/shared), w4 (west), w5 (south)
    expect(ids).toContain('w1');
    expect(ids).toContain('w2');
    expect(ids).toContain('w4');
    expect(ids).toContain('w5');
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  it('finds walls belonging to Living Room', () => {
    const plan = makeTestPlan();
    const living = plan.rooms[1];
    const walls = findRoomWalls(plan, living);
    const ids = walls.map(w => w.id).sort();
    // w2 (shared west), w3 (north), w6 (south), w7 (east)
    expect(ids).toContain('w2');
    expect(ids).toContain('w3');
    expect(ids).toContain('w6');
    expect(ids).toContain('w7');
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── findRoomWallOnSide ──────────────────────────────────────────────────────

describe('findRoomWallOnSide', () => {
  it('finds north wall of Kitchen (w1)', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const wall = findRoomWallOnSide(plan, kitchen, 'north');
    expect(wall).not.toBeNull();
    expect(wall?.id).toBe('w1');
  });

  it('finds east wall of Kitchen (w2)', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const wall = findRoomWallOnSide(plan, kitchen, 'east');
    expect(wall).not.toBeNull();
    expect(wall?.id).toBe('w2');
  });

  it('finds west wall of Kitchen (w4)', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const wall = findRoomWallOnSide(plan, kitchen, 'west');
    expect(wall).not.toBeNull();
    expect(wall?.id).toBe('w4');
  });

  it('finds south wall of Kitchen (w5)', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const wall = findRoomWallOnSide(plan, kitchen, 'south');
    expect(wall).not.toBeNull();
    expect(wall?.id).toBe('w5');
  });

  it('returns null when no wall exists on that side', () => {
    const plan = makeTestPlan();
    // Remove all horizontal walls from the plan to simulate missing wall
    const planNoNorth = {
      ...plan,
      walls: plan.walls.filter(w => w.id !== 'w1'),
    };
    const kitchen = plan.rooms[0];
    const wall = findRoomWallOnSide(planNoNorth, kitchen, 'north');
    expect(wall).toBeNull();
  });
});

// ─── findSharedWall ──────────────────────────────────────────────────────────

describe('findSharedWall', () => {
  it('finds shared wall (w2) between Kitchen and Living Room', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const living = plan.rooms[1];
    const wall = findSharedWall(plan, kitchen, living);
    expect(wall).not.toBeNull();
    expect(wall?.id).toBe('w2');
  });

  it('returns null for non-adjacent rooms (no shared wall)', () => {
    const plan = makeTestPlan();
    // Add a third room not adjacent to any existing rooms
    const bedroom = {
      id: 'r3', label: 'Bedroom', type: 'bedroom' as const,
      polygon: [{ x: 900, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 300 }, { x: 900, y: 300 }],
      color: '#E3F2FD', area: 9,
    };
    const planWithBedroom = { ...plan, rooms: [...plan.rooms, bedroom] };
    const kitchen = plan.rooms[0];
    const wall = findSharedWall(planWithBedroom, kitchen, bedroom);
    expect(wall).toBeNull();
  });
});

// ─── findFurnitureInRoom ─────────────────────────────────────────────────────

describe('findFurnitureInRoom', () => {
  it('finds fridge inside Kitchen', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const items = findFurnitureInRoom(plan, kitchen);
    const ids = items.map(f => f.id);
    expect(ids).toContain('f1');
  });

  it('does not include sofa (which is in Living Room, not Kitchen)', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const items = findFurnitureInRoom(plan, kitchen);
    const ids = items.map(f => f.id);
    expect(ids).not.toContain('f2');
  });

  it('finds sofa inside Living Room', () => {
    const plan = makeTestPlan();
    const living = plan.rooms[1];
    const items = findFurnitureInRoom(plan, living);
    const ids = items.map(f => f.id);
    expect(ids).toContain('f2');
  });

  it('filters by type when type is provided', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const fridges = findFurnitureInRoom(plan, kitchen, 'fridge');
    expect(fridges.length).toBe(1);
    expect(fridges[0].id).toBe('f1');
  });

  it('returns empty array when type filter matches nothing', () => {
    const plan = makeTestPlan();
    const kitchen = plan.rooms[0];
    const sofas = findFurnitureInRoom(plan, kitchen, 'sofa-3seat');
    expect(sofas).toHaveLength(0);
  });
});

// ─── resolvePosition ─────────────────────────────────────────────────────────

describe('resolvePosition', () => {
  // Kitchen: bbox 0,0 → 400,300. Size: 400w × 300h
  const kitchen = {
    id: 'r1', label: 'Kitchen', type: 'kitchen' as const,
    polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
    color: '#E8F5E9', area: 12,
  };

  it('resolves center position for 70x70 item', () => {
    // center x = 0 + (400 - 70) / 2 = 165, center y = 0 + (300 - 70) / 2 = 115
    const pos = resolvePosition(kitchen, 'center', 70, 70);
    expect(pos.x).toBe(165);
    expect(pos.y).toBe(115);
  });

  it('resolves north position for 100x60 item', () => {
    // x = 0 + (400 - 100) / 2 = 150, y = 0 + WALL_CLEARANCE = 10
    const pos = resolvePosition(kitchen, 'north', 100, 60);
    expect(pos.x).toBe(150);
    expect(pos.y).toBe(10);
  });

  it('resolves south position for 100x60 item', () => {
    // x = (400-100)/2 = 150, y = 300 - WALL_CLEARANCE - 60 = 230
    const pos = resolvePosition(kitchen, 'south', 100, 60);
    expect(pos.x).toBe(150);
    expect(pos.y).toBe(230);
  });

  it('resolves east position for 100x60 item', () => {
    // x = 400 - WALL_CLEARANCE - 100 = 290, y = (300-60)/2 = 120
    const pos = resolvePosition(kitchen, 'east', 100, 60);
    expect(pos.x).toBe(290);
    expect(pos.y).toBe(120);
  });

  it('resolves west position for 100x60 item', () => {
    // x = 0 + WALL_CLEARANCE = 10, y = (300-60)/2 = 120
    const pos = resolvePosition(kitchen, 'west', 100, 60);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(120);
  });

  it('resolves ne position for 60x40 item', () => {
    // x = 400 - WALL_CLEARANCE - 60 = 330, y = 0 + WALL_CLEARANCE = 10
    const pos = resolvePosition(kitchen, 'ne', 60, 40);
    expect(pos.x).toBe(330);
    expect(pos.y).toBe(10);
  });

  it('resolves nw position for 60x40 item', () => {
    // x = 0 + WALL_CLEARANCE = 10, y = 0 + WALL_CLEARANCE = 10
    const pos = resolvePosition(kitchen, 'nw', 60, 40);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(10);
  });

  it('resolves se position for 60x40 item', () => {
    // x = 400 - WALL_CLEARANCE - 60 = 330, y = 300 - WALL_CLEARANCE - 40 = 250
    const pos = resolvePosition(kitchen, 'se', 60, 40);
    expect(pos.x).toBe(330);
    expect(pos.y).toBe(250);
  });

  it('resolves sw position for 60x40 item', () => {
    // x = 0 + WALL_CLEARANCE = 10, y = 300 - WALL_CLEARANCE - 40 = 250
    const pos = resolvePosition(kitchen, 'sw', 60, 40);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(250);
  });

  it('returns explicit {x, y} coordinates relative to room origin', () => {
    // Room origin is at (0,0) for kitchen, so explicit coords are unchanged
    const pos = resolvePosition(kitchen, { x: 50, y: 30 }, 100, 60);
    expect(pos.x).toBe(50);
    expect(pos.y).toBe(30);
  });

  it('resolves explicit coords relative to room origin for offset room', () => {
    // Room with non-zero origin
    const livingRoom = {
      id: 'r2', label: 'Living Room', type: 'living' as const,
      polygon: [{ x: 400, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 400, y: 300 }],
      color: '#FFF3E0', area: 12,
    };
    // Explicit coords are offset by room minX, minY
    const pos = resolvePosition(livingRoom, { x: 50, y: 30 }, 100, 60);
    expect(pos.x).toBe(450); // 400 + 50
    expect(pos.y).toBe(30);  // 0 + 30
  });
});
