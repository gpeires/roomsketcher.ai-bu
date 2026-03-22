// src/ai/convert.ts
// Deterministic conversion from CV output → SimpleFloorPlanInput
// Maps CV room data directly to sketch input format.

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

// ─── CV-only converter (no PipelineOutput dependency) ───────────────────────

interface CVAnalyzeResult {
  name: string;
  rooms: Array<{
    label: string;
    x: number;
    y: number;
    width: number;
    depth: number;
    polygon?: Array<{ x: number; y: number }>;
  }>;
  openings?: Array<Record<string, unknown>>;
  meta: {
    wall_thickness?: { thin_cm: number; thick_cm: number };
  };
}

export function cvToSketchInput(cv: CVAnalyzeResult): SimpleFloorPlanInput {
  const rooms: SimpleRoomInput[] = cv.rooms.map((room) => {
    const base = {
      label: room.label,
      type: inferRoomType(room.label),
    };
    // Use polygon format if available, otherwise rect
    if (room.polygon && room.polygon.length > 2) {
      return { ...base, polygon: room.polygon };
    }
    return { ...base, x: room.x, y: room.y, width: room.width, depth: room.depth };
  });

  const openings = Array.isArray(cv.openings)
    ? cv.openings.filter((o): o is Record<string, unknown> =>
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

  const wt = cv.meta.wall_thickness;
  const wallThickness = wt ? { interior: wt.thin_cm, exterior: wt.thick_cm } : undefined;

  return {
    name: cv.name,
    units: 'metric',
    rooms,
    openings: openings.length > 0 ? openings : undefined,
    ...(wallThickness ? { wallThickness } : {}),
  };
}
