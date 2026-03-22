// src/ai/convert.ts
// Deterministic conversion from PipelineOutput → SimpleFloorPlanInput
// Eliminates AI agent interpretation errors by mapping pipeline data directly.

import type { PipelineOutput, MergedRoom } from './types';
import type { SimpleFloorPlanInput, SimpleRoomInput, RoomType } from '../sketch/types';

// ─── Room type inference (mirrors compile-layout.ts inferRoomType) ───────────

const ROOM_TYPE_PATTERNS: [RegExp, RoomType][] = [
  [/bed|master|guest|nursery|primary/i, 'bedroom'],
  [/bath|shower|wc|powder|toilet/i, 'bathroom'],
  [/kitchen|pantry/i, 'kitchen'],
  [/living|lounge|family|great/i, 'living'],
  [/dining|breakfast/i, 'dining'],
  [/hall|corridor|entry|foyer|lobby/i, 'hallway'],
  [/office|study|den|library/i, 'office'],
  [/closet|wardrobe|dressing|storage/i, 'closet'],
  [/laundry|w\/d|washer|utility/i, 'laundry'],
  [/garage|carport/i, 'garage'],
  [/balcony|porch/i, 'balcony'],
  [/terrace|patio|deck/i, 'terrace'],
];

function inferRoomType(label: string): RoomType {
  for (const [pattern, type] of ROOM_TYPE_PATTERNS) {
    if (pattern.test(label)) return type;
  }
  return 'other';
}

// ─── Converter ──────────────────────────────────────────────────────────────

export function pipelineToSketchInput(output: PipelineOutput): SimpleFloorPlanInput {
  // Map rooms — use rect format (x/y/width/depth already in cm from CV)
  const rooms: SimpleRoomInput[] = output.rooms.map((room: MergedRoom) => ({
    label: room.label,
    type: inferRoomType(room.label),
    x: room.x,
    y: room.y,
    width: room.width,
    depth: room.depth,
  }));

  // Pass through openings (CV already outputs SimpleOpeningInput-compatible format)
  const openings = Array.isArray(output.openings)
    ? output.openings.filter((o): o is Record<string, unknown> =>
        typeof o === 'object' && o !== null && 'type' in o,
      ).map((o) => ({
        type: o.type as 'door' | 'window' | 'opening',
        ...(o.between ? { between: o.between as [string, string] } : {}),
        ...(o.room ? { room: o.room as string } : {}),
        ...(o.wall ? { wall: o.wall as 'north' | 'south' | 'east' | 'west' } : {}),
        ...(o.width ? { width: o.width as number } : {}),
        ...(o.position !== undefined ? { position: o.position as number } : {}),
      }))
    : [];

  // Extract wall thickness from meta if available
  const wallThicknessMeta = (output.meta as Record<string, unknown>).wall_thickness as
    | { thin_cm?: number; thick_cm?: number }
    | undefined;

  const wallThickness = wallThicknessMeta
    ? {
        interior: wallThicknessMeta.thin_cm,
        exterior: wallThicknessMeta.thick_cm,
      }
    : undefined;

  return {
    name: output.name,
    units: 'metric',
    rooms,
    openings: openings.length > 0 ? openings : undefined,
    ...(wallThickness ? { wallThickness } : {}),
  };
}
