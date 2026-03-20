// src/ai/__tests__/specialists.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseRoomNamerResponse,
  parseLayoutDescriberResponse,
  parseSymbolSpotterResponse,
  parseDimensionReaderResponse,
  parseValidatorResponse,
} from '../specialists';

describe('parseRoomNamerResponse', () => {
  it('parses valid label array', () => {
    const result = parseRoomNamerResponse('["Bedroom", "Kitchen", "Living Room"]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.labels).toEqual(['Bedroom', 'Kitchen', 'Living Room']);
  });

  it('returns failure for garbage', () => {
    const result = parseRoomNamerResponse('I cannot identify rooms in this image.');
    expect(result.ok).toBe(false);
  });

  it('filters non-string entries', () => {
    const result = parseRoomNamerResponse('["Bedroom", 42, null, "Kitchen"]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.labels).toEqual(['Bedroom', 'Kitchen']);
  });
});

describe('parseLayoutDescriberResponse', () => {
  it('parses valid layout', () => {
    const input = JSON.stringify({
      room_count: 3,
      rooms: [{ name: 'Kitchen', position: 'top-left', size: 'medium' }],
    });
    const result = parseLayoutDescriberResponse(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room_count).toBe(3);
      expect(result.rooms).toHaveLength(1);
    }
  });

  it('returns failure when room_count missing', () => {
    const result = parseLayoutDescriberResponse('{"rooms": []}');
    expect(result.ok).toBe(false);
  });
});

describe('parseSymbolSpotterResponse', () => {
  it('parses valid symbols array', () => {
    const input = JSON.stringify([
      { type: 'Toilet', position: 'top-left' },
      { type: 'Shower', position: 'top-left' },
    ]);
    const result = parseSymbolSpotterResponse(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.symbols).toHaveLength(2);
  });

  it('returns failure for empty response', () => {
    const result = parseSymbolSpotterResponse('');
    expect(result.ok).toBe(false);
  });
});

describe('parseDimensionReaderResponse', () => {
  it('parses valid dimensions', () => {
    const input = JSON.stringify([
      { text: "10'-8\" x 8'-1\"", room_or_area: 'Bedroom' },
    ]);
    const result = parseDimensionReaderResponse(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dimensions).toHaveLength(1);
  });
});

describe('parseValidatorResponse', () => {
  it('parses valid corrections', () => {
    const input = JSON.stringify({
      correct: false,
      corrections: [{ type: 'missing_room', description: 'Missing bathroom' }],
    });
    const result = parseValidatorResponse(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.correct).toBe(false);
      expect(result.corrections).toHaveLength(1);
    }
  });

  it('returns correct=true with empty corrections', () => {
    const input = JSON.stringify({ correct: true, corrections: [] });
    const result = parseValidatorResponse(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.correct).toBe(true);
  });
});
