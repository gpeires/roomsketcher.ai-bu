# AI-Layered CV Pipeline Design

## Problem

The CV service detects rooms from floor plan images using pure OpenCV morphology. On real-world floor plans (e.g., 547 W 47th St Residence 507), it detects 4 of 7-8 rooms, assigns 1 of 5 labels, and finds 1 of 6 doors. Claude Chat must do heavy manual correction, which is slow and error-prone.

OpenCV has a hard ceiling: it works on clean architectural drawings but struggles with thin partition walls, rooms that merge through door gaps, and semantic understanding (knowing a toilet symbol means "this is a separate bathroom").

## Solution

Replace the single-pass CV pipeline with a **multi-specialist parallel architecture** that combines OpenCV geometry with Workers AI vision models. Multiple focused AI passes each answer one narrow question. A deterministic merge layer reconciles all inputs. A validation feedback loop catches mistakes.

All AI inference runs on **Cloudflare Workers AI free tier** (10,000 neurons/day) via **AI Gateway** (caching, logging, rate limiting).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Worker (orchestrator)                   │
│                                                     │
│  Image arrives                                      │
│    │                                                │
│    ├── Stage 1: GATHER (parallel)                   │
│    │   ├─ CV Service (Hetzner) → geometry           │
│    │   ├─ Workers AI: Room Namer                    │
│    │   ├─ Workers AI: Layout Describer              │
│    │   ├─ Workers AI: Symbol Spotter                │
│    │   └─ Workers AI: Dimension Reader              │
│    │                                                │
│    ├── Stage 2: MERGE (deterministic)               │
│    │   └─ Reconcile all inputs → unified model      │
│    │                                                │
│    ├── Stage 3: VALIDATE (AI feedback loop)         │
│    │   └─ Compare merged result vs original image   │
│    │   └─ Apply corrections, max 2 iterations       │
│    │                                                │
│    └── Stage 4: OUTPUT                              │
│        └─ Final JSON (rooms, openings, adjacency)   │
│                                                     │
│  CF AI Gateway: caching, logging, rate limiting     │
└─────────────────────────────────────────────────────┘
```

### Key decisions

- **Orchestration lives in the Cloudflare Worker**, not the CV service. The Worker already talks to both the CV service and (with this change) Workers AI. No AI added to the Python service.
- **CV service unchanged.** It stays deterministic, focused on geometry extraction. No modifications needed.
- **AI Gateway wraps all Workers AI calls.** Caching means re-analyzing the same image costs zero neurons.
- **All new infrastructure provisioned by deploy.sh.** AI Gateway, AI bindings, everything. Delete all infra, run the script, everything rebuilds.

## Stage 1: Gather — Specialist Passes

Five parallel calls, each with a single focused job. Narrow prompts on small models outperform one complex prompt.

### Failure handling

Each specialist call is wrapped with try/catch and a per-call timeout (15s for AI, 30s for CV). The pipeline uses **graceful degradation**:

- **CV geometry is required.** If it fails, the entire pipeline fails with an error (same as today).
- **AI passes are enrichment, not requirements.** If any AI specialist fails (timeout, malformed response, model error), the merge layer proceeds without that input. The confidence scores will be lower, and Claude Chat will need to do more manual correction — but the pipeline still returns a result.
- **Partial results are always better than no results.** Even CV-only output (the current behavior) is a valid degraded mode.

### JSON response parsing

Llama 3.2 11B Vision does not reliably return clean JSON. Every specialist response parser must:

1. Strip markdown code fences (` ```json ... ``` `)
2. Attempt `JSON.parse` on the full response
3. Fall back to regex extraction of the first `[...]` or `{...}` block
4. Return a typed `SpecialistFailure` if nothing parseable, which the merge layer skips gracefully

### CV Geometry (existing, unchanged)

- **Runs on:** Hetzner (Python/Docker)
- **Input:** Floor plan image
- **Output:** `{rooms: [{bbox, mask, polygon}], walls, text_regions, openings, adjacency}`
- **Latency:** ~2-3s

### Room Namer

- **Runs on:** Workers AI (Llama 3.2 11B Vision)
- **Prompt:** "List every room label visible in this floor plan image. Return as a JSON array of strings. Use only these standard names where applicable: Bedroom, Bathroom, Kitchen, Living Room, Dining Room, Foyer, Hall, Corridor, Walk-In Closet, Dressing Room, Laundry Room, Utility Room, Storage, Balcony, Terrace, Office, Garage, WC, Half Bath, Pantry, Family room, Primary Bedroom, Guestroom, Childrens room."
- **Output:** `["Bedroom", "Primary Bedroom", "Living & Dining", "Foyer", "Dressing Room"]`

### Layout Describer

- **Runs on:** Workers AI (Llama 3.2 11B Vision)
- **Prompt:** "How many separate rooms are in this floor plan? For each room, describe its position (top-left, top-right, center, bottom, etc.) and approximate relative size (small, medium, large). Return as JSON: {room_count: N, rooms: [{name, position, size}]}"
- **Output:** `{room_count: 7, rooms: [{name: "Bedroom", position: "top-left", size: "medium"}, ...]}`

### Symbol Spotter

- **Runs on:** Workers AI (Llama 3.2 11B Vision)
- **Prompt:** "List every fixture and symbol visible in this floor plan. Look for: Toilet, Sink, Bathtub, Shower, Fridge, Stove/Range, Dishwasher, Oven, Washer/Dryer, Kitchen Island, Bed, Sofa, Dining Table, Desk, Closet rod, Fireplace. For each, give the type and approximate position. Return as JSON array: [{type, position}]"
- **Output:** `[{type: "Toilet", position: "center-top"}, {type: "Shower", position: "center-top"}, {type: "Stove", position: "center-right"}, ...]`

### Dimension Reader

- **Runs on:** Workers AI (Llama 3.2 11B Vision)
- **Prompt:** "List every dimension measurement visible in this floor plan. Include the text exactly as shown and which room or area it refers to. Return as JSON array: [{text, room_or_area}]"
- **Output:** `[{text: "10'-8\" x 8'-1\"", room_or_area: "Bedroom"}, ...]`

### Neuron budget

**Important: Neuron costs must be validated before implementation.** Vision model inference on Llama 3.2 11B is significantly more expensive than text-only. A single vision call with a floor plan image may cost 1,000-3,000+ neurons, not 200.

**Implementation step 0:** Run a single test call via `wrangler dev` to measure actual neuron consumption for one Llama 3.2 11B Vision call with a real floor plan image. Then adjust the architecture:

| Scenario | Cost per analysis | Daily capacity (free) | Action |
|---|---|---|---|
| ~200 neurons/call (optimistic) | ~1,400 total | ~7 analyses | Full 5-specialist pipeline |
| ~1,000 neurons/call (likely) | ~7,000 total | ~1-2 analyses | Reduce to 3 specialists, combine Room Namer + Layout Describer |
| ~2,000+ neurons/call (worst) | ~14,000+ total | <1 analysis | Use `uform-gen2-qwen-500m` for all but validation pass |

**Fallback strategy:** If neuron budget is too tight for 5 parallel passes, combine Room Namer + Layout Describer into one call, and Dimension Reader into the Symbol Spotter call. This gives 2 AI passes + CV + 1 validation = 4 calls total.

**Budget exhaustion behavior:** Track cumulative neuron usage via D1 counter (reset daily). When within 2,000 neurons of the 10k limit, skip AI enrichment and fall back to CV-only mode. Return `meta.pipeline_version: "1.0-cv-only"` so Claude Chat knows the output is unenhanced.

## Stage 2: Merge Layer

Deterministic code. No AI. Fully testable.

### Inputs

| Source | Provides | Trust level |
|---|---|---|
| CV Geometry | Wall positions, room masks, polygons, pixel coordinates | High for geometry, low for semantics |
| Room Namer | Canonical room labels | High for label text |
| Layout Describer | Room count, relative positions | Medium (may hallucinate count) |
| Symbol Spotter | Fixture types and positions | High for room-type inference |
| Dimension Reader | Measurement text and room association | Medium (OCR quality varies) |
| Tesseract (from CV) | Text regions with exact pixel coordinates | High for positions, low for semantics |

### Merge operations (in order)

**1. Room count reconciliation**

Compare CV room count vs Layout Describer room count. If they disagree, trust the higher count and flag the discrepancy for the validate stage.

**2. Room splitting**

For each CV region that's suspiciously large (area > image_area / expected_room_count × 1.5), check if Symbol Spotter found multiple incompatible fixture types inside it (e.g., toilet + bed = two rooms merged).

**v1 approach (best effort):** Room splitting is hard geometry. Rather than attempting automated polygon clipping, v1 flags suspected merged rooms with `"split_hint": true` and includes the symbol evidence in the output. The validate stage and Claude Chat can use this hint to guide manual splitting. Automated splitting is a v2 optimization once we have real-world data on how often merges occur and what patterns they follow.

**3. Label assignment**

Match labels to rooms using multiple signals, in priority order:
1. Tesseract text positions — if OCR text center falls inside a room mask, assign directly
2. Symbol-based inference — Toilet/Shower/Bathtub → Bathroom; Stove/Fridge → Kitchen; Bed → Bedroom; Washer/Dryer → Laundry Room; Closet rod → Walk-In Closet; Desk → Office
3. Room Namer labels matched to Layout Describer positions → map position descriptions to CV region centroids using a **3×3 spatial grid** (image divided into thirds: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right). Each CV region is assigned to the grid cell containing its centroid. AI position descriptions are mapped to the same grid. Matches are approximate — confidence is lower for position-based assignments than for text/symbol-based ones.
4. Normalize all labels to RoomSketcher canonical taxonomy

**4. Dimension binding**

Match Dimension Reader output to rooms:
1. Cross-reference with Tesseract pixel coordinates for exact placement
2. Use Layout Describer room associations as fallback
3. Parse imperial/metric formats (existing `dimensions.py` logic)
4. Override CV scale calibration where dimension-to-room matches are high confidence

**5. Confidence scoring**

Each room gets a score (0-1) based on source agreement:
- CV geometry exists: +0.3
- AI label assigned: +0.2
- Symbol-based type confirmed: +0.2
- Dimension matched: +0.15
- Multiple sources agree on label: +0.15

Rooms below 0.5 confidence are flagged for the validate stage.

## Stage 3: Validate (Feedback Loop)

After merge, a final AI pass catches mistakes.

### Flow

1. Take merged output (rooms with labels, positions, confidence scores)
2. Format as a structured description: "We detected N rooms: [Room 1: Bedroom at top-left, 325×245cm] [Room 2: ...]"
3. Send original image + description to Workers AI: "Here is a floor plan image. We analyzed it and found these rooms: [list]. Does this match the image? List any: (a) missing rooms, (b) wrong labels, (c) rooms that should be merged or split. Return as JSON: {correct: bool, corrections: [{type, description}]}"
4. Parse corrections. Apply to merged output.
5. If corrections were significant (room added/removed/renamed), loop once more. Max 2 iterations.

### Exit conditions

- No corrections → done
- Minor corrections only (label tweak) → apply and done
- Major corrections after 2nd pass → apply, flag remaining low-confidence items, let Claude Chat handle the rest

### Streaming progress updates (future — not in v1)

The architecture naturally supports progress updates. When SSE streaming is implemented (future phase), the worker would send:

```
"Analyzing walls and geometry..."        → CV running
"Reading room labels..."                 → Room Namer
"Understanding layout..."                → Layout Describer
"Identifying fixtures..."                → Symbol Spotter
"Reading dimensions..."                  → Dimension Reader
"Merging results..."                     → Merge layer
"Validating against image..."            → Validate pass 1
"Applying corrections..."                → Validate pass 2
"Done — 7 rooms, 5 doors, 3 windows"    → Final output
```

## Stage 4: Output

Same format as current CV output, extended with confidence data:

```json
{
  "name": "Floor Plan",
  "rooms": [
    {
      "label": "Bedroom",
      "x": 0, "y": 0, "width": 325, "depth": 245,
      "type": "bedroom",
      "confidence": 0.85,
      "sources": ["cv", "room_namer", "symbol_spotter", "dimension_reader"]
    }
  ],
  "openings": [...],
  "adjacency": [...],
  "meta": {
    "image_size": [1179, 1618],
    "scale_cm_per_px": 0.85,
    "walls_detected": 60,
    "rooms_detected": 7,
    "ai_corrections": 2,
    "validation_passes": 1,
    "neurons_used": 1400,
    "pipeline_version": "2.0"
  }
}
```

## Infrastructure

### New Cloudflare resources (all provisioned by deploy.sh)

1. **AI binding** in wrangler.toml:
   ```toml
   [ai]
   binding = "AI"
   ```

2. **AI Gateway** created via CF API:
   ```
   POST /accounts/{account_id}/ai-gateway/gateways
   { "id": "roomsketcher-ai", "name": "RoomSketcher AI Gateway" }
   ```

3. **deploy.sh additions:**
   - Check/create AI Gateway (idempotent)
   - AI binding is declarative in wrangler.toml (no API call needed)
   - Health check extended to verify AI binding works

### Model selection

Primary: `@cf/meta/llama-3.2-11b-vision-instruct` — best vision capability on Workers AI free tier.

Fallback: `@cf/unum/uform-gen2-qwen-500m` — smaller/faster, for retry on timeout or if neuron budget is tight. **Note:** Specialist prompts may need simplified versions for the fallback model, as a 500M model has significantly weaker instruction-following than 11B. Test both during implementation step 0.

### Caching strategy

AI Gateway caches by exact request body. Same image + same prompt = cache hit. Set TTL to 24 hours. A re-analysis of the same image within a day costs zero neurons.

**Cache normalization:** Images must be passed as consistent base64 to maximize cache hits. If an image arrives via URL, fetch it once at the start of the pipeline, convert to base64, and pass the same bytes to all specialists. Re-encoding (e.g., JPEG → PNG → base64) will break cache — always use the original bytes.

## Files to modify/create

### Worker (src/)
- `src/ai/orchestrator.ts` — New. Pipeline orchestrator: gather → merge → validate → output
- `src/ai/specialists.ts` — New. Individual specialist prompt definitions and response parsers
- `src/ai/merge.ts` — New. Deterministic merge layer logic
- `src/ai/validate.ts` — New. Validation feedback loop
- `src/ai/types.ts` — New. TypeScript types for specialist outputs, merge state, confidence scores
- `src/sketch/tools.ts` — Modify. Wire `handleAnalyzeImage` to use new orchestrator instead of direct CV call
- `src/types.ts` — Modify. Add `AI: Ai` to the `Env` interface (from `@cloudflare/workers-types`). Thread the binding through to the orchestrator via function parameter, not global state.
- `wrangler.toml` — Modify. Add `[ai]` binding

### Deploy
- `deploy.sh` — Modify. Add AI Gateway provisioning step

### Tests
- `src/ai/__tests__/merge.test.ts` — New. Merge layer unit tests. Key scenarios:
  - All 5 sources agree on room count and labels
  - CV detects 4 rooms, Layout Describer says 7 (room splitting hints)
  - One specialist returns `SpecialistFailure` (graceful skip)
  - JSON parse failure on AI response (regex fallback)
  - Symbol Spotter finds toilet in a room CV labeled "Room 3" → relabeled "Bathroom"
  - Position grid mapping: "top-left" matches room with lowest centroid
  - Confidence scoring: room with all sources = high, room with only Layout Describer = low
- `src/ai/__tests__/orchestrator.test.ts` — New. Integration tests with mocked AI responses
- `src/ai/__tests__/parse-json.test.ts` — New. JSON extraction from messy LLM output (fences, commentary, partial)

## Out of scope

- Furniture placement from symbols (future — tracked in memory)
- Expanding furniture catalog to match full RoomSketcher taxonomy (future — tracked in memory)
- Non-English label support (taxonomy CSV has Danish, German, Norwegian, Swedish — future phase)
- Real-time streaming SSE for progress updates (design supports it, implementation deferred)
