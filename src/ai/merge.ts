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

// ─── Fixture / abbreviation filter ───────────────────────────────────────────
// These appear as text labels on floor plans but are NOT room names.
const FIXTURE_LABELS = new Set([
  'w/d', 'wd', 'dw', 'ref', 'ac', 'wh', 'hw', 'mech',
  'stove', 'range', 'fridge', 'dishwasher', 'oven',
]);

function isFixtureLabel(label: string): boolean {
  return FIXTURE_LABELS.has(label.toLowerCase().replace(/[^a-z/]/g, ''));
}

// ─── Spatial grid mapping ────────────────────────────────────────────────────

const GRID_POSITIONS: GridPosition[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/** Compute bounding box from polygon if x/y/width/depth are missing */
function normalizeCVRoom(room: CVRoom): CVRoom & { x: number; y: number; width: number; depth: number } {
  if (room.x !== undefined && room.y !== undefined && room.width > 0 && room.depth > 0) {
    return room as CVRoom & { x: number; y: number; width: number; depth: number };
  }
  if (room.polygon && room.polygon.length > 0) {
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      ...room,
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      depth: Math.max(...ys) - minY,
    };
  }
  return { ...room, x: room.x ?? 0, y: room.y ?? 0, width: room.width ?? 100, depth: room.depth ?? 100 };
}

