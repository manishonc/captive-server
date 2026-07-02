/**
 * Allowlist HTML sanitizer for `text` block content.
 *
 * VENDORED COPY — KEEP IN SYNC with cms/lib/email-blocks/sanitize.ts.
 * DOM-free so it runs identically in the browser (editor paste), Next.js API
 * routes (campaign validation) and here. Only a small set of
 * inline-formatting tags survives; every attribute is dropped except a
 * validated `href` on <a> and a validated `style="color:#hex"` on <span>.
 * Everything else is escaped, not stripped.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'span',
]);

const VOID_TAGS = new Set(['br']);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MERGE_TOKEN_HREF = /^\{\{\s*(unsubscribeUrl|ratingUrl)\s*\}\}$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (MERGE_TOKEN_HREF.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'mailto:') return value;
  } catch {
    /* fall through */
  }
  return null;
}

/** Extract a single attribute value from a raw attribute string. */
function attrValue(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/**
 * Sanitize rich-text HTML down to the email-safe allowlist. Unknown tags are
 * escaped in place; disallowed attributes are removed.
 */
export function sanitizeTextHtml(input: string): string {
  if (!input) return '';

  return String(input).replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/g,
    (raw, tagName: string, attrs: string, selfClose: string) => {
      const tag = tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return escapeHtml(raw);

      const isClosing = raw.startsWith('</');
      if (isClosing) {
        return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
      }

      if (tag === 'a') {
        const hrefRaw = attrValue(attrs, 'href');
        const validated = hrefRaw ? safeHref(hrefRaw) : null;
        // Anchors without a safe href would render as dead links — keep the
        // text but drop the anchor semantics by escaping the tag.
        if (!validated) return escapeHtml(raw);
        return `<a href="${escapeHtml(validated)}" target="_blank" rel="noopener">`;
      }

      if (tag === 'span') {
        const style = attrValue(attrs, 'style');
        const colorMatch = style ? style.match(/color\s*:\s*(#[0-9a-fA-F]{6})/) : null;
        if (colorMatch && HEX_COLOR.test(colorMatch[1])) {
          return `<span style="color:${colorMatch[1]};">`;
        }
        return '<span>';
      }

      if (VOID_TAGS.has(tag)) return `<${tag} />`;
      return `<${tag}${selfClose ? ' /' : ''}>`;
    });
}

export { escapeHtml };
