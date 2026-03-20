# AI-Layered CV Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Workers AI vision specialists alongside the existing CV service to dramatically improve room detection, labeling, and dimension extraction from floor plan images.

**Architecture:** A 4-stage pipeline (Gather → Merge → Validate → Output) running in the Cloudflare Worker. Stage 1 dispatches 5 parallel calls (1 CV + 4 AI vision specialists). Stage 2 deterministically merges results. Stage 3 validates via AI feedback loop. All AI calls go through CF AI Gateway for caching.

**Tech Stack:** Cloudflare Workers AI (Llama 3.2 11B Vision), CF AI Gateway, TypeScript, Vitest, D1

**Spec:** `docs/superpowers/specs/2026-03-20-ai-layered-cv-pipeline-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/ai/types.ts` | TypeScript types for all specialist outputs, merge state, pipeline config, confidence scores |
| `src/ai/parse-json.ts` | Extract JSON from messy LLM output (fences, commentary, partial responses) |
| `src/ai/specialists.ts` | Specialist prompt definitions, AI call wrappers, response parsers |
| `src/ai/merge.ts` | Deterministic merge layer: reconcile CV + AI outputs into unified model |
| `src/ai/validate.ts` | Validation feedback loop: AI reviews merged result vs original image |
| `src/ai/orchestrator.ts` | Pipeline orchestrator: gather → merge → validate → output |
| `src/ai/__tests__/parse-json.test.ts` | JSON extraction tests |
| `src/ai/__tests__/specialists.test.ts` | Specialist prompt/parser tests |
| `src/ai/__tests__/merge.test.ts` | Merge layer unit tests (7 key scenarios) |
| `src/ai/__tests__/validate.test.ts` | Validation loop tests |
| `src/ai/__tests__/orchestrator.test.ts` | End-to-end pipeline tests with mocked AI |
| `src/types.ts` | Add `AI: Ai` to `Env` interface (line 98) |
| `src/sketch/tools.ts` | Wire `handleAnalyzeImage` to orchestrator (line 393) |
| `wrangler.toml` | Add `[ai]` binding |
| `deploy.sh` | Add AI Gateway provisioning |
| `src/db/schema.sql` | Add neuron usage tracking table |

---

## Task 0: Neuron Budget Measurement

**Why first:** The spec says "Implementation step 0 — measure actual neuron cost." This determines whether we use 4 AI specialists or must consolidate to 2. Everything downstream depends on this.

**Files:**
- Modify: `wrangler.toml`
- Create: `src/ai/neuron-test.ts` (temporary, deleted after measurement)

- [ ] **Step 1: Add AI binding to wrangler.toml**

Add at the end of `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

- [ ] **Step 2: Write a minimal test script**

Create `src/ai/neuron-test.ts` — a throwaway script that makes one Llama 3.2 11B Vision call with a real floor plan image via `wrangler dev`. We'll call it manually from the browser/curl.

```typescript
// Temporary file for measuring neuron cost — delete after measurement
// Access via: curl http://localhost:8787/ai-test?image_url=<url>

export async function handleNeuronTest(
  request: Request,
  env: { AI: Ai },
): Promise<Response> {
  const url = new URL(request.url);
  const imageUrl = url.searchParams.get('image_url');
  if (!imageUrl) return new Response('Pass ?image_url=...', { status: 400 });

  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) return new Response(`Failed to fetch image: ${imgResp.status}`, { status: 400 });

  const imageBytes = new Uint8Array(await imgResp.arrayBuffer());

  const start = Date.now();
  const result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    messages: [
      {
        role: 'user',
        content: 'List every room label visible in this floor plan image. Return as a JSON array of strings.',
      },
    ],
    image: [...imageBytes],
  });
  const elapsed = Date.now() - start;

  return Response.json({
    elapsed_ms: elapsed,
    result,
    note: 'Check CF dashboard > AI > Usage for neuron count',
  });
}
```

- [ ] **Step 3: Temporarily wire the test route into index.ts**

In `src/index.ts`, inside the `fetch` handler, add a temporary route before the existing routes:

```typescript
if (new URL(request.url).pathname === '/ai-test') {
  const { handleNeuronTest } = await import('./ai/neuron-test');
  return handleNeuronTest(request, this.env as any);
}
```

- [ ] **Step 4: Run wrangler dev and measure**

```bash
npx wrangler dev
```

Then in another terminal:

```bash
curl "http://localhost:8787/ai-test?image_url=https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785"
```

Record:
- Response quality (did it identify room names?)
- Latency (elapsed_ms)
- Check CF Dashboard → AI → Usage for neuron count of this single call

- [ ] **Step 5: Document results and decide architecture**

Based on neuron cost per call:
- **≤500 neurons:** Full 4-specialist pipeline (Room Namer + Layout Describer + Symbol Spotter + Dimension Reader + 1 validation = 5 AI calls)
- **500–1500 neurons:** Consolidate to 2 specialists (Room Namer+Layout combined, Symbol+Dimension combined) + 1 validation = 3 AI calls
- **>1500 neurons:** Use `@cf/unum/uform-gen2-qwen-500m` for 3 specialists, Llama 11B only for validation = 4 AI calls

Update the plan below if consolidation is needed. Write the decision as a comment at the top of `src/ai/types.ts`.

- [ ] **Step 6: Clean up — remove test route and temporary file**

Remove the `/ai-test` route from `src/index.ts`. Delete `src/ai/neuron-test.ts`.

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml
git -c commit.gpgsign=false commit -m "feat: add Workers AI binding to wrangler.toml"
```

