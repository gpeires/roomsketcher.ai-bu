/**
 * Lightweight HTML-to-text converter for Zendesk article bodies.
 * No DOM needed — runs in Cloudflare Workers.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html;

  // Remove script/style blocks entirely
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Replace common block elements with newlines
  text = text.replace(/<\/?(p|div|br|hr|h[1-6]|ul|ol|table|tr|blockquote)[^>]*>/gi, '\n');

  // List items get bullet points
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  // Table cells get tabs
  text = text.replace(/<\/?(td|th)[^>]*>/gi, '\t');

  // Extract href from links: [text](url)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, linkText) => {
    const clean = linkText.replace(/<[^>]+>/g, '').trim();
    // Skip if link text is same as href or empty
    if (!clean || clean === href) return href;
    return `${clean} (${href})`;
  });

  // Remove image tags but keep alt text
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1');
  text = text.replace(/<img[^>]*>/gi, '');

  // Remove iframes (embedded videos etc.)
  text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

  // Normalize whitespace: collapse multiple spaces/tabs on same line
  text = text.replace(/[ \t]+/g, ' ');

  // Collapse 3+ newlines into 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim each line
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');

  return text.trim();
}
