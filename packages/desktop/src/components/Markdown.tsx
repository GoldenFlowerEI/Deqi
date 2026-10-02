/**
 * Markdown.tsx — renders assistant replies.
 *
 * Assistant output is Markdown, and it was being shown as one long
 * <div> of plain text: `**bold**` showed its asterisks, every list
 * ran together, and a 40-line diff was a wall. For a harness whose
 * whole job is reading what the agent did, that was the single worst
 * rendering bug in the app.
 *
 * Why react-markdown
 * ------------------
 * It builds React elements; it never touches `dangerouslySetInnerHTML`.
 * That matters here more than usual: agent output is the least
 * trustworthy text in the product, and a hand-rolled renderer is a
 * permanent invitation to add one by accident. The default
 * `urlTransform` also strips `javascript:` hrefs, which a DIY
 * `<a href={...}>` would not.
 *
 * What the overrides do
 * ---------------------
 *   - code blocks get a language label and a copy button. In a coding
 *     agent "copy this" is a primary action, not a nicety.
 *   - links open outside the app. react-markdown gives the href to a
 *     component; we decide what "outside" means.
 *   - tables get a scroll container, because a wide diff table
 *     otherwise blows out the whole message column.
 */

import { useCallback, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLang } from '../lib/useLang';

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  // react-markdown puts the language on the className as
  // `language-tsx`; inline code has no className at all.
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
  const text = typeof children === 'string'
    ? children
    : Array.isArray(children) ? children.filter((c): c is string => typeof c === 'string').join('')
    : String(children ?? '');
  const isBlock = lang !== undefined || text.includes('\n');

  const copy = useCallback(() => {
    // Strip the trailing newline the fence leaves behind. Pasting it
    // into an editor adds a blank line the author never wrote, and
    // "copy" is supposed to give you the code, not the markdown.
    const payload = text.replace(/\n$/, '');
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => { /* clipboard denied — the code is still selectable */ });
  }, [text]);

  if (!isBlock) {
    return <code className="md-inline-code">{children}</code>;
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang ?? 'text'}</span>
        <button type="button" className="md-code-copy" onClick={copy}>
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre className="md-code-body"><code>{text}</code></pre>
    </div>
  );
}

const components: Components = {
  code: ({ className, children }) => (
    <CodeBlock className={className}>{children}</CodeBlock>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      // noopener/noreferrer: the target page must not get a handle on
      // this window. An agent that emits a link can pick the URL.
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table-scroll"><table>{children}</table></div>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        // A `javascript:` href from model output is the one thing
        // here that could execute. react-markdown's default
        // urlTransform already drops those; this line says so out
        // loud, so a future upgrade that changes the default does not
        // silently remove the protection.
        urlTransform={(url) => (/^(https?:|mailto:|#|\/)/i.test(url) ? url : '')}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