---

## Task 1: Types (`src/ai/types.ts`)

**Files:**
- Create: `src/ai/types.ts`

- [ ] **Step 1: Create type definitions**

```typescript
// src/ai/types.ts

// ─── Specialist outputs ──────────────────────────────────────────────────────

/** Returned when a specialist fails (timeout, bad JSON, model error) */
export interface SpecialistFailure {
  ok: false;
  specialist: string;
  error: string;
}

/** Room Namer: list of room labels from the image */
export interface RoomNamerResult {
  ok: true;
  labels: string[];
}

/** Layout Describer: room count + spatial positions */
export interface LayoutDescriberResult {
  ok: true;
  room_count: number;
  rooms: Array<{
    name: string;
    position: string; // e.g. "top-left", "center", "bottom-right"
    size: 'small' | 'medium' | 'large';
  }>;
}

/** Symbol Spotter: fixtures and their positions */
export interface SymbolSpotterResult {
  ok: true;
  symbols: Array<{
    type: string;
    position: string;
  }>;
}

/** Dimension Reader: measurement text and room associations */
export interface DimensionReaderResult {
  ok: true;
  dimensions: Array<{
    text: string;
    room_or_area: string;
  }>;
}

/** Validator: corrections from the feedback loop */
export interface ValidatorResult {
  ok: true;
  correct: boolean;
  corrections: Array<{
    type: 'missing_room' | 'wrong_label' | 'merge' | 'split';
    description: string;
  }>;
}

// ─── CV Service output ───────────────────────────────────────────────────────

export interface CVRoom {
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
}

export interface CVResult {
  name: string;
  rooms: CVRoom[];
  meta: {
    walls_detected: number;
    rooms_detected: number;
    text_regions: number;
    scale_cm_per_px: number;
    image_width?: number;
    image_height?: number;
  };
}

// ─── Merge layer ─────────────────────────────────────────────────────────────

/** Grid positions for spatial mapping (3x3 grid) */
export type GridPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** Symbol-to-room-type mapping */
export const SYMBOL_ROOM_MAP: Record<string, string> = {
  'Toilet': 'Bathroom',
  'Shower': 'Bathroom',
  'Bathtub': 'Bathroom',
  'Stove': 'Kitchen',
  'Range': 'Kitchen',
  'Fridge': 'Kitchen',
  'Refrigerator': 'Kitchen',
  'Bed': 'Bedroom',
  'Double Bed': 'Bedroom',
  'Single Bed': 'Bedroom',
  'Washer': 'Laundry Room',
  'Dryer': 'Laundry Room',
  'Washer/Dryer': 'Laundry Room',
  'Closet rod': 'Walk-In Closet',
  'Desk': 'Office',
  'Sink': 'Kitchen', // Ambiguous (kitchen or bathroom). Symbol voting resolves this:
                     // if Toilet is also present in the same grid cell, Bathroom wins.
};

/** A merged room with confidence data */
export interface MergedRoom {
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  type: string;
  confidence: number;
  sources: string[];
  split_hint?: boolean;
  split_evidence?: string[];
}

/** Gather stage results (all specialist outputs) */
export interface GatherResults {
  cv: CVResult;
  roomNamer: RoomNamerResult | SpecialistFailure;
  layoutDescriber: LayoutDescriberResult | SpecialistFailure;
  symbolSpotter: SymbolSpotterResult | SpecialistFailure;
  dimensionReader: DimensionReaderResult | SpecialistFailure;
}

/** Full pipeline output */
export interface PipelineOutput {
  name: string;
  rooms: MergedRoom[];
  openings: unknown[];  // pass-through from CV when available, empty otherwise
  adjacency: unknown[]; // pass-through from CV when available, empty otherwise
  meta: {
    image_size: [number, number];
    scale_cm_per_px: number;
    walls_detected: number;
    rooms_detected: number;
    ai_corrections: number;
    validation_passes: number;
    neurons_used: number;
    pipeline_version: string;
    specialists_succeeded: string[];
    specialists_failed: string[];
  };
}

// ─── Pipeline config ─────────────────────────────────────────────────────────

export interface PipelineConfig {
  ai: Ai;
  db: D1Database;   // for neuron budget tracking
  cvServiceUrl: string;
  model: string;
  fallbackModel: string;
  aiTimeoutMs: number;
  cvTimeoutMs: number;
  maxValidationPasses: number;
  neuronBudget: number;       // daily limit (10000 for free tier)
  neuronBudgetBuffer: number; // skip AI when within this many of limit
}

export const DEFAULT_CONFIG = {
  model: '@cf/meta/llama-3.2-11b-vision-instruct',
  fallbackModel: '@cf/unum/uform-gen2-qwen-500m',
  aiTimeoutMs: 15_000,
  cvTimeoutMs: 30_000,
  maxValidationPasses: 2,
  neuronBudget: 10_000,
  neuronBudgetBuffer: 2_000,
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/types.ts
git -c commit.gpgsign=false commit -m "feat(ai): add type definitions for AI pipeline specialists and merge layer"
```

