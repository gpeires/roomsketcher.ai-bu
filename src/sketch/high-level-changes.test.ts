import { describe, it, expect } from 'vitest';
import type { FloorPlan, Change } from './types';
import {
  HighLevelChangeSchema,
  compileHighLevelChange,
  processChanges,
  movePolygonSide,
  sideDelta,
  oppositeSide,
} from './high-level-changes';
import type { HighLevelChange } from './high-level-changes';

// ─── Test plan factory (same layout as resolve.test.ts) ─────────────────────
// Kitchen: 0,0 → 400,300 (left)   Living Room: 400,0 → 800,300 (right)
// Shared wall w2 at x=400 (interior)

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
      { id: 'r1', label: 'Kitchen', type: 'kitchen', polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], color: '#FFF3E0', area: 12 },
      { id: 'r2', label: 'Living Room', type: 'living', polygon: [{ x: 400, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 400, y: 300 }], color: '#E8F5E9', area: 12 },
    ],
    furniture: [
      { id: 'f1', type: 'fridge', position: { x: 50, y: 50 }, rotation: 0, width: 70, depth: 70 },
      { id: 'f2', type: 'sofa-3seat', position: { x: 500, y: 100 }, rotation: 0, width: 200, depth: 90 },
    ],
    annotations: [],
    metadata: { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', source: 'ai' },
  };
}

// ─── Helper function tests ──────────────────────────────────────────────────

describe('helper functions', () => {
  describe('oppositeSide', () => {
    it('north ↔ south', () => {
      expect(oppositeSide('north')).toBe('south');
      expect(oppositeSide('south')).toBe('north');
    });
    it('east ↔ west', () => {
      expect(oppositeSide('east')).toBe('west');
      expect(oppositeSide('west')).toBe('east');
    });
  });

  describe('sideDelta', () => {
    it('south/east: positive delta', () => {
      expect(sideDelta('south', 50)).toBe(50);
      expect(sideDelta('east', 50)).toBe(50);
    });
    it('north/west: negative delta', () => {
      expect(sideDelta('north', 50)).toBe(-50);
      expect(sideDelta('west', 50)).toBe(-50);
    });
  });

  describe('movePolygonSide', () => {
    const rect = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];

    it('moves east side by +50', () => {
      const result = movePolygonSide(rect, 'east', 50);
      expect(result[1].x).toBe(450); // top-right
      expect(result[2].x).toBe(450); // bottom-right
      expect(result[0].x).toBe(0);   // top-left unchanged
    });

    it('moves south side by +30', () => {
      const result = movePolygonSide(rect, 'south', 30);
      expect(result[2].y).toBe(330); // bottom-right
      expect(result[3].y).toBe(330); // bottom-left
      expect(result[0].y).toBe(0);   // top-left unchanged
    });

    it('moves north side by -50 (expand north)', () => {
      const result = movePolygonSide(rect, 'north', -50);
      expect(result[0].y).toBe(-50);
      expect(result[1].y).toBe(-50);
    });

    it('moves west side by -30', () => {
      const result = movePolygonSide(rect, 'west', -30);
      expect(result[0].x).toBe(-30);
      expect(result[3].x).toBe(-30);
    });
  });
});

// ─── Task 4: resize_room ────────────────────────────────────────────────────

describe('resize_room', () => {
  it('expands kitchen east by 50: updates polygon, wall, and adjacent room', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'resize_room',
      room: 'Kitchen',
      side: 'east',
      delta_cm: 50,
    });

    // Should update kitchen polygon
    const kitchenUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
    expect(kitchenUpdate).toBeDefined();
    if (kitchenUpdate?.type === 'update_room' && kitchenUpdate.polygon) {
      // East vertices should move from 400 to 450
      const eastXValues = kitchenUpdate.polygon.filter(p => p.x === 450);
      expect(eastXValues.length).toBe(2);
    }

    // Should move wall w2 (shared wall on east side) by +50 in x
    const wallMove = changes.find(c => c.type === 'move_wall' && c.wall_id === 'w2');
    expect(wallMove).toBeDefined();
    if (wallMove?.type === 'move_wall') {
      expect(wallMove.start?.x).toBe(450);
      expect(wallMove.end?.x).toBe(450);
    }

    // Should update Living Room polygon (west side moves from 400 to 450)
    const livingUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r2');
    expect(livingUpdate).toBeDefined();
    if (livingUpdate?.type === 'update_room' && livingUpdate.polygon) {
      const westXValues = livingUpdate.polygon.filter(p => p.x === 450);
      expect(westXValues.length).toBe(2);
    }
  });

  it('contracts kitchen south by 30: south edge moves from 300 to 270', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'resize_room',
      room: 'Kitchen',
      side: 'south',
      delta_cm: -30, // contract = negative delta
    });

    const kitchenUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
    expect(kitchenUpdate).toBeDefined();
    if (kitchenUpdate?.type === 'update_room' && kitchenUpdate.polygon) {
      // South vertices (y=300) should now be at y=270
      const southVertices = kitchenUpdate.polygon.filter(p => p.y === 270);
      expect(southVertices.length).toBe(2);
    }
  });
});

