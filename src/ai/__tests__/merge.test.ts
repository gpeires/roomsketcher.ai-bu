// src/ai/__tests__/merge.test.ts
import { describe, it, expect } from 'vitest';
import { mergeResults } from '../merge';
import type {
  CVResult,
  GatherResults,
  RoomNamerResult,
  LayoutDescriberResult,
  SymbolSpotterResult,
  DimensionReaderResult,
  SpecialistFailure,
} from '../types';

function makeCv(rooms: CVResult['rooms'], meta?: Partial<CVResult['meta']>): CVResult {
  return {
    name: 'Test',
    rooms,
    meta: {
      walls_detected: 10,
      rooms_detected: rooms.length,
      text_regions: 5,
      scale_cm_per_px: 1.0,
      image_width: 900,
      image_height: 900,
      ...meta,
    },
  };
}

const fail = (specialist: string): SpecialistFailure => ({
  ok: false, specialist, error: 'test failure',
});

describe('mergeResults', () => {
  it('passes through CV rooms when all AI specialists fail', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 300, depth: 200 },
      { label: 'Room 2', x: 300, y: 0, width: 400, depth: 300 },
    ]);
    const results: GatherResults = {
      cv,
      roomNamer: fail('room_namer'),
      layoutDescriber: fail('layout_describer'),
      symbolSpotter: fail('symbol_spotter'),
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    expect(merged).toHaveLength(2);
    expect(merged[0].label).toBe('Room 1');
    expect(merged[0].confidence).toBeCloseTo(0.3); // CV-only confidence (no confidence field → default 0.3)
    expect(merged[0].sources).toEqual(['cv']);
  });

  it('uses CV confidence as starting confidence when provided', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 300, depth: 200, confidence: 0.9, found_by: ['raw', 'enhanced', 'otsu', 'adaptive_large', 'canny_dilate'] },
    ]);
    const results: GatherResults = {
      cv,
      roomNamer: fail('room_namer'),
      layoutDescriber: fail('layout_describer'),
      symbolSpotter: fail('symbol_spotter'),
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBeCloseTo(0.9); // CV confidence preserved, not reset to 0.3
  });

  it('assigns labels from Room Namer via spatial grid', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 200, depth: 200 },
    ]);
    const roomNamer: RoomNamerResult = { ok: true, labels: ['Kitchen'] };
    const layoutDescriber: LayoutDescriberResult = {
      ok: true,
      room_count: 1,
      rooms: [{ name: 'Kitchen', position: 'top-left', size: 'medium' }],
    };
    const results: GatherResults = {
      cv,
      roomNamer,
      layoutDescriber,
      symbolSpotter: fail('symbol_spotter'),
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    expect(merged[0].label).toBe('Kitchen');
    expect(merged[0].sources).toContain('room_namer');
  });

  it('uses symbol inference to assign room type', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 200, depth: 200 },
    ]);
    const symbolSpotter: SymbolSpotterResult = {
      ok: true,
      symbols: [{ type: 'Toilet', position: 'top-left' }, { type: 'Shower', position: 'top-left' }],
    };
    const results: GatherResults = {
      cv,
      roomNamer: fail('room_namer'),
      layoutDescriber: fail('layout_describer'),
      symbolSpotter,
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    expect(merged[0].label).toBe('Bathroom');
    expect(merged[0].sources).toContain('symbol_spotter');
  });

  it('flags suspiciously large rooms with split_hint', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 800, depth: 800 },
    ]);
    const symbolSpotter: SymbolSpotterResult = {
      ok: true,
      symbols: [
        { type: 'Toilet', position: 'top-left' },
        { type: 'Bed', position: 'bottom-right' },
      ],
    };
    const layoutDescriber: LayoutDescriberResult = {
      ok: true,
      room_count: 3,
      rooms: [
        { name: 'Bathroom', position: 'top-left', size: 'small' },
        { name: 'Bedroom', position: 'bottom-right', size: 'large' },
        { name: 'Kitchen', position: 'center', size: 'medium' },
      ],
    };
    const results: GatherResults = {
      cv,
      roomNamer: fail('room_namer'),
      layoutDescriber,
      symbolSpotter,
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    expect(merged[0].split_hint).toBe(true);
    expect(merged[0].split_evidence).toBeDefined();
  });

  it('boosts confidence when multiple sources agree on label', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 200, depth: 200 },
    ]);
    const roomNamer: RoomNamerResult = { ok: true, labels: ['Kitchen'] };
    const layoutDescriber: LayoutDescriberResult = {
      ok: true,
      room_count: 1,
      rooms: [{ name: 'Kitchen', position: 'top-left', size: 'medium' }],
    };
    const symbolSpotter: SymbolSpotterResult = {
      ok: true,
      symbols: [{ type: 'Stove', position: 'top-left' }],
    };
    const dimensionReader: DimensionReaderResult = {
      ok: true,
      dimensions: [{ text: "10' x 8'", room_or_area: 'Kitchen' }],
    };
    const results: GatherResults = {
      cv, roomNamer, layoutDescriber, symbolSpotter, dimensionReader,
    };
    const merged = mergeResults(results);
    expect(merged[0].label).toBe('Kitchen');
    expect(merged[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(merged[0].sources).toContain('cv');
    expect(merged[0].sources).toContain('room_namer');
    expect(merged[0].sources).toContain('symbol_spotter');
    expect(merged[0].sources).toContain('dimension_reader');
  });

  it('trusts higher room count from Layout Describer over CV', () => {
    const cv = makeCv([
      { label: 'Room 1', x: 0, y: 0, width: 300, depth: 200 },
      { label: 'Room 2', x: 300, y: 0, width: 300, depth: 200 },
    ]);
    const layoutDescriber: LayoutDescriberResult = {
      ok: true,
      room_count: 5,
      rooms: [
        { name: 'Kitchen', position: 'top-left', size: 'medium' },
        { name: 'Bedroom', position: 'top-right', size: 'medium' },
        { name: 'Bathroom', position: 'center', size: 'small' },
        { name: 'Living Room', position: 'bottom-left', size: 'large' },
        { name: 'Foyer', position: 'bottom-right', size: 'small' },
      ],
    };
    const results: GatherResults = {
      cv,
      roomNamer: fail('room_namer'),
      layoutDescriber,
      symbolSpotter: fail('symbol_spotter'),
      dimensionReader: fail('dimension_reader'),
    };
    const merged = mergeResults(results);
    // We still only have 2 CV rooms — can't invent geometry
    expect(merged).toHaveLength(2);
    // At least one room should have a split_hint since CV < AI count significantly
    const hasHint = merged.some((r) => r.split_hint);
    expect(hasHint).toBe(true);
  });
});
