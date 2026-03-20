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
): Promise<GatherResults & { _errors?: Record<string, string> }> {
  const fail = (specialist: string, error: string): SpecialistFailure => ({
    ok: false, specialist, error,
  });

  const errors: Record<string, string> = {};
  const catchAndLog = (specialist: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    errors[specialist] = msg;
    console.error(`[AI] ${specialist} failed:`, msg);
    return null;
  };

  const [cvResult, roomNamerRaw, layoutDescriberRaw, symbolSpotterRaw, dimensionReaderRaw] =
    await Promise.all([
      callCvService(input, name, config.cvServiceUrl, config.cvTimeoutMs),
      callVisionSpecialist(config.ai, config.model, ROOM_NAMER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(catchAndLog('roomNamer')),
      callVisionSpecialist(config.ai, config.model, LAYOUT_DESCRIBER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(catchAndLog('layoutDescriber')),
      callVisionSpecialist(config.ai, config.model, SYMBOL_SPOTTER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(catchAndLog('symbolSpotter')),
      callVisionSpecialist(config.ai, config.model, DIMENSION_READER_PROMPT, imageBytes, config.aiTimeoutMs)
        .catch(catchAndLog('dimensionReader')),
    ]);

  // Parse results, capturing failures with raw response for debugging
  const parseOrFail = <T>(
    raw: string | null,
    specialist: string,
    parser: (s: string) => T | SpecialistFailure,
  ): T | SpecialistFailure => {
    if (!raw) return fail(specialist, errors[specialist] || 'Call returned null');
    const parsed = parser(raw);
    if (parsed && typeof parsed === 'object' && 'ok' in parsed && !parsed.ok) {
      errors[specialist] = `Parse failed. Raw (first 300): ${raw.slice(0, 300)}`;
    }
    return parsed;
  };

  return {
    cv: cvResult,
    roomNamer: parseOrFail(roomNamerRaw, 'roomNamer', parseRoomNamerResponse),
    layoutDescriber: parseOrFail(layoutDescriberRaw, 'layoutDescriber', parseLayoutDescriberResponse),
    symbolSpotter: parseOrFail(symbolSpotterRaw, 'symbolSpotter', parseSymbolSpotterResponse),
    dimensionReader: parseOrFail(dimensionReaderRaw, 'dimensionReader', parseDimensionReaderResponse),
    _errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
}

// ─── Build output ────────────────────────────────────────────────────────────

export function buildPipelineOutput(
  name: string,
  rooms: MergedRoom[],
  cv: CVResult,
  stats: { corrections: number; passes: number; neuronsUsed: number; succeeded: string[]; failed: string[]; errors?: Record<string, string>; specialistData?: Record<string, unknown> },
): PipelineOutput {
  return {
    name,
    rooms,
    openings: [],
    adjacency: [],
    meta: {
      image_size: [cv.meta.image_size?.[0] ?? cv.meta.image_width ?? 0, cv.meta.image_size?.[1] ?? cv.meta.image_height ?? 0],
      scale_cm_per_px: cv.meta.scale_cm_per_px,
      walls_detected: cv.meta.walls_detected,
      rooms_detected: rooms.length,
      ai_corrections: stats.corrections,
      validation_passes: stats.passes,
      neurons_used: stats.neuronsUsed,
      pipeline_version: stats.failed.includes('budget_exhausted') ? '1.0-cv-only' : '2.0',
      specialists_succeeded: stats.succeeded,
      specialists_failed: stats.failed,
      ...(stats.errors && Object.keys(stats.errors).length > 0 && { specialist_errors: stats.errors }),
      ...(stats.specialistData && Object.keys(stats.specialistData).length > 0 && { specialist_data: stats.specialistData }),
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

  // Collect parsed specialist data for debugging
  const specialistData: Record<string, unknown> = {};
  if (gather.roomNamer.ok) specialistData.roomNamer = gather.roomNamer;
  if (gather.layoutDescriber.ok) specialistData.layoutDescriber = gather.layoutDescriber;
  if (gather.symbolSpotter.ok) specialistData.symbolSpotter = gather.symbolSpotter;
  if (gather.dimensionReader.ok) specialistData.dimensionReader = gather.dimensionReader;

  return buildPipelineOutput(name, validated, gather.cv, {
    corrections: totalCorrections,
    passes,
    neuronsUsed: estimatedNeurons,
    succeeded,
    failed,
    errors: gather._errors,
    specialistData,
  });
}