// ─── Task 5: room operations ────────────────────────────────────────────────

describe('move_room', () => {
  it('shifts kitchen by 50,30: polygon, walls, furniture all move', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'move_room',
      room: 'Kitchen',
      dx: 50,
      dy: 30,
    });

    // Polygon update
    const roomUpdate = changes.find(c => c.type === 'update_room' && c.room_id === 'r1');
    expect(roomUpdate).toBeDefined();
    if (roomUpdate?.type === 'update_room' && roomUpdate.polygon) {
      expect(roomUpdate.polygon[0]).toEqual({ x: 50, y: 30 });
      expect(roomUpdate.polygon[1]).toEqual({ x: 450, y: 30 });
    }

    // Non-shared walls move (w1 north, w4 west, w5 south — w2 is shared, should NOT move)
    const movedWallIds = changes.filter(c => c.type === 'move_wall').map(c => (c as any).wall_id);
    expect(movedWallIds).toContain('w1');
    expect(movedWallIds).toContain('w4');
    expect(movedWallIds).toContain('w5');
    expect(movedWallIds).not.toContain('w2'); // shared wall

    // Furniture f1 (fridge in kitchen) moves
    const furnitureMove = changes.find(c => c.type === 'move_furniture' && (c as any).furniture_id === 'f1');
    expect(furnitureMove).toBeDefined();
    if (furnitureMove?.type === 'move_furniture') {
      expect(furnitureMove.position).toEqual({ x: 100, y: 80 });
    }
  });
});

describe('add_room', () => {
  it('with rect creates 4-point polygon', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_room',
      label: 'Bedroom',
      room_type: 'bedroom',
      rect: { x: 0, y: 300, width: 400, depth: 300 },
    });

    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('add_room');
    if (changes[0].type === 'add_room') {
      expect(changes[0].room.label).toBe('Bedroom');
      expect(changes[0].room.type).toBe('bedroom');
      expect(changes[0].room.polygon).toHaveLength(4);
      expect(changes[0].room.polygon[0]).toEqual({ x: 0, y: 300 });
      expect(changes[0].room.polygon[2]).toEqual({ x: 400, y: 600 });
      expect(changes[0].room.color).toBe('#E3F2FD'); // bedroom color
    }
  });

  it('with explicit polygon preserves it', () => {
    const plan = makeTestPlan();
    const poly = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 100, y: 250 }, { x: 0, y: 200 }];
    const changes = compileHighLevelChange(plan, {
      type: 'add_room',
      label: 'Balcony',
      room_type: 'balcony',
      polygon: poly,
    });

    expect(changes.length).toBe(1);
    if (changes[0].type === 'add_room') {
      expect(changes[0].room.polygon).toEqual(poly);
    }
  });

  it('throws if neither rect nor polygon provided', () => {
    const plan = makeTestPlan();
    expect(() => compileHighLevelChange(plan, {
      type: 'add_room',
      label: 'Empty',
      room_type: 'other',
    })).toThrow(/rect or polygon/);
  });
});

describe('remove_room', () => {
  it('removes room, furniture, and private walls (not shared w2)', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'remove_room',
      room: 'Kitchen',
    });

    // Should remove furniture f1
    const furnitureRemoves = changes.filter(c => c.type === 'remove_furniture');
    expect(furnitureRemoves.some(c => (c as any).furniture_id === 'f1')).toBe(true);

    // Should remove private walls (w1, w4, w5) but NOT shared w2
    const wallRemoves = changes.filter(c => c.type === 'remove_wall').map(c => (c as any).wall_id);
    expect(wallRemoves).toContain('w1');
    expect(wallRemoves).toContain('w4');
    expect(wallRemoves).toContain('w5');
    expect(wallRemoves).not.toContain('w2');

    // Should remove the room itself
    const roomRemove = changes.find(c => c.type === 'remove_room');
    expect(roomRemove).toBeDefined();
    if (roomRemove?.type === 'remove_room') {
      expect(roomRemove.room_id).toBe('r1');
    }
  });
});

