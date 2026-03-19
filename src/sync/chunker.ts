import { htmlToText } from './html-to-text';

const MIN_CHUNK_LENGTH = 150;

export interface ArticleChunk {
  id: string;
  heading: string;
  content: string;
}

/**
 * Deterministic chunk ID — hex hash of `articleId:heading`.
 * Stable across sync cycles so agent_insights.source_chunk_ids stay valid.
 */
export function chunkId(articleId: number, heading: string, index?: number): string {
  const input = index !== undefined
    ? `${articleId}:${heading}:${index}`
    : `${articleId}:${heading}`;
  const hash = Array.from(new TextEncoder().encode(input))
    .reduce((h, b) => ((h << 5) - h + b) | 0, 0);
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Split article HTML into chunks by H2/H3 headers.
 * Returns plain-text chunks with deterministic IDs.
 */
export function chunkArticle(
  articleId: number,
  articleTitle: string,
  bodyHtml: string,
): ArticleChunk[] {
  if (!bodyHtml?.trim()) return [];

  // Split by H2/H3 boundaries
  const headerRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const sections: { heading: string; html: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let preHeaderHtml = '';

  while ((match = headerRegex.exec(bodyHtml)) !== null) {
    // Capture content before first header
    if (sections.length === 0 && match.index > 0) {
      preHeaderHtml = bodyHtml.slice(0, match.index);
    } else if (sections.length > 0) {
      sections[sections.length - 1].html = bodyHtml.slice(lastIndex, match.index);
    }
    const headingText = match[1].replace(/<[^>]+>/g, '').trim();
    sections.push({ heading: headingText, html: '' });
    lastIndex = match.index + match[0].length;
  }

  // No headers — whole article is one chunk
  if (sections.length === 0) {
    const content = htmlToText(bodyHtml);
    if (!content.trim()) return [];
    return [{
      id: chunkId(articleId, articleTitle),
      heading: articleTitle,
      content,
    }];
  }

  // Capture trailing content for last section
  if (sections.length > 0) {
    sections[sections.length - 1].html = bodyHtml.slice(lastIndex);
  }

  // Prepend pre-header content to first section
  if (preHeaderHtml.trim()) {
    sections[0].html = preHeaderHtml + sections[0].html;
  }

  // Convert HTML to text
  let chunks: { heading: string; content: string }[] = sections.map(s => ({
    heading: s.heading,
    content: htmlToText(s.html),
  }));

  // Merge short chunks with the next (or previous if last)
  const merged: { heading: string; content: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].content.length < MIN_CHUNK_LENGTH && i < chunks.length - 1) {
      // Merge into next chunk
      chunks[i + 1].content = chunks[i].content + '\n' + chunks[i + 1].content;
    } else if (chunks[i].content.length < MIN_CHUNK_LENGTH && merged.length > 0) {
      // Merge into previous chunk
      merged[merged.length - 1].content += '\n' + chunks[i].content;
    } else {
      merged.push(chunks[i]);
    }
  }

  // Assign deterministic IDs, deduplicating same-heading
  const headingCounts = new Map<string, number>();
  return merged.map(chunk => {
    const count = headingCounts.get(chunk.heading) ?? 0;
    headingCounts.set(chunk.heading, count + 1);
    const id = count === 0
      ? chunkId(articleId, chunk.heading)
      : chunkId(articleId, chunk.heading, count);
    return { id, heading: chunk.heading, content: chunk.content };
  });
}
