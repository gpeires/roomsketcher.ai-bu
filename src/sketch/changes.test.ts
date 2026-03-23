import { describe, it, expect } from 'vitest';
import { applyChanges } from './changes';
import type { FloorPlan, Change } from './types';

function makePlan(): FloorPlan {
  return {
    version: 1,
    id: 'test',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
    ],
    rooms: [
      { id: 'r1', label: 'Room', type: 'living', polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], color: '#E8F5E9' },
    ],
    furniture: [],
    annotations: [],
    metadata: { created_at: '', updated_at: '', source: 'ai' },
  };
}

describe('applyChanges', () => {
  it('adds a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_wall', wall: { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(2);
    expect(result.walls[1].id).toBe('w2');
  });

  it('moves a wall endpoint', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'move_wall', wall_id: 'w1', end: { x: 700, y: 0 } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].end.x).toBe(700);
    expect(result.walls[0].start.x).toBe(0); // unchanged
  });

  it('removes a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [{ type: 'remove_wall', wall_id: 'w1' }];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(0);
  });

  it('updates wall properties', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'update_wall', wall_id: 'w1', thickness: 10, wall_type: 'interior' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].thickness).toBe(10);
    expect(result.walls[0].type).toBe('interior');
  });

  it('adds an opening to a wall', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_opening', wall_id: 'w1', opening: { id: 'd1', type: 'door', offset: 100, width: 90, properties: { swingDirection: 'left' } } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].openings).toHaveLength(1);
    expect(result.walls[0].openings[0].id).toBe('d1');
  });

  it('removes an opening from a wall', () => {
    const plan = makePlan();
    plan.walls[0].openings = [{ id: 'd1', type: 'door', offset: 100, width: 90, properties: {} }];
    const changes: Change[] = [
      { type: 'remove_opening', wall_id: 'w1', opening_id: 'd1' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls[0].openings).toHaveLength(0);
  });

  it('adds a room', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_room', room: { id: 'r2', label: 'Bath', type: 'bathroom', polygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], color: '#E3F2FD' } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms).toHaveLength(2);
  });

  it('renames a room', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'rename_room', room_id: 'r1', label: 'Living Room', room_type: 'living' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms[0].label).toBe('Living Room');
  });

  it('removes a room', () => {
    const plan = makePlan();
    const changes: Change[] = [{ type: 'remove_room', room_id: 'r1' }];
    const result = applyChanges(plan, changes);
    expect(result.rooms).toHaveLength(0);
  });

  it('updates a room polygon', () => {
    const plan = makePlan();
    const newPolygon = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 400 }, { x: 0, y: 400 }];
    const changes: Change[] = [
      { type: 'update_room', room_id: 'r1', polygon: newPolygon },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms[0].polygon).toEqual(newPolygon);
    expect(result.rooms[0].area).toBeCloseTo(32, 0); // 800*400 cm² / 10000 = 32 m²
  });

  it('updates a room area only', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'update_room', room_id: 'r1', area: 25.5 },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms[0].area).toBe(25.5);
  });

  it('ignores update_room for nonexistent ID', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'update_room', room_id: 'nonexistent', polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] },
    ];
    const result = applyChanges(plan, changes);
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0].polygon).toHaveLength(4); // unchanged
  });

  it('applies multiple changes in order', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'add_wall', wall: { id: 'w2', start: { x: 600, y: 0 }, end: { x: 600, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] } },
      { type: 'remove_wall', wall_id: 'w1' },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(1);
    expect(result.walls[0].id).toBe('w2');
  });

  it('ignores changes targeting nonexistent IDs', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'move_wall', wall_id: 'nonexistent', end: { x: 999, y: 999 } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.walls).toHaveLength(1);
    expect(result.walls[0].end.x).toBe(600); // unchanged
  });

  it('adds furniture', () => {
    const plan = makePlan();
    const changes: Change[] = [
      {
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
      },
    ];
    const result = applyChanges(plan, changes);
    expect(result.furniture).toHaveLength(1);
    expect(result.furniture[0].id).toBe('f1');
  });

  it('moves furniture', () => {
    const plan = makePlan();
    plan.furniture = [
      { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
    ];
    const changes: Change[] = [
      { type: 'move_furniture', furniture_id: 'f1', position: { x: 200, y: 200 }, rotation: 90 },
    ];
    const result = applyChanges(plan, changes);
    expect(result.furniture[0].position).toEqual({ x: 200, y: 200 });
    expect(result.furniture[0].rotation).toBe(90);
  });

  it('removes furniture', () => {
    const plan = makePlan();
    plan.furniture = [
      { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
    ];
    const changes: Change[] = [{ type: 'remove_furniture', furniture_id: 'f1' }];
    const result = applyChanges(plan, changes);
    expect(result.furniture).toHaveLength(0);
  });

  it('ignores move_furniture for nonexistent ID', () => {
    const plan = makePlan();
    const changes: Change[] = [
      { type: 'move_furniture', furniture_id: 'nonexistent', position: { x: 999, y: 999 } },
    ];
    const result = applyChanges(plan, changes);
    expect(result.furniture).toHaveLength(0);
  });

  it('sets the envelope polygon', () => {
    const plan = makePlan();
    const envelope = [
      { x: 0, y: 0 }, { x: 500, y: 0 },
      { x: 500, y: 400 }, { x: 0, y: 400 },
    ];
    const result = applyChanges(plan, [
      { type: 'set_envelope', polygon: envelope },
    ]);
    expect(result.envelope).toEqual(envelope);
    expect(result.metadata.source).toBe('mixed');
  });

  it('replaces existing envelope', () => {
    const plan = makePlan();
    plan.envelope = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const newEnvelope = [
      { x: 0, y: 0 }, { x: 600, y: 0 },
      { x: 600, y: 500 }, { x: 0, y: 500 },
    ];
    const result = applyChanges(plan, [
      { type: 'set_envelope', polygon: newEnvelope },
    ]);
    expect(result.envelope).toEqual(newEnvelope);
  });
});