describe('split_room', () => {
  it('vertical split at 200cm creates 2 rooms + 1 interior wall', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'split_room',
      room: 'Kitchen',
      axis: 'vertical',
      position_cm: 200,
      labels: ['Kitchen A', 'Kitchen B'],
    });

    // Remove original room
    const removeRoom = changes.find(c => c.type === 'remove_room');
    expect(removeRoom).toBeDefined();
    if (removeRoom?.type === 'remove_room') {
      expect(removeRoom.room_id).toBe('r1');
    }

    // Two new rooms
    const addRooms = changes.filter(c => c.type === 'add_room');
    expect(addRooms).toHaveLength(2);

    if (addRooms[0].type === 'add_room' && addRooms[1].type === 'add_room') {
      expect(addRooms[0].room.label).toBe('Kitchen A');
      expect(addRooms[1].room.label).toBe('Kitchen B');

      // Left room: 0,0 → 200,300
      expect(addRooms[0].room.polygon).toContainEqual({ x: 0, y: 0 });
      expect(addRooms[0].room.polygon).toContainEqual({ x: 200, y: 300 });

      // Right room: 200,0 → 400,300
      expect(addRooms[1].room.polygon).toContainEqual({ x: 200, y: 0 });
      expect(addRooms[1].room.polygon).toContainEqual({ x: 400, y: 300 });
    }

    // Interior wall at x=200
    const addWall = changes.find(c => c.type === 'add_wall');
    expect(addWall).toBeDefined();
    if (addWall?.type === 'add_wall') {
      expect(addWall.wall.start).toEqual({ x: 200, y: 0 });
      expect(addWall.wall.end).toEqual({ x: 200, y: 300 });
      expect(addWall.wall.type).toBe('interior');
    }
  });

  it('can specify types for split rooms', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'split_room',
      room: 'Kitchen',
      axis: 'vertical',
      position_cm: 200,
      labels: ['Kitchen', 'Pantry'],
      types: ['kitchen', 'storage'],
    });

    const addRooms = changes.filter(c => c.type === 'add_room');
    if (addRooms[0].type === 'add_room' && addRooms[1].type === 'add_room') {
      expect(addRooms[0].room.type).toBe('kitchen');
      expect(addRooms[1].room.type).toBe('storage');
    }
  });
});

describe('merge_rooms', () => {
  it('merges Kitchen + Living → removes both, shared wall, creates merged room 0-800', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'merge_rooms',
      rooms: ['Kitchen', 'Living Room'],
      label: 'Great Room',
      room_type: 'living',
    });

    // Remove both rooms
    const removeRooms = changes.filter(c => c.type === 'remove_room');
    expect(removeRooms).toHaveLength(2);
    const removedIds = removeRooms.map(c => (c as any).room_id);
    expect(removedIds).toContain('r1');
    expect(removedIds).toContain('r2');

    // Remove shared wall w2
    const removeWalls = changes.filter(c => c.type === 'remove_wall');
    expect(removeWalls.some(c => (c as any).wall_id === 'w2')).toBe(true);

    // Create merged room spanning 0-800
    const addRoom = changes.find(c => c.type === 'add_room');
    expect(addRoom).toBeDefined();
    if (addRoom?.type === 'add_room') {
      expect(addRoom.room.label).toBe('Great Room');
      expect(addRoom.room.type).toBe('living');
      expect(addRoom.room.polygon).toContainEqual({ x: 0, y: 0 });
      expect(addRoom.room.polygon).toContainEqual({ x: 800, y: 0 });
      expect(addRoom.room.polygon).toContainEqual({ x: 800, y: 300 });
      expect(addRoom.room.polygon).toContainEqual({ x: 0, y: 300 });
    }
  });

  it('throws "no shared wall" for non-adjacent rooms', () => {
    const plan = makeTestPlan();
    // Add a non-adjacent bedroom
    const planWithBedroom: FloorPlan = {
      ...plan,
      rooms: [
        ...plan.rooms,
        {
          id: 'r3', label: 'Bedroom', type: 'bedroom',
          polygon: [{ x: 900, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 300 }, { x: 900, y: 300 }],
          color: '#E3F2FD', area: 9,
        },
      ],
    };

    expect(() => compileHighLevelChange(planWithBedroom, {
      type: 'merge_rooms',
      rooms: ['Kitchen', 'Bedroom'],
      label: 'Merged',
      room_type: 'other',
    })).toThrow(/no shared wall/i);
  });
});

// ─── Task 6: openings, furniture, labels ────────────────────────────────────

