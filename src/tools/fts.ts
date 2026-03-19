/**
 * Sanitize user input for FTS5 MATCH syntax.
 * Removes special chars, wraps each term in quotes with wildcard suffix.
 */
export function sanitizeFtsQuery(query: string): string {
  const sanitized = query
    .replace(/["\*\(\)\-\^:+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return '';
  return sanitized
    .split(' ')
    .filter(Boolean)
    .map(term => `"${term}"*`)
    .join(' ');
}
