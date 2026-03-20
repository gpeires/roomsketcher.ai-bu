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
  polygon?: Array<{ x: number; y: number }>;
}

export interface CVResult {
  name: string;
  rooms: CVRoom[];
  meta: {
    walls_detected: number;
    rooms_detected: number;
    text_regions: number;
    scale_cm_per_px: number;
    image_size?: [number, number];   // [width, height] from CV service
    image_width?: number;            // legacy / tests
    image_height?: number;           // legacy / tests
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
    specialist_errors?: Record<string, string>;
    specialist_data?: Record<string, unknown>;  // parsed specialist outputs for debugging
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
  neuronBudget: 50_000,
  neuronBudgetBuffer: 5_000,
} as const;