describe('add_door', () => {
  it('between rooms: finds shared wall w2, creates door opening with width 80', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_door',
      between: ['Kitchen', 'Living Room'],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('add_opening');
    if (changes[0].type === 'add_opening') {
      expect(changes[0].wall_id).toBe('w2');
      expect(changes[0].opening.type).toBe('door');
      expect(changes[0].opening.width).toBe(80);
      expect(changes[0].opening.properties.swingDirection).toBe('right');
    }
  });

  it('on room + wall_side: finds wall on south side', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_door',
      room: 'Kitchen',
      wall_side: 'south',
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'add_opening') {
      expect(changes[0].wall_id).toBe('w5');
      expect(changes[0].opening.type).toBe('door');
      expect(changes[0].opening.width).toBe(80);
    }
  });

  it('throws without between or room+wall_side', () => {
    const plan = makeTestPlan();
    expect(() => compileHighLevelChange(plan, {
      type: 'add_door',
    })).toThrow(/between.*wall_side|wall_side.*between/i);
  });
});

describe('add_window', () => {
  it('creates window opening with width 120 and single type', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'add_window',
      room: 'Kitchen',
      wall_side: 'north',
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'add_opening') {
      expect(changes[0].wall_id).toBe('w1');
      expect(changes[0].opening.type).toBe('window');
      expect(changes[0].opening.width).toBe(120);
      expect(changes[0].opening.properties.windowType).toBe('single');
    }
  });
});

describe('update_opening', () => {
  it('updates opening on wall', () => {
    // Add a wall with an opening first
    const plan = makeTestPlan();
    plan.walls[0].openings.push({
      id: 'o1',
      type: 'window',
      offset: 100,
      width: 120,
      properties: { windowType: 'single' },
    });

    const changes = compileHighLevelChange(plan, {
      type: 'update_opening',
      room: 'Kitchen',
      wall_side: 'north',
      width: 150,
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'update_opening') {
      expect(changes[0].wall_id).toBe('w1');
      expect(changes[0].opening_id).toBe('o1');
      expect(changes[0].width).toBe(150);
    }
  });
});

describe('remove_opening', () => {
  it('removes opening from wall', () => {
    const plan = makeTestPlan();
    plan.walls[0].openings.push({
      id: 'o1',
      type: 'door',
      offset: 100,
      width: 80,
      properties: { swingDirection: 'right' },
    });

    const changes = compileHighLevelChange(plan, {
      type: 'remove_opening',
      room: 'Kitchen',
      wall_side: 'north',
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'remove_opening') {
      expect(changes[0].wall_id).toBe('w1');
      expect(changes[0].opening_id).toBe('o1');
    }
  });
});

describe('place_furniture', () => {
  it('resolves named position and uses catalog defaults', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'place_furniture',
      furniture_type: 'fridge',
      room: 'Kitchen',
      position: 'ne',
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'add_furniture') {
      expect(changes[0].furniture.type).toBe('fridge');
      expect(changes[0].furniture.width).toBe(70);  // catalog default
      expect(changes[0].furniture.depth).toBe(70);   // catalog default
      // ne position: x = 400 - 10 - 70 = 320, y = 0 + 10 = 10
      expect(changes[0].furniture.position.x).toBe(320);
      expect(changes[0].furniture.position.y).toBe(10);
    }
  });

  it('uses custom dimensions when provided', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'place_furniture',
      furniture_type: 'fridge',
      room: 'Kitchen',
      position: 'center',
      width: 100,
      depth: 100,
    });

    if (changes[0].type === 'add_furniture') {
      expect(changes[0].furniture.width).toBe(100);
      expect(changes[0].furniture.depth).toBe(100);
    }
  });
});

describe('move_furniture', () => {
  it('finds furniture by type in room and moves it', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'move_furniture',
      furniture_type: 'fridge',
      room: 'Kitchen',
      position: 'sw',
    });

    expect(changes).toHaveLength(1);
    if (changes[0].type === 'move_furniture') {
      expect(changes[0].furniture_id).toBe('f1');
      // sw: x = 0 + 10 = 10, y = 300 - 10 - 70 = 220
      expect(changes[0].position).toEqual({ x: 10, y: 220 });
    }
  });
});

describe('remove_furniture', () => {
  it('removes by furniture_id', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'remove_furniture',
      furniture_id: 'f1',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ type: 'remove_furniture', furniture_id: 'f1' });
  });

  it('removes by room + type', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'remove_furniture',
      room: 'Kitchen',
      furniture_type: 'fridge',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ type: 'remove_furniture', furniture_id: 'f1' });
  });
});

describe('rename_room', () => {
  it('compiles to low-level rename_room', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'rename_room',
      room: 'Kitchen',
      new_label: 'Chef\'s Kitchen',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      type: 'rename_room',
      room_id: 'r1',
      label: "Chef's Kitchen",
    });
  });
});

