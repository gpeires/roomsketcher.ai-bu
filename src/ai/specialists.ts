// src/ai/specialists.ts
import { parseJsonResponse } from './parse-json';
import type {
  RoomNamerResult,
  LayoutDescriberResult,
  SymbolSpotterResult,
  DimensionReaderResult,
  ValidatorResult,
  SpecialistFailure,
  MergedRoom,
} from './types';

// ─── Prompts ─────────────────────────────────────────────────────────────────

export const ROOM_NAMER_PROMPT =
  'You are a JSON API. Analyze this floor plan image and list every room label visible. Use standard names: Bedroom, Bathroom, Kitchen, Living Room, Dining Room, Foyer, Hall, Corridor, Walk-In Closet, Dressing Room, Laundry Room, Utility Room, Storage, Balcony, Terrace, Office, Garage, WC, Half Bath, Pantry, Family room, Primary Bedroom, Guestroom, Childrens room. Respond with ONLY a JSON array, no other text. Example: ["Kitchen", "Bedroom", "Bathroom"]';

export const LAYOUT_DESCRIBER_PROMPT =
  'You are a JSON API. Count the rooms in this floor plan and describe each room\'s position and size. Positions: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right. Sizes: small, medium, large. Respond with ONLY JSON, no other text. Example: {"room_count": 3, "rooms": [{"name": "Kitchen", "position": "top-left", "size": "medium"}]}';

export const SYMBOL_SPOTTER_PROMPT =
  'You are a JSON API. List every fixture and symbol in this floor plan. Look for: Toilet, Sink, Bathtub, Shower, Fridge, Stove/Range, Dishwasher, Oven, Washer/Dryer, Kitchen Island, Bed, Sofa, Dining Table, Desk, Closet rod, Fireplace. Respond with ONLY a JSON array, no other text. Example: [{"type": "Toilet", "position": "top-right"}, {"type": "Bed", "position": "center-left"}]';

export const DIMENSION_READER_PROMPT =
  'You are a JSON API. List every dimension measurement visible in this floor plan. Include the text exactly as shown and which room it refers to. Respond with ONLY a JSON array, no other text. Example: [{"text": "12\'-6\\" x 10\'-3\\"", "room_or_area": "Bedroom"}]';

export function buildValidatorPrompt(rooms: MergedRoom[]): string {
  const roomList = rooms
    .map((r, i) => `Room ${i + 1}: ${r.label} at (${r.x},${r.y}), ${r.width}×${r.depth}cm, confidence=${r.confidence.toFixed(2)}`)
    .join('\n');

  return `Here is a floor plan image. We analyzed it and found these rooms:\n${roomList}\n\nDoes this match the image? List any: (a) missing rooms, (b) wrong labels, (c) rooms that should be merged or split. Return as JSON: {"correct": true/false, "corrections": [{"type": "missing_room|wrong_label|merge|split", "description": "..."}]}`;
}

// ─── Response parsers ────────────────────────────────────────────────────────

export function parseRoomNamerResponse(raw: string): RoomNamerResult | SpecialistFailure {
  const parsed = parseJsonResponse(raw);
  if (!Array.isArray(parsed)) {
    return { ok: false, specialist: 'room_namer', error: 'Expected JSON array' };
  }
  const labels = parsed.filter((item): item is string => typeof item === 'string');
  if (labels.length === 0) {
    return { ok: false, specialist: 'room_namer', error: 'No string labels found' };
  }
  return { ok: true, labels };
}

export function parseLayoutDescriberResponse(raw: string): LayoutDescriberResult | SpecialistFailure {
  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, specialist: 'layout_describer', error: 'Expected JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.room_count !== 'number') {
    return { ok: false, specialist: 'layout_describer', error: 'Missing room_count' };
  }
  const rooms = Array.isArray(obj.rooms)
    ? obj.rooms.filter(
        (r: unknown): r is { name: string; position: string; size: string } =>
          typeof r === 'object' && r !== null && 'name' in r && 'position' in r,
      )
    : [];
  return {
    ok: true,
    room_count: obj.room_count,
    rooms: rooms.map((r) => ({
      name: String(r.name),
      position: String(r.position),
      size: (r.size === 'small' || r.size === 'medium' || r.size === 'large' ? r.size : 'medium') as 'small' | 'medium' | 'large',
    })),
  };
}

export function parseSymbolSpotterResponse(raw: string): SymbolSpotterResult | SpecialistFailure {
  const parsed = parseJsonResponse(raw);
  if (!Array.isArray(parsed)) {
    return { ok: false, specialist: 'symbol_spotter', error: 'Expected JSON array' };
  }
  const symbols = parsed.filter(
    (s: unknown): s is { type: string; position: string } =>
      typeof s === 'object' && s !== null && 'type' in s && 'position' in s,
  );
  return { ok: true, symbols: symbols.map((s) => ({ type: String(s.type), position: String(s.position) })) };
}

export function parseDimensionReaderResponse(raw: string): DimensionReaderResult | SpecialistFailure {
  const parsed = parseJsonResponse(raw);
  if (!Array.isArray(parsed)) {
    return { ok: false, specialist: 'dimension_reader', error: 'Expected JSON array' };
  }
  const dimensions = parsed.filter(
    (d: unknown): d is { text: string; room_or_area: string } =>
      typeof d === 'object' && d !== null && 'text' in d,
  );
  return {
    ok: true,
    dimensions: dimensions.map((d) => ({
      text: String(d.text),
      room_or_area: String((d as Record<string, unknown>).room_or_area ?? ''),
    })),
  };
}

export function parseValidatorResponse(raw: string): ValidatorResult | SpecialistFailure {
  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, specialist: 'validator', error: 'Expected JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const correct = Boolean(obj.correct);
  const corrections = Array.isArray(obj.corrections)
    ? obj.corrections.filter(
        (c: unknown): c is { type: string; description: string } =>
          typeof c === 'object' && c !== null && 'type' in c && 'description' in c,
      )
    : [];
  return {
    ok: true,
    correct,
    corrections: corrections.map((c) => ({
      type: c.type as ValidatorResult['corrections'][number]['type'],
      description: String(c.description),
    })),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uint8ArrayToBase64DataUri(bytes: Uint8Array, mime = 'image/png'): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// ─── AI call wrapper ─────────────────────────────────────────────────────────

export async function callVisionSpecialist(
  ai: Ai,
  model: string,
  prompt: string,
  imageBytes: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const dataUri = uint8ArrayToBase64DataUri(imageBytes);

  const result = await Promise.race([
    ai.run(model as any, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  // Workers AI returns { response: string | object, tool_calls, usage }
  // For chat models with JSON output, response can be a string, object, or array
  if (typeof result === 'string') return result;
  const obj = result as Record<string, unknown>;
  if (obj.response !== undefined && obj.response !== null) {
    // Extract .response — stringify if it's already parsed JSON (object/array)
    return typeof obj.response === 'string' ? obj.response : JSON.stringify(obj.response);
  }
  return JSON.stringify(result);
}