function roomToGridPosition(
  room: { x: number; y: number; width: number; depth: number },
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

// ─── Centroid / distance helpers ─────────────────────────────────────────────

function roomCentroid(room: { x: number; y: number; width: number; depth: number }): { cx: number; cy: number } {
  return { cx: room.x + room.width / 2, cy: room.y + room.depth / 2 };
}

function positionToCentroid(
  position: string,
  imageWidth: number,
  imageHeight: number,
): { cx: number; cy: number } {
  const grid = normalizePosition(position);
  const col = GRID_POSITIONS.indexOf(grid) % 3;
  const row = Math.floor(GRID_POSITIONS.indexOf(grid) / 3);
  const cellW = imageWidth / 3;
  const cellH = imageHeight / 3;
  return { cx: col * cellW + cellW / 2, cy: row * cellH + cellH / 2 };
}

function centroidDistance(
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): number {
  return Math.sqrt((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2);
}

/** Check if a symbol's estimated position falls within a room's bounding box (with margin) */
function symbolNearRoom(
  symPosition: string,
  room: { x: number; y: number; width: number; depth: number },
  imageWidth: number,
  imageHeight: number,
): boolean {
  const symCenter = positionToCentroid(symPosition, imageWidth, imageHeight);
  const margin = Math.min(imageWidth, imageHeight) * 0.1;
  return (
    symCenter.cx >= room.x - margin &&
    symCenter.cx <= room.x + room.width + margin &&
    symCenter.cy >= room.y - margin &&
    symCenter.cy <= room.y + room.depth + margin
  );
}

// ─── Partial label normalization ────────────────────────────────────────────

const LABEL_FRAGMENTS: Record<string, string> = {
  'bed': 'Bedroom',
  'bath': 'Bathroom',
  'kit': 'Kitchen',
  'liv': 'Living Room',
  'din': 'Dining Room',
};

function normalizeFragmentLabel(label: string): string {
  const lower = label.toLowerCase().trim();
  return LABEL_FRAGMENTS[lower] ?? label;
}

// ─── Size estimation from layout describer ───────────────────────────────────

const SIZE_FACTORS: Record<string, number> = { small: 0.6, medium: 1.0, large: 1.5 };

function estimateRoomGeometry(
  position: GridPosition,
  size: 'small' | 'medium' | 'large',
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; depth: number } {
  const col = GRID_POSITIONS.indexOf(position) % 3;
  const row = Math.floor(GRID_POSITIONS.indexOf(position) / 3);
  const cellW = imageWidth / 3;
  const cellH = imageHeight / 3;
  const factor = SIZE_FACTORS[size] ?? 1.0;
  const w = cellW * factor * 0.8;
  const d = cellH * factor * 0.8;
  return {
    x: Math.round(col * cellW + (cellW - w) / 2),
    y: Math.round(row * cellH + (cellH - d) / 2),
    width: Math.round(w),
    depth: Math.round(d),
  };
}

// ─── Label assignment ────────────────────────────────────────────────────────

function inferLabelFromSymbols(
  room: { x: number; y: number; width: number; depth: number },
  symbols: SymbolSpotterResult['symbols'],
  imageWidth: number,
  imageHeight: number,
): { label: string; evidence: string[] } | null {
  const matchingSymbols = symbols.filter(
    (s) => symbolNearRoom(s.position, room, imageWidth, imageHeight),
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
  room: { x: number; y: number; width: number; depth: number },
  symbols: SymbolSpotterResult['symbols'],
  imageWidth: number,
  imageHeight: number,
): string[] {
  const matchingSymbols = symbols.filter(
    (s) => symbolNearRoom(s.position, room, imageWidth, imageHeight),
  );
  const roomTypes = new Set<string>();
  for (const sym of matchingSymbols) {
    const roomType = SYMBOL_ROOM_MAP[sym.type];
    if (roomType) roomTypes.add(roomType);
  }
  return roomTypes.size > 1 ? [...roomTypes] : [];
}

// ─── Label matching helpers ──────────────────────────────────────────────────

/** Fuzzy match: "Living & Dining" matches "Living Room", "Dining Room", etc.
 *  Also normalizes fragments: "Bed" → "Bedroom", "Bath" → "Bathroom" */
function labelsMatch(a: string, b: string): boolean {
  const normA = normalizeFragmentLabel(a);
  const normB = normalizeFragmentLabel(b);
  const na = normA.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = normB.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (na === nb) return true;
  // Partial match — one contains the other's main word
  const wordsA = normA.toLowerCase().split(/[\s&,]+/).filter((w) => w.length > 2);
  const wordsB = normB.toLowerCase().split(/[\s&,]+/).filter((w) => w.length > 2);
  return wordsA.some((w) => wordsB.includes(w));
}

/** Is this a real room label (not "Room 1", "Room 2", etc.)? */
function isGenericLabel(label: string): boolean {
  return /^Room\s+\d+$/i.test(label);
}

// ─── Main merge ──────────────────────────────────────────────────────────────

export function mergeResults(gather: GatherResults): MergedRoom[] {
  const { cv } = gather;
  const imageWidth = cv.meta.image_size?.[0] ?? cv.meta.image_width ?? 900;
  const imageHeight = cv.meta.image_size?.[1] ?? cv.meta.image_height ?? 900;

  const layoutDescriber = gather.layoutDescriber.ok ? gather.layoutDescriber as LayoutDescriberResult : null;
  const symbolSpotter = gather.symbolSpotter.ok ? gather.symbolSpotter as SymbolSpotterResult : null;
  const roomNamer = gather.roomNamer.ok ? gather.roomNamer : null;
  const dimensionReader = gather.dimensionReader.ok ? gather.dimensionReader as DimensionReaderResult : null;

  // Filter fixture labels from room_namer output
  const cleanedNamerLabels = roomNamer
    ? roomNamer.labels.filter((l) => !isFixtureLabel(l))
    : [];

  // Normalize CV rooms (handle polygon-only rooms)
  const normalizedCVRooms = cv.rooms.map(normalizeCVRoom);

  // Track claimed labels — prevent the same label being assigned to multiple CV rooms
  const claimedLabels = new Set<string>();
  // Track which AI layout rooms are matched to CV rooms
  const matchedLayoutIndices = new Set<number>();

  // ── Phase 1: Enrich CV rooms with AI data ──────────────────────────────────

  const mergedRooms: MergedRoom[] = normalizedCVRooms.map((room) => {
    const sources: string[] = ['cv'];
    let label = room.label;
    let confidence = 0.3;
    let split_hint = false;
    let split_evidence: string[] | undefined;

    // If CV already has a real label (not "Room N"), trust it as strong signal
    const cvHasRealLabel = !isGenericLabel(room.label);

    // 1. Try direct label match from room_namer (CV label matches an AI label)
    if (cvHasRealLabel && cleanedNamerLabels.length > 0) {
      const directMatch = cleanedNamerLabels.find((l) => labelsMatch(l, room.label));
      if (directMatch && !claimedLabels.has(directMatch.toLowerCase())) {
        label = directMatch;
        claimedLabels.add(directMatch.toLowerCase());
        sources.push('room_namer');
        confidence += 0.2;
      }
    }

    // 2. Symbol-based inference (bounding-box proximity, not grid)
    if (symbolSpotter) {
      const symbolInference = inferLabelFromSymbols(room, symbolSpotter.symbols, imageWidth, imageHeight);
      if (symbolInference) {
        // Symbol inference overrides generic labels, but not named CV labels
        if (isGenericLabel(label)) {
          if (!claimedLabels.has(symbolInference.label.toLowerCase())) {
            label = symbolInference.label;
            claimedLabels.add(symbolInference.label.toLowerCase());
          }
        }
        sources.push('symbol_spotter');
        confidence += 0.2;
      }

      const incompatible = findIncompatibleSymbols(room, symbolSpotter.symbols, imageWidth, imageHeight);
      if (incompatible.length > 1) {
        split_hint = true;
        split_evidence = incompatible;
      }
    }

    // 3. Layout Describer matching — centroid distance + label scoring
    if (layoutDescriber) {
      const cvCenter = roomCentroid(room);
      const maxDist = Math.sqrt(imageWidth ** 2 + imageHeight ** 2); // image diagonal
      let bestLayoutIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < layoutDescriber.rooms.length; i++) {
        if (matchedLayoutIndices.has(i)) continue;
        const lr = layoutDescriber.rooms[i];
        if (isFixtureLabel(lr.name)) continue;
        const lrCenter = positionToCentroid(lr.position, imageWidth, imageHeight);
        const dist = centroidDistance(cvCenter, lrCenter);
        let score = 0;

        // Proximity score — closer = more points (using image diagonal as reference)
        if (dist < maxDist / 6) score += 3;
        else if (dist < maxDist / 3) score += 2;
        else if (dist < maxDist / 2) score += 1;

        // Label match with current label (normalizes fragments too)
        if (labelsMatch(lr.name, label)) score += 3;
        // Label confirmed by room_namer
        if (cleanedNamerLabels.some((l) => labelsMatch(l, lr.name))) score += 1;

        if (score > bestScore) {
          bestScore = score;
          bestLayoutIdx = i;
        }
      }

      if (bestLayoutIdx >= 0 && bestScore >= 2) {
        matchedLayoutIndices.add(bestLayoutIdx);
        const lr = layoutDescriber.rooms[bestLayoutIdx];
        const normalizedName = normalizeFragmentLabel(lr.name);
        // Use layout name if current label is generic and this label isn't claimed
        if (isGenericLabel(label) && !claimedLabels.has(normalizedName.toLowerCase())) {
          label = normalizedName;
          claimedLabels.add(normalizedName.toLowerCase());
        } else if (bestScore >= 5 && !claimedLabels.has(normalizedName.toLowerCase())) {
          // Very strong match — override even named labels
          label = normalizedName;
          claimedLabels.add(normalizedName.toLowerCase());
        }
        if (!sources.includes('room_namer')) sources.push('room_namer');
        confidence += 0.15;
      }
    }

    // 4. Dimension binding
    if (dimensionReader) {
      const dimMatch = dimensionReader.dimensions.find(
        (d) => labelsMatch(d.room_or_area, label),
      );
      if (dimMatch) {
        sources.push('dimension_reader');
        confidence += 0.15;
      }
    }

    // 5. Multi-source agreement bonus
    if (sources.length >= 3) {
      confidence += 0.15;
    }

    // 6. Room count discrepancy → flag rooms for potential splitting
    if (layoutDescriber && layoutDescriber.room_count > normalizedCVRooms.length) {
      const roomArea = room.width * room.depth;
      const imageArea = imageWidth * imageHeight;
      const avgExpectedArea = imageArea / layoutDescriber.room_count;
      const significantDiscrepancy = layoutDescriber.room_count >= normalizedCVRooms.length * 2;
      const isLargest = normalizedCVRooms.every((r) => room.width * room.depth >= r.width * r.depth);
      if (roomArea > avgExpectedArea * 1.5 || (significantDiscrepancy && isLargest)) {
        split_hint = true;
        if (!split_evidence) {
          split_evidence = [`CV: ${normalizedCVRooms.length} rooms, AI: ${layoutDescriber.room_count} rooms`];
        }
      }
    }

    return {
      label,
      x: room.x,
      y: room.y,
      width: room.width,
      depth: room.depth,
      type: label.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_'),
      confidence: Math.min(confidence, 1.0),
      sources,
      ...(split_hint ? { split_hint, split_evidence } : {}),
    };
  });

  // ── Phase 2: Add AI-only rooms (no CV polygon) ────────────────────────────

  if (layoutDescriber) {
    for (let i = 0; i < layoutDescriber.rooms.length; i++) {
      if (matchedLayoutIndices.has(i)) continue;

      const lr = layoutDescriber.rooms[i];
      if (isFixtureLabel(lr.name)) continue;

      // Require room_namer confirmation
      const namerConfirms = cleanedNamerLabels.some((l) => labelsMatch(l, lr.name));
      if (!namerConfirms) continue;

      // Don't add if a CV room already has this exact label
      const alreadyLabeled = mergedRooms.some((r) => r.label.toLowerCase() === lr.name.toLowerCase());
      if (alreadyLabeled) continue;

      // Allow rooms with similar labels if they're at different positions
      // (e.g., "Bedroom" can appear multiple times at different grid positions)
      const gridPos = normalizePosition(lr.position);
      const sameNameSameGrid = mergedRooms.some(
        (r) => labelsMatch(r.label, lr.name) &&
          roomToGridPosition(r, imageWidth, imageHeight) === gridPos,
      );
      if (sameNameSameGrid) continue;

      const geo = estimateRoomGeometry(gridPos, lr.size, imageWidth, imageHeight);
      const sources: string[] = ['room_namer', 'layout_describer'];
      let confidence = 0.5;

      // Check symbols (use estimated geometry for AI-only rooms)
      if (symbolSpotter) {
        const symbolInference = inferLabelFromSymbols(geo, symbolSpotter.symbols, imageWidth, imageHeight);
        if (symbolInference && labelsMatch(symbolInference.label, lr.name)) {
          sources.push('symbol_spotter');
          confidence += 0.15;
        }
      }

      // Check dimensions
      if (dimensionReader) {
        const dimMatch = dimensionReader.dimensions.find(
          (d) => labelsMatch(d.room_or_area, lr.name),
        );
        if (dimMatch) {
          sources.push('dimension_reader');
          confidence += 0.15;
        }
      }

      const normalizedName = normalizeFragmentLabel(lr.name);
      mergedRooms.push({
        label: normalizedName,
        ...geo,
        type: normalizedName.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_'),
        confidence: Math.min(confidence, 1.0),
        sources,
      });
    }
  }

  return mergedRooms;
}
