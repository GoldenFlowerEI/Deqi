/**
 * v3.5: tiny HTML utilities (no full parser — just what the browser tool needs).
 *
 * `extractText(html)`: strip tags, decode the most common entities,
 *   collapse whitespace. Good enough for "what does the page say".
 *
 * `extractBySelector(html, selector)`: very small selector support:
 *   - `tag` (any tag name)
 *   - `#id`
 *   - `tag#id`
 *   - `tag.class` (matches the first element with that class)
 *   No nested/structural selectors. v3.5.1 can add `linkedom`/`cheerio`
 *   if a real parser is needed.
 *
 * These are intentionally minimal so we have ZERO extra dependencies.
 * A real headless browser (Puppeteer/Playwright) is the v3.5.1 path
 * for screenshot + complex DOM queries.
 */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&copy;': '(c)', '&reg;': '(r)',
  '&hellip;': '...', '&mdash;': '—', '&ndash;': '–',
};

function decodeEntities(s: string): string {
  return s.replace(/&[#a-z0-9]+;/gi, (m) => ENTITY_MAP[m] ?? m);
}

/** Strip tags and collapse whitespace. */
export function extractText(html: string): string {
  // Drop <script> and <style> blocks entirely
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const text = noScript.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function parseSimpleSelector(selector: string): { tag: string | null; id: string | null; className: string | null } {
  const tagMatch = selector.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
  return {
    tag: tagMatch ? tagMatch[1]!.toLowerCase() : null,
    id: idMatch ? idMatch[1]! : null,
    className: classMatch ? classMatch[1]! : null,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the text of the first element matching a simple selector. */
export function extractBySelector(html: string, selector: string): string | null {
  const { tag, id, className } = parseSimpleSelector(selector);
  if (!tag && !id && !className) return null;
  // We need to find an OPENING tag that has the matching attribute,
  // then capture content up to the matching closing tag. The naive
  // `<(tag)>(...)<\/tag>` regex would match the outermost <html>...</html>
  // first, which usually doesn't carry the id/class we're looking for.
  // Fix: build a regex that REQUIRES the attribute on the opening tag.
  let re: RegExp;
  if (id) {
    const idRe = `id=["']${escapeRegex(id)}["']`;
    re = new RegExp(
      `<([a-zA-Z][a-zA-Z0-9]*)([^>]*)(${idRe})([^>]*)>([\\s\\S]*?)<\\/\\1>`,
      'i',
    );
  } else if (className) {
    const clsRe = `class=["'][^"']*\\b${escapeRegex(className)}\\b[^"']*["']`;
    re = new RegExp(
      `<([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(${clsRe})([^>]*)>([\\s\\S]*?)<\\/\\1>`,
      'i',
    );
  } else {
    // Just the tag — first match wins.
    re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'i');
  }
  const m = re.exec(html);
  if (!m) return null;
  if (id || className) {
    // m[5] is the body when id matched; m[2] may be the body for class.
    const body = id ? m[5] : m[5];
    return body !== undefined ? extractText(`<x>${body}</x>`) : null;
  }
  return m[2] !== undefined ? extractText(`<x>${m[2]}</x>`) : null;
}