---

## Task 2: JSON Parser (`src/ai/parse-json.ts`)

LLM responses are messy — markdown fences, commentary before/after JSON, partial output. This utility extracts valid JSON from any of those.

**Files:**
- Create: `src/ai/__tests__/parse-json.test.ts`
- Create: `src/ai/parse-json.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/parse-json.test.ts
```

Expected: FAIL — module `../parse-json` not found.

- [ ] **Step 3: Implement parse-json.ts**

```typescript
// src/ai/parse-json.ts

/**
 * Extract JSON from messy LLM output.
 *
 * Strategy:
 * 1. Strip markdown code fences
 * 2. Try JSON.parse on full string
 * 3. Regex-extract first {...} or [...] block and parse that
 * 4. Return null if nothing works
 */
export function parseJsonResponse(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null;

  // Step 1: strip markdown fences
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Step 2: try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue to fallback
  }

  // Step 3: regex extraction — find first balanced {...} or [...]
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* continue */ }
  }

  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch { /* continue */ }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ai/__tests__/parse-json.test.ts
```

Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/parse-json.ts src/ai/__tests__/parse-json.test.ts
git -c commit.gpgsign=false commit -m "feat(ai): add JSON parser for messy LLM output with code fence stripping"
```

---

## Task 3: Specialists (`src/ai/specialists.ts`)

Each specialist: prompt definition, AI call wrapper with timeout, response parser using `parseJsonResponse`.

**Files:**
- Create: `src/ai/__tests__/specialists.test.ts`
- Create: `src/ai/specialists.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/specialists.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement specialists.ts**

```typescript
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
  'List every room label visible in this floor plan image. Return as a JSON array of strings. Use only these standard names where applicable: Bedroom, Bathroom, Kitchen, Living Room, Dining Room, Foyer, Hall, Corridor, Walk-In Closet, Dressing Room, Laundry Room, Utility Room, Storage, Balcony, Terrace, Office, Garage, WC, Half Bath, Pantry, Family room, Primary Bedroom, Guestroom, Childrens room.';

export const LAYOUT_DESCRIBER_PROMPT =
  'How many separate rooms are in this floor plan? For each room, describe its position (top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right) and approximate relative size (small, medium, large). Return as JSON: {"room_count": N, "rooms": [{"name": "...", "position": "...", "size": "..."}]}';

export const SYMBOL_SPOTTER_PROMPT =
  'List every fixture and symbol visible in this floor plan. Look for: Toilet, Sink, Bathtub, Shower, Fridge, Stove/Range, Dishwasher, Oven, Washer/Dryer, Kitchen Island, Bed, Sofa, Dining Table, Desk, Closet rod, Fireplace. For each, give the type and approximate position (top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right). Return as JSON array: [{"type": "...", "position": "..."}]';

export const DIMENSION_READER_PROMPT =
  'List every dimension measurement visible in this floor plan. Include the text exactly as shown and which room or area it refers to. Return as JSON array: [{"text": "...", "room_or_area": "..."}]';

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

// ─── AI call wrapper ─────────────────────────────────────────────────────────

export async function callVisionSpecialist(
  ai: Ai,
  model: string,
  prompt: string,
  imageBytes: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  // Race the AI call against a timeout — AbortSignal.timeout is cleaner
  // than manual AbortController and is supported in Workers runtime
  const result = await Promise.race([
    ai.run(model as any, {
      messages: [{ role: 'user', content: prompt }],
      image: [...imageBytes],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return typeof result === 'string'
    ? result
    : (result as { response?: string }).response ?? JSON.stringify(result);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ai/__tests__/specialists.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/specialists.ts src/ai/__tests__/specialists.test.ts
git -c commit.gpgsign=false commit -m "feat(ai): add specialist prompts, response parsers, and vision call wrapper"
```

---

## Task 4: Merge Layer (`src/ai/merge.ts`)

The deterministic merge layer — no AI, fully testable. Takes CV + specialist results, reconciles into unified room model with confidence scores.

**Files:**
- Create: `src/ai/__tests__/merge.test.ts`
- Create: `src/ai/merge.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
    expect(merged[0].confidence).toBeCloseTo(0.3); // CV-only confidence
    expect(merged[0].sources).toEqual(['cv']);
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/merge.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement merge.ts**

```typescript
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

// ─── Spatial grid mapping ────────────────────────────────────────────────────

