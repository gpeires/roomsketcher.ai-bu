// src/ai/validate.ts
import type { MergedRoom, ValidatorResult, SpecialistFailure, GridPosition } from './types';
import { buildValidatorPrompt, callVisionSpecialist, parseValidatorResponse } from './specialists';
import { normalizePosition, estimateRoomGeometry } from './merge';

// ─── Correction application (deterministic, testable) ────────────────────────

export function applyCorrections(
  rooms: MergedRoom[],
  corrections: ValidatorResult['corrections'],
  imageSize?: [number, number],
): { rooms: MergedRoom[]; applied: number; unapplied: ValidatorResult['corrections'] } {
  let applied = 0;
  const unapplied: ValidatorResult['corrections'] = [];
  const updatedRooms = rooms.map((r) => ({ ...r }));

  for (const correction of corrections) {
    switch (correction.type) {
      case 'wrong_label': {
        const match = correction.description.match(/(\S+(?:\s+\S+)*?)\s+should be\s+(\S+(?:\s+\S+)*)/i);
        if (match) {
          const [, oldLabel, newLabel] = match;
          const room = updatedRooms.find(
            (r) => r.label.toLowerCase() === oldLabel.toLowerCase(),
          );
          if (room) {
            room.label = newLabel;
            room.type = newLabel.toLowerCase().replace(/\s+/g, '_');
            room.sources.push('validator');
            applied++;
            continue;
          }
        }
        unapplied.push(correction);
        break;
      }
      case 'split': {
        const match = correction.description.match(/(\S+(?:\s+\S+)*?)\s+(?:appears|seems|contains)/i);
        const room = match
          ? updatedRooms.find((r) => r.label.toLowerCase() === match[1].toLowerCase())
          : updatedRooms[0];
        if (room) {
          room.split_hint = true;
          room.split_evidence = [...(room.split_evidence ?? []), correction.description];
          applied++;
        } else {
          unapplied.push(correction);
        }
        break;
      }
      case 'missing_room': {
        // Parse: "Missing: {name} at {position}, size: {small|medium|large}"
        // Also handle freeform: "Missing {name}" or "{name} is missing"
        const structuredMatch = correction.description.match(
          /Missing:\s*(.+?)\s+at\s+([\w-]+)(?:,\s*size:\s*(small|medium|large))?/i,
        );
        const freeformMatch = !structuredMatch
          ? correction.description.match(/(?:Missing\s+|missing\s+)(.+?)(?:\s+at\s+([\w-]+))?$/i)
          : null;

        const match = structuredMatch || freeformMatch;
        if (match && imageSize) {
          const [, roomName, posStr, sizeStr] = match;
          const position = normalizePosition(posStr || 'center');
          const size = (sizeStr as 'small' | 'medium' | 'large') || 'small';
          const geo = estimateRoomGeometry(position, size, imageSize[0], imageSize[1]);

          // Don't add if a room with this label already exists
          const alreadyExists = updatedRooms.some(
            (r) => r.label.toLowerCase() === roomName.trim().toLowerCase(),
          );
          if (!alreadyExists) {
            updatedRooms.push({
              label: roomName.trim(),
              ...geo,
              type: roomName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_'),
              confidence: 0.4,
              sources: ['validator'],
            });
            applied++;
            continue;
          }
        }
        unapplied.push(correction);
        break;
      }
      case 'merge':
        unapplied.push(correction);
        break;
    }
  }

  return { rooms: updatedRooms, applied, unapplied };
}

// ─── Validation loop (calls AI) ─────────────────────────────────────────────

export async function validateMergedResults(
  rooms: MergedRoom[],
  imageBytes: Uint8Array,
  ai: Ai,
  model: string,
  timeoutMs: number,
  maxPasses: number,
  imageSize?: [number, number],
): Promise<{ rooms: MergedRoom[]; totalCorrections: number; passes: number }> {
  let currentRooms = rooms;
  let totalCorrections = 0;
  let passes = 0;

  for (let i = 0; i < maxPasses; i++) {
    passes++;
    const prompt = buildValidatorPrompt(currentRooms);

    let rawResponse: string;
    try {
      rawResponse = await callVisionSpecialist(ai, model, prompt, imageBytes, timeoutMs);
    } catch {
      break;
    }

    const parsed = parseValidatorResponse(rawResponse);
    if (!parsed.ok) break;
    if (parsed.correct || parsed.corrections.length === 0) break;

    const { rooms: corrected, applied } = applyCorrections(currentRooms, parsed.corrections, imageSize);
    totalCorrections += applied;
    currentRooms = corrected;

    const hasMajor = parsed.corrections.some(
      (c) => c.type === 'missing_room' || c.type === 'split',
    );
    if (!hasMajor) break;
  }

  return { rooms: currentRooms, totalCorrections, passes };
}
