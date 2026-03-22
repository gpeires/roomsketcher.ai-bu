// src/ai/__tests__/orchestrator.test.ts
import { describe, it, expect } from 'vitest';
import { buildPipelineOutput, tierRooms, reconcileHintBank } from '../orchestrator';
import type { CVResult, CVRoom, MergedRoom } from '../types';

describe('buildPipelineOutput', () => {
  it('constructs output with meta fields', () => {
    const rooms: MergedRoom[] = [
      {
        label: 'Kitchen', x: 0, y: 0, width: 300, depth: 200,
        type: 'kitchen', confidence: 0.85, sources: ['cv', 'room_namer'],
      },
    ];
    const cv: CVResult = {
      name: 'Test',
      rooms: [{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 200 }],
      meta: { walls_detected: 10, rooms_detected: 1, text_regions: 3, scale_cm_per_px: 1.0, image_width: 900, image_height: 900 },
    };

    const output = buildPipelineOutput(
      'Test Plan', rooms, cv,
      { corrections: 1, passes: 1, neuronsUsed: 1400, succeeded: ['room_namer'], failed: ['symbol_spotter'] },
    );

    expect(output.name).toBe('Test Plan');
    expect(output.rooms).toHaveLength(1);
    expect(output.rooms[0].confidence).toBe(0.85);
    expect(output.meta.pipeline_version).toBe('2.0');
    expect(output.meta.ai_corrections).toBe(1);
    expect(output.meta.specialists_succeeded).toContain('room_namer');
    expect(output.meta.specialists_failed).toContain('symbol_spotter');
    // Raw CV data surfaced in meta
    expect(output.meta.cv_rooms_raw).toEqual([{ label: 'Kitchen', x: 0, y: 0, width: 300, depth: 200 }]);
    expect(output.meta.cv_rooms_detected).toBe(1);
    expect(output.meta.cv_preprocessing).toBeUndefined();
  });

  it('surfaces CV openings, adjacency, and preprocessing when present', () => {
    const rooms: MergedRoom[] = [];
    const cv: CVResult = {
      name: 'Test',
      rooms: [],
      meta: {
        walls_detected: 5, rooms_detected: 0, text_regions: 0, scale_cm_per_px: 1.0,
        image_size: [800, 600],
        preprocessing: { strategy_used: 'multi_strategy_merge', anchor_strategy: 'enhanced', strategies_run: 21, strategies_contributing: 15 },
      },
      openings: [{ type: 'door', x: 100, y: 200 }],
      adjacency: [{ from: 'Kitchen', to: 'Living' }],
    };

    const output = buildPipelineOutput('Test', rooms, cv, {
      corrections: 0, passes: 0, neuronsUsed: 0, succeeded: [], failed: [],
    });

    expect(output.openings).toEqual([{ type: 'door', x: 100, y: 200 }]);
    expect(output.adjacency).toEqual([{ from: 'Kitchen', to: 'Living' }]);
    expect(output.meta.cv_preprocessing).toEqual({
      strategy_used: 'multi_strategy_merge', anchor_strategy: 'enhanced', strategies_run: 21, strategies_contributing: 15,
    });
  });
});

describe('tierRooms', () => {
  const makeRoom = (label: string, confidence: number): CVRoom => ({
    label, x: 0, y: 0, width: 100, depth: 100, confidence,
  });

  it('splits rooms by confidence threshold (0.5)', () => {
    const rooms: CVRoom[] = [
      makeRoom('Kitchen', 0.9),
      makeRoom('Living Room', 0.7),
      makeRoom('Room 3', 0.3),
      makeRoom('Room 4', 0.4),
    ];
    const { forAI, hintBank } = tierRooms(rooms);
    expect(forAI).toHaveLength(2);
    expect(hintBank).toHaveLength(2);
    expect(forAI.map((r) => r.label)).toEqual(['Kitchen', 'Living Room']);
    expect(hintBank.map((r) => r.label)).toEqual(['Room 3', 'Room 4']);
  });

  it('rooms with confidence exactly 0.5 go to forAI', () => {
    const rooms: CVRoom[] = [makeRoom('Bedroom', 0.5)];
    const { forAI, hintBank } = tierRooms(rooms);
    expect(forAI).toHaveLength(1);
    expect(hintBank).toHaveLength(0);
  });

  it('rooms without confidence default to forAI', () => {
    const rooms: CVRoom[] = [{ label: 'Kitchen', x: 0, y: 0, width: 100, depth: 100 }];
    const { forAI, hintBank } = tierRooms(rooms);
    expect(forAI).toHaveLength(1);
    expect(hintBank).toHaveLength(0);
  });

  it('all low-confidence rooms go to hint bank', () => {
    const rooms: CVRoom[] = [makeRoom('A', 0.3), makeRoom('B', 0.3)];
    const { forAI, hintBank } = tierRooms(rooms);
    expect(forAI).toHaveLength(0);
    expect(hintBank).toHaveLength(2);
  });
});

describe('reconcileHintBank', () => {
  const makeMerged = (label: string, x: number, y: number, w: number, d: number): MergedRoom => ({
    label, x, y, width: w, depth: d,
    type: label.toLowerCase(), confidence: 0.8, sources: ['cv', 'room_namer'],
  });

  const makeHint = (label: string, x: number, y: number, w: number, d: number, conf = 0.3): CVRoom => ({
    label, x, y, width: w, depth: d, confidence: conf,
  });

  it('promotes hint bank room that overlaps an AI-detected room', () => {
    const merged = [makeMerged('Kitchen', 10, 10, 200, 150)];
    const hints = [makeHint('Room 2', 10, 10, 190, 140)];
    const result = reconcileHintBank(merged, hints, [900, 600]);
    // The overlapping hint is NOT added as a separate room — it's the same room
    expect(result).toHaveLength(1);
  });

  it('adds non-overlapping hint bank rooms with promoted confidence', () => {
    const merged = [makeMerged('Kitchen', 10, 10, 200, 150)];
    const hints = [makeHint('Room 2', 500, 300, 150, 100)];
    const result = reconcileHintBank(merged, hints, [900, 600]);
    expect(result).toHaveLength(2);
    expect(result[1].confidence).toBe(0.3); // keeps original low confidence
    expect(result[1].sources).toContain('cv_hint');
  });

  it('returns merged rooms unchanged when hint bank is empty', () => {
    const merged = [makeMerged('Kitchen', 10, 10, 200, 150)];
    const result = reconcileHintBank(merged, [], [900, 600]);
    expect(result).toHaveLength(1);
    expect(result).toEqual(merged);
  });

  it('does not duplicate rooms that significantly overlap existing merged rooms', () => {
    const merged = [makeMerged('Bedroom', 50, 50, 300, 200)];
    const hints = [makeHint('Room 1', 55, 55, 290, 190)];
    const result = reconcileHintBank(merged, hints, [900, 600]);
    expect(result).toHaveLength(1); // hint overlaps too much, skip
  });
});
