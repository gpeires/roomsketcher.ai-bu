import type { FloorPlan, Wall, Room, FurnitureItem } from './types';
import type { FloorPlanInput } from './types';
import { boundingBox } from './geometry';

export const ROOM_COLORS: Record<string, string> = {
  living: '#E8F5E9',
  bedroom: '#E3F2FD',
  kitchen: '#FFF3E0',
  bathroom: '#E0F7FA',
  hallway: '#F5F5F5',
  office: '#F3E5F5',
  dining: '#FFF8E1',
  garage: '#EFEBE9',
  closet: '#ECEFF1',
  laundry: '#E8EAF6',
  balcony: '#F1F8E9',
  terrace: '#F1F8E9',
  storage: '#ECEFF1',
  utility: '#ECEFF1',
  other: '#FAFAFA',
};

const WALL_THICKNESS: Record<string, number> = {
  exterior: 20,
  interior: 10,
  divider: 5,
};

const DEFAULT_HEIGHT = 250;

export function applyDefaults(input: FloorPlanInput): FloorPlan {
  const now = new Date().toISOString();

  // Walls
  const walls: Wall[] = input.walls.map(w => ({
    ...w,
    thickness: w.thickness ?? WALL_THICKNESS[w.type] ?? 10,
    height: w.height ?? DEFAULT_HEIGHT,
    openings: w.openings.map(o => ({ ...o })),
  }));

  // Rooms
  const rooms: Room[] = input.rooms.map(r => ({
    ...r,
    color: r.color ?? ROOM_COLORS[r.type] ?? '#FAFAFA',
  }));

  // Furniture
  const furniture: FurnitureItem[] = input.furniture.map(f => ({
    ...f,
    rotation: f.rotation ?? 0,
  }));

  // Canvas
  const canvas = input.canvas ?? (() => {
    const bb = boundingBox(walls);
    const pad = 100;
    return {
      width: Math.max(bb.maxX - bb.minX + pad * 2, 400),
      height: Math.max(bb.maxY - bb.minY + pad * 2, 400),
      gridSize: 10,
    };
  })();

  // Metadata
  const metadata = {
    created_at: input.metadata?.created_at ?? now,
    updated_at: input.metadata?.updated_at ?? now,
    source: input.metadata?.source ?? 'ai' as const,
  };

  return {
    version: input.version,
    id: input.id,
    name: input.name,
    units: input.units,
    canvas,
    walls,
    rooms,
    furniture,
    annotations: input.annotations,
    metadata,
  };
}