const GRID_POSITIONS: GridPosition[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

function roomToGridPosition(
  room: CVRoom,
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

// ─── Label assignment ────────────────────────────────────────────────────────

function inferLabelFromSymbols(
  roomGrid: GridPosition,
  symbols: SymbolSpotterResult['symbols'],
): { label: string; evidence: string[] } | null {
  const matchingSymbols = symbols.filter(
    (s) => normalizePosition(s.position) === roomGrid,
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
  roomGrid: GridPosition,
  symbols: SymbolSpotterResult['symbols'],
): string[] {
  const matchingSymbols = symbols.filter(
    (s) => normalizePosition(s.position) === roomGrid,
  );
  const roomTypes = new Set<string>();
  for (const sym of matchingSymbols) {
    const roomType = SYMBOL_ROOM_MAP[sym.type];
    if (roomType) roomTypes.add(roomType);
  }
  return roomTypes.size > 1 ? [...roomTypes] : [];
}

// ─── Main merge ──────────────────────────────────────────────────────────────

export function mergeResults(gather: GatherResults): MergedRoom[] {
  const { cv } = gather;
  const imageWidth = cv.meta.image_width ?? 900;
  const imageHeight = cv.meta.image_height ?? 900;

  const layoutDescriber = gather.layoutDescriber.ok ? gather.layoutDescriber as LayoutDescriberResult : null;
  const symbolSpotter = gather.symbolSpotter.ok ? gather.symbolSpotter as SymbolSpotterResult : null;
  const roomNamer = gather.roomNamer.ok ? gather.roomNamer : null;
  const dimensionReader = gather.dimensionReader.ok ? gather.dimensionReader as DimensionReaderResult : null;

  const expectedCount = layoutDescriber
    ? Math.max(cv.rooms.length, layoutDescriber.room_count)
    : cv.rooms.length;

  return cv.rooms.map((room) => {
    const gridPos = roomToGridPosition(room, imageWidth, imageHeight);
    const sources: string[] = ['cv'];
    let label = room.label;
    let confidence = 0.3;
    let split_hint = false;
    let split_evidence: string[] | undefined;

    // NOTE: Spec priority #1 is Tesseract text-position matching, but the CV
    // service currently returns text_regions as a count, not pixel coordinates.
    // When the CV service is updated to return text positions, add OCR-based
    // label assignment here before symbol inference.

    // 1. Symbol-based inference
    if (symbolSpotter) {
      const symbolInference = inferLabelFromSymbols(gridPos, symbolSpotter.symbols);
      if (symbolInference) {
        label = symbolInference.label;
        sources.push('symbol_spotter');
        confidence += 0.2;
      }

      const incompatible = findIncompatibleSymbols(gridPos, symbolSpotter.symbols);
      if (incompatible.length > 1) {
        split_hint = true;
        split_evidence = incompatible;
      }
    }

    // 2. Room Namer + Layout Describer position matching
    if (roomNamer && layoutDescriber) {
      const matchingLayoutRoom = layoutDescriber.rooms.find(
        (lr) => normalizePosition(lr.position) === gridPos,
      );
      if (matchingLayoutRoom) {
        const namerHasLabel = roomNamer.labels.some(
          (l) => l.toLowerCase() === matchingLayoutRoom.name.toLowerCase(),
        );
        if (namerHasLabel) {
          if (!sources.includes('symbol_spotter') || label === matchingLayoutRoom.name) {
            label = matchingLayoutRoom.name;
          }
          sources.push('room_namer');
          confidence += 0.2;
        }
      }
    } else if (roomNamer && !layoutDescriber) {
      const directMatch = roomNamer.labels.find(
        (l) => l.toLowerCase() === room.label.toLowerCase(),
      );
      if (directMatch) {
        label = directMatch;
        sources.push('room_namer');
        confidence += 0.2;
      }
    }

    // 3. Dimension binding
    if (dimensionReader) {
      const dimMatch = dimensionReader.dimensions.find(
        (d) => d.room_or_area.toLowerCase() === label.toLowerCase(),
      );
      if (dimMatch) {
        sources.push('dimension_reader');
        confidence += 0.15;
      }
    }

    // 4. Multi-source agreement bonus
    if (sources.length >= 3) {
      confidence += 0.15;
    }

    // 5. Room count discrepancy → flag large rooms for splitting
    if (expectedCount > cv.rooms.length) {
      const roomArea = room.width * room.depth;
      const imageArea = imageWidth * imageHeight;
      const avgExpectedArea = imageArea / expectedCount;
      if (roomArea > avgExpectedArea * 1.5) {
        split_hint = true;
        if (!split_evidence) {
          split_evidence = [`CV: ${cv.rooms.length} rooms, AI: ${expectedCount} rooms`];
        }
      }
    }

    return {
      label,
      x: room.x,
      y: room.y,
      width: room.width,
      depth: room.depth,
      type: label.toLowerCase().replace(/\s+/g, '_'),
      confidence: Math.min(confidence, 1.0),
      sources,
      ...(split_hint ? { split_hint, split_evidence } : {}),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ai/__tests__/merge.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/merge.ts src/ai/__tests__/merge.test.ts
git -c commit.gpgsign=false commit -m "feat(ai): add deterministic merge layer with spatial grid, symbol inference, confidence scoring"
```

---

## Task 5: Validation Loop (`src/ai/validate.ts`)

Sends merged results + original image back to AI for a final check. Max 2 iterations.

**Files:**
- Create: `src/ai/__tests__/validate.test.ts`
- Create: `src/ai/validate.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/validate.test.ts
```

- [ ] **Step 3: Implement validate.ts**

```typescript
// src/ai/validate.ts
import type { MergedRoom, ValidatorResult, SpecialistFailure } from './types';
import { buildValidatorPrompt, callVisionSpecialist, parseValidatorResponse } from './specialists';

// ─── Correction application (deterministic, testable) ────────────────────────

export function applyCorrections(
  rooms: MergedRoom[],
  corrections: ValidatorResult['corrections'],
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
      case 'missing_room':
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

    const { rooms: corrected, applied } = applyCorrections(currentRooms, parsed.corrections);
    totalCorrections += applied;
    currentRooms = corrected;

    const hasMajor = parsed.corrections.some(
      (c) => c.type === 'missing_room' || c.type === 'split',
    );
    if (!hasMajor) break;
  }

  return { rooms: currentRooms, totalCorrections, passes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ai/__tests__/validate.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/validate.ts src/ai/__tests__/validate.test.ts
git -c commit.gpgsign=false commit -m "feat(ai): add validation feedback loop with correction application"
```

---

## Task 6: Orchestrator (`src/ai/orchestrator.ts`)

Wires everything together: fetch image → gather (parallel) → merge → validate → output.

**Files:**
- Create: `src/ai/__tests__/orchestrator.test.ts`
- Create: `src/ai/orchestrator.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/orchestrator.test.ts
```

- [ ] **Step 3: Implement orchestrator.ts**

```typescript
// src/ai/orchestrator.ts
import type {
  CVResult,
  GatherResults,
  MergedRoom,
  PipelineConfig,
  PipelineOutput,
  SpecialistFailure,
} from './types';
import { DEFAULT_CONFIG } from './types';
import {
  ROOM_NAMER_PROMPT,
  LAYOUT_DESCRIBER_PROMPT,
  SYMBOL_SPOTTER_PROMPT,
  DIMENSION_READER_PROMPT,
  callVisionSpecialist,
  parseRoomNamerResponse,
  parseLayoutDescriberResponse,
  parseSymbolSpotterResponse,
  parseDimensionReaderResponse,
} from './specialists';
import { mergeResults } from './merge';
import { validateMergedResults } from './validate';

// ─── Image fetching ──────────────────────────────────────────────────────────

async function fetchImageBytes(
  input: { image?: string; image_url?: string },
): Promise<{ bytes: Uint8Array; base64: string; mime: 'image/png' | 'image/jpeg' }> {
  if (input.image) {
    const binary = atob(input.image);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, base64: input.image, mime: 'image/png' };
  }

  const resp = await fetch(input.image_url!, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);

  const ct = resp.headers.get('content-type') || '';
  const mime: 'image/png' | 'image/jpeg' = ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' : 'image/png';
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  const base64 = btoa(chunks.join(''));

  return { bytes, base64, mime };
}

// ─── CV Service call ─────────────────────────────────────────────────────────

async function callCvService(
  input: { image?: string; image_url?: string },
  name: string,
  cvServiceUrl: string,
  timeoutMs: number,
): Promise<CVResult> {
  const body: Record<string, string> = { name };
  if (input.image) {
    body.image = input.image;
  } else {
    body.image_url = input.image_url!;
  }

  const resp = await fetch(`${cvServiceUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`CV service failed: ${err}`);
  }

  return resp.json() as Promise<CVResult>;
}

// ─── Gather stage ────────────────────────────────────────────────────────────

export async function gatherSpecialists(
  imageBytes: Uint8Array,
  input: { image?: string; image_url?: string },
  name: string,
  config: PipelineConfig,
): Promise<GatherResults> {
  const fail = (specialist: string, error: string): SpecialistFailure => ({
    ok: false, specialist, error,
  });

  const [cvResult, roomNamerRaw, layoutDescriberRaw, symbolSpotterRaw, dimensionReaderRaw] =
    await Promise.all([
      callCvService(input, name, config.cvServiceUrl, config.cvTimeoutMs),
      callVisionSpecialist(config.ai, config.model, ROOM_NAMER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(() => null),
      callVisionSpecialist(config.ai, config.model, LAYOUT_DESCRIBER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(() => null),
      callVisionSpecialist(config.ai, config.model, SYMBOL_SPOTTER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(() => null),
      callVisionSpecialist(config.ai, config.model, DIMENSION_READER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(() => null),
    ]);

  return {
    cv: cvResult,
    roomNamer: roomNamerRaw
      ? parseRoomNamerResponse(roomNamerRaw)
      : fail('room_namer', 'Call failed'),
    layoutDescriber: layoutDescriberRaw
      ? parseLayoutDescriberResponse(layoutDescriberRaw)
      : fail('layout_describer', 'Call failed'),
    symbolSpotter: symbolSpotterRaw
      ? parseSymbolSpotterResponse(symbolSpotterRaw)
      : fail('symbol_spotter', 'Call failed'),
    dimensionReader: dimensionReaderRaw
      ? parseDimensionReaderResponse(dimensionReaderRaw)
      : fail('dimension_reader', 'Call failed'),
  };
}

// ─── Build output ────────────────────────────────────────────────────────────

export function buildPipelineOutput(
  name: string,
  rooms: MergedRoom[],
  cv: CVResult,
  stats: { corrections: number; passes: number; neuronsUsed: number; succeeded: string[]; failed: string[] },
): PipelineOutput {
  return {
    name,
    rooms,
    openings: [],
    adjacency: [],
    meta: {
      image_size: [cv.meta.image_width ?? 0, cv.meta.image_height ?? 0],
      scale_cm_per_px: cv.meta.scale_cm_per_px,
      walls_detected: cv.meta.walls_detected,
      rooms_detected: rooms.length,
      ai_corrections: stats.corrections,
      validation_passes: stats.passes,
      neurons_used: stats.neuronsUsed,
      pipeline_version: stats.failed.includes('budget_exhausted') ? '1.0-cv-only' : '2.0',
      specialists_succeeded: stats.succeeded,
      specialists_failed: stats.failed,
    },
  };
}

// ─── Full pipeline ───────────────────────────────────────────────────────────

// ─── Neuron budget tracking ──────────────────────────────────────────────────

async function getNeuronsUsedToday(db: D1Database): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await db.prepare('SELECT neurons_used FROM ai_neuron_usage WHERE date = ?').bind(today).first<{ neurons_used: number }>();
  return row?.neurons_used ?? 0;
}

async function recordNeuronUsage(db: D1Database, neurons: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO ai_neuron_usage (date, neurons_used, last_updated)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       neurons_used = neurons_used + excluded.neurons_used,
       last_updated = datetime('now')`,
  ).bind(today, neurons).run();
}

export async function runPipeline(
  input: { image?: string; image_url?: string },
  name: string,
  config: PipelineConfig,
): Promise<PipelineOutput> {
  // 0. Check neuron budget — fall back to CV-only if near limit
  const neuronsUsedToday = await getNeuronsUsedToday(config.db);
  const budgetRemaining = config.neuronBudget - neuronsUsedToday;
  const skipAI = budgetRemaining <= config.neuronBudgetBuffer;

  // 1. Fetch image bytes (once, reused by all specialists)
  const { bytes: imageBytes } = await fetchImageBytes(input);

  if (skipAI) {
    // CV-only mode — budget exhausted
    const cvResult = await callCvService(input, name, config.cvServiceUrl, config.cvTimeoutMs);
    const cvOnlyRooms: MergedRoom[] = cvResult.rooms.map((r) => ({
      ...r, type: r.label.toLowerCase().replace(/\s+/g, '_'),
      confidence: 0.3, sources: ['cv'],
    }));
    return buildPipelineOutput(name, cvOnlyRooms, cvResult, {
      corrections: 0, passes: 0, neuronsUsed: 0,
      succeeded: [], failed: ['budget_exhausted'],
    });
  }

  // 2. Gather — parallel CV + AI calls
  const gather = await gatherSpecialists(imageBytes, input, name, config);

  // Track which specialists succeeded/failed
  const succeeded: string[] = [];
  const failed: string[] = [];
  const specialistEntries = [
    ['roomNamer', gather.roomNamer],
    ['layoutDescriber', gather.layoutDescriber],
    ['symbolSpotter', gather.symbolSpotter],
    ['dimensionReader', gather.dimensionReader],
  ] as const;
  for (const [key, result] of specialistEntries) {
    if (result.ok) succeeded.push(key);
    else failed.push(key);
  }

  // 3. Merge — deterministic reconciliation
  const merged = mergeResults(gather);

  // 4. Validate — AI feedback loop
  const { rooms: validated, totalCorrections, passes } = await validateMergedResults(
    merged,
    imageBytes,
    config.ai,
    config.model,
    config.aiTimeoutMs,
    config.maxValidationPasses,
  );

  // 5. Build output + record neuron usage
  const estimatedNeurons = (succeeded.length + passes) * 500; // updated after Task 0 measurement
  await recordNeuronUsage(config.db, estimatedNeurons);

  return buildPipelineOutput(name, validated, gather.cv, {
    corrections: totalCorrections,
    passes,
    neuronsUsed: estimatedNeurons,
    succeeded,
    failed,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ai/__tests__/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/orchestrator.ts src/ai/__tests__/orchestrator.test.ts
git -c commit.gpgsign=false commit -m "feat(ai): add pipeline orchestrator with parallel gather, merge, and validate stages"
```

---

## Task 7: Wire Into Worker

Connect the orchestrator to the existing `handleAnalyzeImage` function and update the Env interface.

**Files:**
- Modify: `src/types.ts:98-105`
- Modify: `src/sketch/tools.ts:393-469`
- Modify: `src/index.ts:461-475`

- [ ] **Step 1: Add AI binding to Env interface**

In `src/types.ts`, add `AI` to the `Env` interface (line 98):

```typescript
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  SKETCH_SYNC: DurableObjectNamespace;
  WORKER_URL: string;
  CTA_VARIANT?: string;
  CV_SERVICE_URL?: string;
  AI?: Ai;  // Workers AI binding — optional for graceful degradation
}
```

- [ ] **Step 2: Update handleAnalyzeImage to use pipeline**

Replace the `handleAnalyzeImage` function in `src/sketch/tools.ts` (lines 393–469). The new function adds `ai?: Ai` and `db?: D1Database` parameters. When AI is available, it runs the full pipeline; otherwise falls back to CV-only:

```typescript
export async function handleAnalyzeImage(
  input: { image?: string; image_url?: string },
  name: string,
  cvServiceUrl: string,
  ai?: Ai,
  db?: D1Database,
): Promise<ToolResult> {
  if (!input.image && !input.image_url) {
    return { content: [{ type: 'text' as const, text: 'Provide either image (base64) or image_url.' }] };
  }

  // Fetch the source image for visual feedback
  let imageBase64: string | undefined;
  let imageMime: 'image/png' | 'image/jpeg' = 'image/png';
  if (input.image) {
    imageBase64 = input.image;
  } else if (input.image_url) {
    try {
      const imgResp = await fetch(input.image_url, { signal: AbortSignal.timeout(15_000) });
      if (imgResp.ok) {
        const ct = imgResp.headers.get('content-type') || '';
        imageMime = ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' as const : 'image/png' as const;
        const buf = await imgResp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 8192) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        }
        imageBase64 = btoa(chunks.join(''));
      }
    } catch { /* non-fatal */ }
  }

  // If AI binding available, use the full pipeline; otherwise CV-only fallback
  if (ai && db) {
    try {
      const { runPipeline } = await import('../ai/orchestrator');
      const { DEFAULT_CONFIG } = await import('../ai/types');
      const result = await runPipeline(input, name, {
        ai,
        db,
        cvServiceUrl,
        ...DEFAULT_CONFIG,
      });

      const pipelineLabel = result.meta.pipeline_version === '1.0-cv-only'
        ? 'CV Analysis Complete (AI budget exhausted)'
        : `AI-Enhanced Analysis Complete (pipeline v${result.meta.pipeline_version})`;

      const summary = [
        `**${pipelineLabel}** — ${result.rooms.length} rooms detected`,
        `Scale: ${result.meta.scale_cm_per_px.toFixed(2)} cm/px | Walls: ${result.meta.walls_detected}`,
        `AI specialists: ${result.meta.specialists_succeeded.length} succeeded, ${result.meta.specialists_failed.length} failed`,
        `Validation: ${result.meta.validation_passes} pass(es), ${result.meta.ai_corrections} correction(s)`,
        '',
        '```json',
        JSON.stringify(result, null, 2),
        '```',
        '',
        'Review the source image above against the AI-enhanced output. The confidence scores indicate how certain each room detection is.',
      ].join('\n');

      const content: ContentBlock[] = [];
      if (imageBase64) {
        content.push({ type: 'image' as const, data: imageBase64, mimeType: imageMime as 'image/png' });
      }
      content.push({ type: 'text' as const, text: summary });
      return { content };
    } catch (err) {
      // Pipeline failed — fall through to CV-only
      console.error('AI pipeline failed, falling back to CV-only:', err);
    }
  }

  // CV-only fallback (same as original)
  const body: Record<string, string> = { name };
  if (input.image) body.image = input.image;
  else body.image_url = input.image_url!;

  const resp = await fetch(`${cvServiceUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: [{ type: 'text' as const, text: `CV analysis failed: ${err}` }] };
  }

  const result = await resp.json() as {
    name: string;
    rooms: Array<{ label: string; x: number; y: number; width: number; depth: number }>;
    meta: { walls_detected: number; rooms_detected: number; text_regions: number; scale_cm_per_px: number };
  };

  const summary = [
    `**CV Analysis Complete** (no AI enhancement) — ${result.rooms.length} rooms detected`,
    `Scale: ${result.meta.scale_cm_per_px.toFixed(2)} cm/px`,
    `Walls: ${result.meta.walls_detected}, Text regions: ${result.meta.text_regions}`,
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
    'Review the source image above against the CV output. Fix any misdetected labels or dimensions before passing to generate_floor_plan.',
  ].join('\n');

  const content: ContentBlock[] = [];
  if (imageBase64) {
    content.push({ type: 'image' as const, data: imageBase64, mimeType: imageMime as 'image/png' });
  }
  content.push({ type: 'text' as const, text: summary });
  return { content };
}
```

- [ ] **Step 3: Update tool registration to pass AI binding**

In `src/index.ts`, update the `analyze_floor_plan_image` tool handler (around line 471–474) to pass `this.env.AI`:

```typescript
async ({ image, image_url, name }) => {
  const cvUrl = this.env.CV_SERVICE_URL || 'http://localhost:8100';
  return handleAnalyzeImage({ image, image_url }, name || 'Extracted Floor Plan', cvUrl, this.env.AI, this.env.DB);
},
```

- [ ] **Step 4: Run all tests to verify nothing broke**

```bash
npx vitest run
```

Expected: all existing tests PASS + all new AI tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/sketch/tools.ts src/index.ts
git -c commit.gpgsign=false commit -m "feat: wire AI pipeline into handleAnalyzeImage with CV-only fallback"
```

---

## Task 8: Deploy Infrastructure

Add AI Gateway provisioning to deploy.sh and add neuron tracking table.

**Files:**
- Modify: `deploy.sh` (insert after line 120)
- Modify: `src/db/schema.sql` (append)

- [ ] **Step 1: Add neuron tracking table to schema**

Append to `src/db/schema.sql`:

```sql
-- AI neuron usage tracking (daily budget)
CREATE TABLE IF NOT EXISTS ai_neuron_usage (
  date TEXT PRIMARY KEY,  -- YYYY-MM-DD
  neurons_used INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Add AI Gateway provisioning to deploy.sh**

Insert this section after the D1 database check (after line 120, before "Step 2: Patch wrangler.toml"):

```bash
# ─── Step 1b: Ensure AI Gateway exists ───────────────────────────────────────
echo "--- Checking AI Gateway..."
AI_GW_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways"
AI_GW_ID="roomsketcher-ai"

AI_GW_EXISTS=$(curl -s "${AI_GW_API}/${AI_GW_ID}" "${CF_HEADERS[@]}" \
  | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const r=JSON.parse(buf);
      if(r.success && r.result && r.result.id) process.stdout.write('yes');
    })
  ")

if [[ "$AI_GW_EXISTS" == "yes" ]]; then
  echo "    Found: AI Gateway '${AI_GW_ID}'"
else
  echo "    Creating AI Gateway '${AI_GW_ID}'..."
  CREATE_GW_RESP=$(curl -s -X POST "$AI_GW_API" "${CF_HEADERS[@]}" \
    --data "{\"id\":\"${AI_GW_ID}\",\"name\":\"RoomSketcher AI Gateway\",\"cache_invalidate_on_update\":true,\"cache_ttl\":86400}")
  GW_SUCCESS=$(echo "$CREATE_GW_RESP" | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const r=JSON.parse(buf);
      process.stdout.write(r.success ? 'yes' : 'no');
    })
  ")
  if [[ "$GW_SUCCESS" == "yes" ]]; then
    echo "    Created: AI Gateway '${AI_GW_ID}'"
  else
    echo "    Warning: Could not create AI Gateway. AI enrichment will be unavailable."
    echo "    Response: $CREATE_GW_RESP"
  fi
fi
```

- [ ] **Step 3: Deploy and verify**

```bash
bash deploy.sh
```

Expected: AI Gateway created (or found), worker deploys with AI binding, health check passes.

- [ ] **Step 4: Commit**

```bash
git add deploy.sh src/db/schema.sql
git -c commit.gpgsign=false commit -m "feat: add AI Gateway provisioning to deploy.sh and neuron tracking table"
```

---

## Task 9: End-to-End Test

Deploy and test the full pipeline against a real floor plan image.

- [ ] **Step 1: Deploy to production**

```bash
bash deploy.sh
```

- [ ] **Step 2: Test via MCP tool**

Use `analyze_floor_plan_image` with the test image:

```
image_url: https://roomsketcher-help-mcp.10ecb923-workers.workers.dev/api/images/44e71e4b-e100-4572-aed1-674193c78785
```

- [ ] **Step 3: Evaluate results**

Compare pipeline v2.0 output against previous CV-only output:
- Did room count improve from 4 to closer to 7-8?
- Are room labels more accurate (Kitchen, Bedroom, Bathroom vs generic "Room N")?
- Do confidence scores make sense?
- Did the validation loop catch/fix anything?
- Which specialists succeeded vs failed?

- [ ] **Step 4: Generate a floor plan from the results**

Use `generate_floor_plan` with the pipeline output to create a sketch, then `preview_sketch` to visually compare.

- [ ] **Step 5: Document results**

Record findings as a comment in the PR or commit message. If neuron budget from Task 0 requires architecture changes, note what was adjusted.

---

## Implementation Order

| Order | Task | Dependencies | Steps |
|-------|------|-------------|-------|
| 1 | Task 0: Neuron Measurement | None | 7 |
| 2 | Task 1: Types | None | 2 |
| 3 | Task 2: JSON Parser | Task 1 | 5 |
| 4 | Task 3: Specialists | Tasks 1, 2 | 5 |
| 5 | Task 4: Merge Layer | Tasks 1, 3 | 5 |
| 6 | Task 5: Validation Loop | Tasks 1, 3 | 5 |
| 7 | Task 6: Orchestrator | Tasks 3, 4, 5 | 5 |
| 8 | Task 7: Wire Into Worker | Task 6 | 5 |
| 9 | Task 8: Deploy Infrastructure | Task 7 | 4 |
| 10 | Task 9: E2E Test | Task 8 | 5 |

**Total:** 48 steps across 10 tasks.

**Note:** Task 0 results may require adjusting Tasks 3 and 6. If neuron cost is high, specialists will be consolidated (2-3 calls instead of 4). The type definitions and merge layer remain the same — only the number of parallel AI calls changes.
