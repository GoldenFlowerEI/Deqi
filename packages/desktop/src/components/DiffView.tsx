/**
 * DiffView.tsx — "here is what the agent changed".
 *
 * The diff is computed on the server, where the before and after text
 * both exist, and arrives as `unknown` on the wire. Narrowing it here
 * rather than casting it is the point: a client that trusts the
 * payload shape turns one bad event into a blank screen, and this
 * component sits directly over the main conversation.
 */

import { type DiffLine, type FileDiff } from '../lib/types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function narrowLine(v: unknown): DiffLine | null {
  if (!isRecord(v)) return null;
  if (v.op !== 'ctx' && v.op !== 'add' && v.op !== 'del') return null;
  if (typeof v.text !== 'string') return null;
  return {
    op: v.op,
    text: v.text,
    ...(typeof v.oldNo === 'number' ? { oldNo: v.oldNo } : {}),
    ...(typeof v.newNo === 'number' ? { newNo: v.newNo } : {}),
  };
}

/** Returns a usable diff, or null for anything we cannot trust. */
export function parseDiff(raw: unknown): FileDiff | null {
  if (!isRecord(raw)) return null;
  if (raw.change !== 'created' && raw.change !== 'modified' && raw.change !== 'deleted') return null;
  if (!Array.isArray(raw.lines)) return null;
  const lines: DiffLine[] = [];
  for (const l of raw.lines) {
    const n = narrowLine(l);
    if (!n) continue; // drop the bad line, keep the diff
    lines.push(n);
  }
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    change: raw.change,
    lines,
    added: typeof raw.added === 'number' ? raw.added : lines.filter((l) => l.op === 'add').length,
    removed: typeof raw.removed === 'number' ? raw.removed : lines.filter((l) => l.op === 'del').length,
    truncated: raw.truncated === true,
    ...(raw.tooLarge === true ? { tooLarge: true } : {}),
  };
}

export function DiffView({ raw }: { raw: unknown }) {  const diff = parseDiff(raw);
  if (!diff) return null;
  // A diff with nothing in it is not worth a collapsed row in the
  // transcript — the tool's own summary line already said it worked.
  // The `tooLarge` case is the exception: it legitimately has no lines,
  // and "this changed too much to show" IS the information.
  if (diff.lines.length === 0 && !diff.tooLarge) return null;

  if (diff.tooLarge) {
    // Say the truth instead of drawing a partial diff that looks
    // complete. A misleading diff is the one thing this must not do.
    return (
      <div className="diff diff-too-large" data-change={diff.change}>
        <div className="diff-head">
          <span className="diff-path">{diff.path}</span>
          <span className="diff-stat">
            <span className="diff-add">+{diff.added}</span>
            {' '}
            <span className="diff-del">−{diff.removed}</span>
          </span>
        </div>
        <p className="diff-note">Too large to show line by line.</p>
      </div>
    );
  }

  return (
    <div className="diff" data-change={diff.change}>
      <div className="diff-head">
        <span className="diff-path">{diff.path}</span>
        <span className="diff-stat">
          <span className="diff-add">+{diff.added}</span>
          {' '}
          <span className="diff-del">−{diff.removed}</span>
        </span>
      </div>
      <div className="diff-body">
        {diff.lines.map((l, i) => (
          <div key={i} className="diff-line" data-op={l.op}>
            <span className="diff-no">{l.op === 'add' ? '' : (l.oldNo ?? '')}</span>
            <span className="diff-no">{l.op === 'del' ? '' : (l.newNo ?? '')}</span>
            <span className="diff-sign">
              {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}
            </span>
            {/* A blank source line still needs width, or the row
                collapses and the lines around it look like one
                change. U+00A0 rather than a literal space: it survives
                any future `white-space` change, and writing it as an
                escape keeps the invisible character out of the source
                text, where it would be unfindable. */}
            <span className="diff-text">{l.text || '\u00a0'}</span>
          </div>
        ))}
      </div>
      {diff.truncated ? <p className="diff-note">… diff truncated.</p> : null}
    </div>
  );
}
