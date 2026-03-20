// src/ai/__tests__/validate.test.ts
import { describe, it, expect } from 'vitest';
import { applyCorrections } from '../validate';
import type { MergedRoom, ValidatorResult } from '../types';

describe('applyCorrections', () => {
  const baseRoom: MergedRoom = {
    label: 'Room 1', x: 0, y: 0, width: 300, depth: 200,
    type: 'room_1', confidence: 0.5, sources: ['cv'],
  };

  it('renames a room when wrong_label correction matches', () => {
    const corrections: ValidatorResult['corrections'] = [
      { type: 'wrong_label', description: 'Room 1 should be Kitchen' },
    ];
    const result = applyCorrections([baseRoom], corrections);
    expect(result.rooms[0].label).toBe('Kitchen');
    expect(result.applied).toBe(1);
  });

  it('returns unchanged rooms when corrections are empty', () => {
    const result = applyCorrections([baseRoom], []);
    expect(result.rooms[0].label).toBe('Room 1');
    expect(result.applied).toBe(0);
  });

  it('flags missing room corrections without adding geometry', () => {
    const corrections: ValidatorResult['corrections'] = [
      { type: 'missing_room', description: 'Missing Bathroom between Kitchen and Bedroom' },
    ];
    const result = applyCorrections([baseRoom], corrections);
    expect(result.rooms).toHaveLength(1);
    expect(result.unapplied).toHaveLength(1);
  });

  it('handles split corrections by adding split_hint', () => {
    const corrections: ValidatorResult['corrections'] = [
      { type: 'split', description: 'Room 1 appears to contain both a bathroom and bedroom' },
    ];
    const result = applyCorrections([baseRoom], corrections);
    expect(result.rooms[0].split_hint).toBe(true);
    expect(result.applied).toBe(1);
  });
});
