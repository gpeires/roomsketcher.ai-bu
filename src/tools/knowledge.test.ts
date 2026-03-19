import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery, validateInsight } from './knowledge';

describe('sanitizeFtsQuery', () => {
  it('strips FTS5 special characters and wraps terms with wildcard suffix', () => {
    const result = sanitizeFtsQuery('bathroom "fixtures"');
    expect(result).toContain('"bathroom"*');
    expect(result).toContain('"fixtures"*');
    expect(result).not.toContain('""');
  });

  it('handles multi-word queries', () => {
    const result = sanitizeFtsQuery('kitchen layout');
    expect(result).toBe('"kitchen"* "layout"*');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('  ')).toBe('');
  });
});

describe('validateInsight', () => {
  it('rejects empty content', () => {
    const result = validateInsight({ content: '', confidence: 0.5 });
    expect(result.error).toBe('Insight content is required');
  });

  it('clamps confidence to 0-1 range', () => {
    const result = validateInsight({ content: 'test', confidence: 1.5 });
    expect(result.confidence).toBe(1.0);

    const low = validateInsight({ content: 'test', confidence: -0.3 });
    expect(low.confidence).toBe(0.0);
  });

  it('accepts valid input', () => {
    const result = validateInsight({ content: 'L-shaped kitchens need wide aisles', confidence: 0.8 });
    expect(result.error).toBeUndefined();
    expect(result.confidence).toBe(0.8);
  });
});
