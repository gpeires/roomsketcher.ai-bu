// src/ai/__tests__/orchestrator.test.ts
import { describe, it, expect } from 'vitest';
import { buildPipelineOutput } from '../orchestrator';
import type { CVResult, MergedRoom } from '../types';

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
  });
});