describe('retype_room', () => {
  it('compiles to rename_room with room_type set, keeps existing label', () => {
    const plan = makeTestPlan();
    const changes = compileHighLevelChange(plan, {
      type: 'retype_room',
      room: 'Kitchen',
      new_type: 'dining',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      type: 'rename_room',
      room_id: 'r1',
      label: 'Kitchen',
      room_type: 'dining',
    });
  });
});

describe('set_envelope', () => {
  it('passes through as low-level set_envelope', () => {
    const plan = makeTestPlan();
    const poly = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 300 }, { x: 0, y: 300 }];
    const changes = compileHighLevelChange(plan, {
      type: 'set_envelope',
      polygon: poly,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ type: 'set_envelope', polygon: poly });
  });
});

// ─── Integration: processChanges ────────────────────────────────────────────

describe('processChanges', () => {
  it('chains multiple high-level changes sequentially', () => {
    const plan = makeTestPlan();
    const result = processChanges(plan, [
      { type: 'rename_room', room: 'Kitchen', new_label: 'Main Kitchen' },
      { type: 'rename_room', room: 'Main Kitchen', new_label: 'Grand Kitchen' },
    ]);

    const kitchen = result.rooms.find(r => r.id === 'r1');
    expect(kitchen?.label).toBe('Grand Kitchen');
  });

  it('applies low-level changes after high-level', () => {
    const plan = makeTestPlan();
    const hlChanges: HighLevelChange[] = [
      { type: 'rename_room', room: 'Kitchen', new_label: 'Main Kitchen' },
    ];
    const llChanges: Change[] = [
      { type: 'rename_room', room_id: 'r1', label: 'Final Kitchen' },
    ];

    const result = processChanges(plan, hlChanges, llChanges);
    const kitchen = result.rooms.find(r => r.id === 'r1');
    expect(kitchen?.label).toBe('Final Kitchen');
  });

  it('recomputes canvas bounds after adding walls', () => {
    const plan = makeTestPlan();
    const result = processChanges(plan, [], [
      // Add a wall that extends well beyond existing bounds
      {
        type: 'add_wall',
        wall: {
          id: 'w-new',
          start: { x: 0, y: 500 },
          end: { x: 800, y: 500 },
          thickness: 20,
          height: 250,
          type: 'exterior',
          openings: [],
        },
      },
    ]);

    // Canvas should accommodate the new wall at y=500 (plus padding)
    expect(result.canvas.height).toBeGreaterThanOrEqual(600);
  });

  it('error: non-existent room throws with available rooms listed', () => {
    const plan = makeTestPlan();
    expect(() => processChanges(plan, [
      { type: 'rename_room', room: 'Nonexistent', new_label: 'X' },
    ])).toThrow(/Kitchen.*Living Room|Living Room.*Kitchen/);
  });

  it('error: merge non-adjacent rooms throws "no shared wall"', () => {
    const plan = makeTestPlan();
    const planWithBedroom: FloorPlan = {
      ...plan,
      rooms: [
        ...plan.rooms,
        {
          id: 'r3', label: 'Bedroom', type: 'bedroom',
          polygon: [{ x: 900, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 300 }, { x: 900, y: 300 }],
          color: '#E3F2FD', area: 9,
        },
      ],
    };

    expect(() => processChanges(planWithBedroom, [
      { type: 'merge_rooms', rooms: ['Kitchen', 'Bedroom'], label: 'Merged', room_type: 'other' },
    ])).toThrow(/no shared wall/i);
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe('HighLevelChangeSchema', () => {
  it('parses valid resize_room', () => {
    const result = HighLevelChangeSchema.parse({
      type: 'resize_room',
      room: 'Kitchen',
      side: 'east',
      delta_cm: 50,
    });
    expect(result.type).toBe('resize_room');
  });

  it('rejects unknown type', () => {
    expect(() => HighLevelChangeSchema.parse({
      type: 'destroy_everything',
      room: 'Kitchen',
    })).toThrow();
  });

  it('parses place_furniture with named position', () => {
    const result = HighLevelChangeSchema.parse({
      type: 'place_furniture',
      furniture_type: 'fridge',
      room: 'Kitchen',
      position: 'ne',
    });
    expect(result.type).toBe('place_furniture');
  });

  it('parses place_furniture with explicit position', () => {
    const result = HighLevelChangeSchema.parse({
      type: 'place_furniture',
      furniture_type: 'fridge',
      room: 'Kitchen',
      position: { x: 50, y: 50 },
    });
    expect(result.type).toBe('place_furniture');
  });
});
