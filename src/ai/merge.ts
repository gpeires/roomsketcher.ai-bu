// src/ai/merge.ts
import type {
  GatherResults,
  MergedRoom,
  GridPosition,
  CVRoom,
  LayoutDescriberResult,
  SymbolSpotterResult,
  DimensionReaderResult,
} from './types';
import { SYMBOL_ROOM_MAP } from './types';

// ─── Spatial grid mapping ────────────────────────────────────────────────────

const GRID_POSITIONS: GridPosition[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

function roomToGridPosition(
  room: CVRoom,
  imageWidth: number,
  imageHeight: number,
): GridPosition {
  const cx = room.x + room.width / 2;
  const cy = room.y + room.depth / 2;

  const col = cx < imageWidth / 3 ? 0 : cx < (2 * imageWidth) / 3 ? 1 : 2;
  const row = cy < imageHeight / 3 ? 0 : cy < (2 * imageHeight) / 3 ? 1 : 2;

  return GRID_POSITIONS[row * 3 + col];
}

function normalizePosition(pos: string): GridPosition {
  const normalized = pos.toLowerCase().replace(/\s+/g, '-');
  if (GRID_POSITIONS.includes(normalized as GridPosition)) {
    return normalized as GridPosition;
  }
  if (normalized === 'top') return 'top-center';
  if (normalized === 'bottom') return 'bottom-center';
  if (normalized === 'left') return 'center-left';
  if (normalized === 'right') return 'center-right';
  return 'center';
}

// ─── Label assignment ────────────────────────────────────────────────────────

function inferLabelFromSymbols(
  roomGrid: GridPosition,
  symbols: SymbolSpotterResult['symbols'],
): { label: string; evidence: string[] } | null {
  const matchingSymbols = symbols.filter(
    (s) => normalizePosition(s.position) === roomGrid,
  );
  if (matchingSymbols.length === 0) return null;

  const votes: Record<string, string[]> = {};
  for (const sym of matchingSymbols) {
    const roomType = SYMBOL_ROOM_MAP[sym.type];
    if (roomType) {
      if (!votes[roomType]) votes[roomType] = [];
      votes[roomType].push(sym.type);
    }
  }

  let bestType: string | null = null;
  let bestCount = 0;
  let bestEvidence: string[] = [];
  for (const [type, evidence] of Object.entries(votes)) {
    if (evidence.length > bestCount) {
      bestType = type;
      bestCount = evidence.length;
      bestEvidence = evidence;
    }
  }

  return bestType ? { label: bestType, evidence: bestEvidence } : null;
}

function findIncompatibleSymbols(
  roomGrid: GridPosition,
  symbols: SymbolSpotterResult['symbols'],
): string[] {
  const matchingSymbols = symbols.filter(
    (s) => normalizePosition(s.position) === roomGrid,
  );
  const roomTypes = new Set<string>();
  for (const sym of matchingSymbols) {
    const roomType = SYMBOL_ROOM_MAP[sym.type];
    if (roomType) roomTypes.add(roomType);
  }
  return roomTypes.size > 1 ? [...roomTypes] : [];
}

// ─── Main merge ──────────────────────────────────────────────────────────────

export function mergeResults(gather: GatherResults): MergedRoom[] {
  const { cv } = gather;
  const imageWidth = cv.meta.image_width ?? 900;
  const imageHeight = cv.meta.image_height ?? 900;

  const layoutDescriber = gather.layoutDescriber.ok ? gather.layoutDescriber as LayoutDescriberResult : null;
  const symbolSpotter = gather.symbolSpotter.ok ? gather.symbolSpotter as SymbolSpotterResult : null;
  const roomNamer = gather.roomNamer.ok ? gather.roomNamer : null;
  const dimensionReader = gather.dimensionReader.ok ? gather.dimensionReader as DimensionReaderResult : null;

  const expectedCount = layoutDescriber
    ? Math.max(cv.rooms.length, layoutDescriber.room_count)
    : cv.rooms.length;

  return cv.rooms.map((room) => {
    const gridPos = roomToGridPosition(room, imageWidth, imageHeight);
    const sources: string[] = ['cv'];
    let label = room.label;
    let confidence = 0.3;
    let split_hint = false;
    let split_evidence: string[] | undefined;

    // NOTE: Spec priority #1 is Tesseract text-position matching, but the CV
    // service currently returns text_regions as a count, not pixel coordinates.
    // When the CV service is updated to return text positions, add OCR-based
    // label assignment here before symbol inference.

    // 1. Symbol-based inference
    if (symbolSpotter) {
      const symbolInference = inferLabelFromSymbols(gridPos, symbolSpotter.symbols);
      if (symbolInference) {
        label = symbolInference.label;
        sources.push('symbol_spotter');
        confidence += 0.2;
      }

      const incompatible = findIncompatibleSymbols(gridPos, symbolSpotter.symbols);
      if (incompatible.length > 1) {
        split_hint = true;
        split_evidence = incompatible;
      }
    }

    // 2. Room Namer + Layout Describer position matching
    if (roomNamer && layoutDescriber) {
      const matchingLayoutRoom = layoutDescriber.rooms.find(
        (lr) => normalizePosition(lr.position) === gridPos,
      );
      if (matchingLayoutRoom) {
        const namerHasLabel = roomNamer.labels.some(
          (l) => l.toLowerCase() === matchingLayoutRoom.name.toLowerCase(),
        );
        if (namerHasLabel) {
          if (!sources.includes('symbol_spotter') || label === matchingLayoutRoom.name) {
            label = matchingLayoutRoom.name;
          }
          sources.push('room_namer');
          confidence += 0.2;
        }
      }
    } else if (roomNamer && !layoutDescriber) {
      const directMatch = roomNamer.labels.find(
        (l) => l.toLowerCase() === room.label.toLowerCase(),
      );
      if (directMatch) {
        label = directMatch;
        sources.push('room_namer');
        confidence += 0.2;
      }
    }

    // 3. Dimension binding
    if (dimensionReader) {
      const dimMatch = dimensionReader.dimensions.find(
        (d) => d.room_or_area.toLowerCase() === label.toLowerCase(),
      );
      if (dimMatch) {
        sources.push('dimension_reader');
        confidence += 0.15;
      }
    }

    // 4. Multi-source agreement bonus
    if (sources.length >= 3) {
      confidence += 0.15;
    }

    // 5. Room count discrepancy → flag large rooms for splitting
    if (expectedCount > cv.rooms.length) {
      const roomArea = room.width * room.depth;
      const imageArea = imageWidth * imageHeight;
      const avgExpectedArea = imageArea / expectedCount;
      // Flag if this room is larger than expected average, OR if AI sees
      // significantly more rooms (2x+) — in that case flag the largest CV rooms
      const significantDiscrepancy = expectedCount >= cv.rooms.length * 2;
      const isLargestRoom = cv.rooms.every((r) => room.width * room.depth >= r.width * r.depth);
      if (roomArea > avgExpectedArea * 1.5 || (significantDiscrepancy && isLargestRoom)) {
        split_hint = true;
        if (!split_evidence) {
          split_evidence = [`CV: ${cv.rooms.length} rooms, AI: ${expectedCount} rooms`];
        }
      }
    }

    return {
      label,
      x: room.x,
      y: room.y,
      width: room.width,
      depth: room.depth,
      type: label.toLowerCase().replace(/\s+/g, '_'),
      confidence: Math.min(confidence, 1.0),
      sources,
      ...(split_hint ? { split_hint, split_evidence } : {}),
    };
  });
}
