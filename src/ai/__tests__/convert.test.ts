// src/ai/__tests__/convert.test.ts
import { describe, it, expect } from 'vitest';
import { pipelineToSketchInput } from '../convert';
import type { PipelineOutput } from '../types';

function makePipelineOutput(overrides: Partial<PipelineOutput> = {}): PipelineOutput {
  return {
    name: 'Test Plan',
    rooms: [
      { label: 'Living Room', x: 0, y: 0, width: 400, depth: 300, type: 'living_room', confidence: 0.8, sources: ['cv', 'room_namer'] },
      { label: 'Bedroom', x: 400, y: 0, width: 300, depth: 300, type: 'bedroom', confidence: 0.7, sources: ['cv'] },
      { label: 'Bathroom', x: 400, y: 300, width: 150, depth: 150, type: 'bathroom', confidence: 0.6, sources: ['cv', 'symbol_spotter'] },
    ],
    openings: [
      { type: 'door', between: ['Living Room', 'Bedroom'], width: 80 },
      { type: 'window', room: 'Living Room', wall: 'south', width: 120 },
    ],
    adjacency: [],
    meta: {
      image_size: [900, 900] as [number, number],
      scale_cm_per_px: 1.5,
      walls_detected: 10,
      rooms_detected: 3,
      ai_corrections: 0,
      validation_passes: 1,
      neurons_used: 500,
      pipeline_version: '2.0',
      specialists_succeeded: ['roomNamer'],
      specialists_failed: [],
    },
    ...overrides,
  };
}

describe('pipelineToSketchInput', () => {
  it('converts rooms to SimpleRectRoom format', () => {
    const result = pipelineToSketchInput(makePipelineOutput());
    expect(result.rooms).toHaveLength(3);
    expect(result.rooms[0]).toEqual({
      label: 'Living Room',
      type: 'living',
      x: 0,
      y: 0,
      width: 400,
      depth: 300,
    });
  });

  it('infers room types from labels', () => {
    const result = pipelineToSketchInput(makePipelineOutput());
    expect(result.rooms[0]).toHaveProperty('type', 'living');
    expect(result.rooms[1]).toHaveProperty('type', 'bedroom');
    expect(result.rooms[2]).toHaveProperty('type', 'bathroom');
  });

  it('passes through openings in correct format', () => {
    const result = pipelineToSketchInput(makePipelineOutput());
    expect(result.openings).toHaveLength(2);
    expect(result.openings![0]).toEqual({
      type: 'door',
      between: ['Living Room', 'Bedroom'],
      width: 80,
    });
    expect(result.openings![1]).toEqual({
      type: 'window',
      room: 'Living Room',
      wall: 'south',
      width: 120,
    });
  });

  it('sets name and units', () => {
    const result = pipelineToSketchInput(makePipelineOutput());
    expect(result.name).toBe('Test Plan');
    expect(result.units).toBe('metric');
  });

  it('includes wall thickness when available in meta', () => {
    const output = makePipelineOutput();
    (output.meta as Record<string, unknown>).wall_thickness = { thin_cm: 8, thick_cm: 18 };
    const result = pipelineToSketchInput(output);
    expect(result.wallThickness).toEqual({ interior: 8, exterior: 18 });
  });

  it('omits wall thickness when not in meta', () => {
    const result = pipelineToSketchInput(makePipelineOutput());
    expect(result.wallThickness).toBeUndefined();
  });

  it('handles empty openings', () => {
    const result = pipelineToSketchInput(makePipelineOutput({ openings: [] }));
    expect(result.openings).toBeUndefined();
  });

  it('handles rooms with unknown type labels', () => {
    const output = makePipelineOutput({
      rooms: [
        { label: 'Solarium', x: 0, y: 0, width: 200, depth: 200, type: 'solarium', confidence: 0.5, sources: ['cv'] },
      ],
    });
    const result = pipelineToSketchInput(output);
    expect(result.rooms[0]).toHaveProperty('type', 'other');
  });

  it('handles Primary Bedroom label', () => {
    const output = makePipelineOutput({
      rooms: [
        { label: 'Primary Bedroom', x: 0, y: 0, width: 400, depth: 300, type: 'primary_bedroom', confidence: 0.8, sources: ['cv'] },
      ],
    });
    const result = pipelineToSketchInput(output);
    expect(result.rooms[0]).toHaveProperty('type', 'bedroom');
  });
});
