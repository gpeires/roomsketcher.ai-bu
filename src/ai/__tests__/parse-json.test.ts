// src/ai/__tests__/parse-json.test.ts
import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from '../parse-json';

describe('parseJsonResponse', () => {
  it('parses clean JSON object', () => {
    const result = parseJsonResponse('{"room_count": 5}');
    expect(result).toEqual({ room_count: 5 });
  });

  it('parses clean JSON array', () => {
    const result = parseJsonResponse('["Bedroom", "Kitchen"]');
    expect(result).toEqual(['Bedroom', 'Kitchen']);
  });

  it('strips markdown code fences', () => {
    const input = '```json\n{"room_count": 5}\n```';
    expect(parseJsonResponse(input)).toEqual({ room_count: 5 });
  });

  it('strips code fences without language tag', () => {
    const input = '```\n["Bedroom"]\n```';
    expect(parseJsonResponse(input)).toEqual(['Bedroom']);
  });

  it('extracts JSON from surrounding commentary', () => {
    const input = 'Here are the rooms I found:\n{"room_count": 3, "rooms": []}\nHope that helps!';
    expect(parseJsonResponse(input)).toEqual({ room_count: 3, rooms: [] });
  });

  it('extracts JSON array from surrounding text', () => {
    const input = 'The labels are: ["Bedroom", "Kitchen", "Living Room"] as shown.';
    expect(parseJsonResponse(input)).toEqual(['Bedroom', 'Kitchen', 'Living Room']);
  });

  it('returns null for unparseable text', () => {
    expect(parseJsonResponse('No JSON here at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJsonResponse('')).toBeNull();
  });

  it('handles nested objects', () => {
    const input = '```json\n{"rooms": [{"name": "Kitchen", "size": "large"}]}\n```';
    const result = parseJsonResponse(input);
    expect(result).toEqual({ rooms: [{ name: 'Kitchen', size: 'large' }] });
  });

  it('handles JSON with surrounding text', () => {
    const input = 'Result: {"a": 1, "b": 2}';
    expect(parseJsonResponse(input)).toEqual({ a: 1, b: 2 });
  });
});
