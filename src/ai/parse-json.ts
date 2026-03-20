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
