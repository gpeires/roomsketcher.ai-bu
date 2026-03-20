// src/ai/parse-json.ts
import { jsonrepair } from 'jsonrepair';

/**
 * Extract JSON from messy LLM output (optimized for small models like Llama 3.2).
 *
 * Strategy (matching storypress parsing patterns):
 * 1. Preprocess — strip envelope wrapping, double-stringified content
 * 2. Strip markdown code fences
 * 3. Try JSON.parse on cleaned string
 * 4. Brace-counting extraction — find first { or [ and match closing bracket
 * 5. jsonrepair as final fallback — handles trailing commas, missing brackets, etc.
 * 6. Return null if nothing works
 */
export function parseJsonResponse(raw: string): unknown | null {
  // Handle non-string input (e.g., AI returns object directly)
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // Step 1: preprocess — check for proxy envelope wrapping
  let text = raw.trim();
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope === 'object' && 'content' in envelope && typeof envelope.content === 'string') {
      text = envelope.content.trim();
    }
  } catch { /* not an envelope, continue */ }

  // Unwrap double-stringified content (model returns "\"[...]\"")
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const unwrapped = JSON.parse(text);
      if (typeof unwrapped === 'string') text = unwrapped.trim();
    } catch { /* not double-stringified */ }
  }

  // Step 2: strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Step 3: try direct parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Step 4: brace-counting extraction — more precise than greedy regex
  const jsonStr = extractBalancedJson(text);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch { /* try repair on extracted block */ }

    // Step 5: jsonrepair on the extracted block
    try {
      return JSON.parse(jsonrepair(jsonStr));
    } catch { /* continue */ }
  }

  // Step 5b: jsonrepair on full text as last resort
  try {
    const repaired = JSON.parse(jsonrepair(text));
    // Only return objects/arrays — scalar strings from repair aren't useful
    if (repaired !== null && typeof repaired === 'object') return repaired;
  } catch { /* give up */ }

  return null;
}

/**
 * Find the first balanced JSON block using brace/bracket counting.
 * Skips characters inside string literals to avoid false matches.
 */
function extractBalancedJson(text: string): string | null {
  // Find first { or [
  let start = -1;
  let openChar = '';
  let closeChar = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      start = i;
      openChar = text[i];
      closeChar = text[i] === '{' ? '}' : ']';
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Unbalanced — return from start to end as best effort for jsonrepair
  return text.slice(start);
}
