import { describe, it, expect } from 'vitest';
import { chunkId, chunkArticle } from './chunker';

describe('chunkId', () => {
  it('returns a deterministic 8-char hex string', () => {
    const id = chunkId(123, 'Bathroom Fixtures');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(chunkId(123, 'Bathroom Fixtures')).toBe(id); // deterministic
  });

  it('returns different IDs for different inputs', () => {
    expect(chunkId(123, 'A')).not.toBe(chunkId(123, 'B'));
    expect(chunkId(1, 'A')).not.toBe(chunkId(2, 'A'));
  });
});

describe('chunkArticle', () => {
  it('returns empty array for empty/null body', () => {
    expect(chunkArticle(1, 'Test', '')).toEqual([]);
    expect(chunkArticle(1, 'Test', '   ')).toEqual([]);
  });

  it('splits by H2 headers', () => {
    const html = '<h2>Section A</h2><p>Content A</p><h2>Section B</h2><p>Content B here with enough text to pass the minimum length threshold for chunking</p>';
    const chunks = chunkArticle(100, 'Test Article', html);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe('Section A');
    expect(chunks[0].content).toContain('Content A');
    expect(chunks[1].heading).toBe('Section B');
  });

  it('splits by H3 headers', () => {
    const html = '<h3>Sub A</h3><p>Content A is long enough to be a real chunk on its own</p><h3>Sub B</h3><p>Content B is also long enough to be a standalone chunk</p>';
    const chunks = chunkArticle(200, 'Test', html);
    expect(chunks).toHaveLength(2);
  });

  it('uses article title as heading when no H2/H3 exists', () => {
    const html = '<p>Just a paragraph with enough content to be meaningful and pass any minimum length checks.</p>';
    const chunks = chunkArticle(300, 'My Article', html);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('My Article');
  });

  it('merges short chunks with the next chunk', () => {
    const html = '<h2>Short</h2><p>Hi</p><h2>Long Section</h2><p>This section has plenty of content to stand on its own as a meaningful knowledge chunk.</p>';
    const chunks = chunkArticle(400, 'Test', html);
    expect(chunks).toHaveLength(1); // "Short" merged into "Long Section"
    expect(chunks[0].content).toContain('Hi');
    expect(chunks[0].content).toContain('plenty of content');
  });

  it('deduplicates same-heading by appending index', () => {
    const html = '<h2>FAQ</h2><p>First FAQ section with enough content to be a real chunk on its own in isolation.</p><h2>FAQ</h2><p>Second FAQ section also with enough content to be its own standalone chunk here.</p>';
    const chunks = chunkArticle(500, 'Test', html);
    // Both should exist with unique IDs
    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
