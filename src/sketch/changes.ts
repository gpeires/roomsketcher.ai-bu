import type { FloorPlan, Change } from './types';
import { shoelaceArea } from './geometry';

/**
 * Apply a list of changes to a FloorPlan. Returns a new object (shallow clone).
 * Ignores changes targeting nonexistent IDs.
 */
export function applyChanges(plan: FloorPlan, changes: Change[]): FloorPlan {
  if (changes.length === 0) return plan;

  // Shallow clone top-level arrays so we don't mutate the original
  const result: FloorPlan = {
    ...plan,
    walls: plan.walls.map(w => ({ ...w, openings: [...w.openings] })),
    rooms: [...plan.rooms],
    furniture: [...plan.furniture],
    metadata: { ...plan.metadata, updated_at: new Date().toISOString(), source: 'mixed' },
  };

  for (const change of changes) {
    switch (change.type) {
      case 'add_wall':
        result.walls.push({ ...change.wall, openings: [...change.wall.openings] });
        break;

      case 'move_wall': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        if (change.start) wall.start = change.start;
        if (change.end) wall.end = change.end;
        break;
      }

      case 'remove_wall':
        result.walls = result.walls.filter(w => w.id !== change.wall_id);
        break;

      case 'update_wall': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        if (change.thickness !== undefined) wall.thickness = change.thickness;
        if (change.wall_type !== undefined) wall.type = change.wall_type;
        break;
      }

      case 'add_opening': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        wall.openings.push(change.opening);
        break;
      }

      case 'remove_opening': {
        const wall = result.walls.find(w => w.id === change.wall_id);
        if (!wall) break;
        wall.openings = wall.openings.filter(o => o.id !== change.opening_id);
        break;
      }

      case 'add_room': {
        const room = { ...change.room };
        room.area = shoelaceArea(room.polygon);
        result.rooms.push(room);
        break;
      }

      case 'rename_room': {
        const room = result.rooms.find(r => r.id === change.room_id);
        if (!room) break;
        room.label = change.label;
        if (change.room_type !== undefined) room.type = change.room_type;
        break;
      }

      case 'remove_room':
        result.rooms = result.rooms.filter(r => r.id !== change.room_id);
        break;

      case 'add_furniture':
        result.furniture.push({ ...change.furniture });
        break;

      case 'move_furniture': {
        const item = result.furniture.find(f => f.id === change.furniture_id);
        if (!item) break;
        if (change.position) item.position = change.position;
        if (change.rotation !== undefined) item.rotation = change.rotation;
        break;
      }

      case 'remove_furniture':
        result.furniture = result.furniture.filter(f => f.id !== change.furniture_id);
        break;
    }
  }

  return result;
}
