/**
 * FileTree — read-only directory tree (for @-mention in the
 * composer and for the Files tab in the left rail).
 *
 * v2.1 calls GET /v1/files?path=… on the server, which walks
 * the cwd up to 4 levels deep, skipping node_modules / .git /
 * target / dist / build. The tree is collapsible; clicking a
 * file inserts a `@path` mention into the composer.
 */

import { useEffect, useState } from 'react';
import { DeqiApi } from '../lib/api';
import type { FileNode } from '../lib/types';

interface Props {
  api: DeqiApi;
  /** Optional initial path. Defaults to cwd root. */
  path?: string;
  /** Called when the user clicks a file. */
  onPick?: (path: string) => void;
  /** Hide the toolbar / root label — used when embedded in composer. */
  compact?: boolean;
}

export function FileTree({ api, path = '.', onPick, compact = false }: Props) {
  const [node, setNode] = useState<FileNode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    try {
      const { node } = await api.listFiles(path);
      setNode(node);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    reload();
  }, [path]);

  if (err) return <div className="file-tree-error">⚠ {err}</div>;
  if (!node) return <div className="file-tree-busy">Loading…</div>;
  if (compact) {
    return (
      <div className="file-tree compact">
        {node.children?.map((c) => (
          <FileTreeItem key={c.path} node={c} depth={0} onPick={onPick} />
        ))}
      </div>
    );
  }
  return (
    <div className="file-tree">
      <div className="file-tree-head">
        <span className="file-tree-root">{node.path}</span>
        <button className="file-tree-refresh" onClick={reload} disabled={busy}>
          {busy ? '…' : '↻'}
        </button>
      </div>
      <div className="file-tree-body">
        {node.children?.map((c) => (
          <FileTreeItem key={c.path} node={c} depth={0} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function FileTreeItem({
  node,
  depth,
  onPick,
}: {
  node: FileNode;
  depth: number;
  onPick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (node.kind === 'file') {
    return (
      <div
        className="file-row file"
        style={{ paddingLeft: depth * 14 + 18 }}
        onClick={() => onPick?.('@' + node.path)}
        title={node.path}
      >
        <span className="file-icon">·</span>
        <span className="file-name">{node.name}</span>
        {node.size != null && node.size < 100_000 && (
          <span className="file-size">{formatSize(node.size)}</span>
        )}
      </div>
    );
  }
  return (
    <>
      <div
        className="file-row dir"
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="file-icon">{open ? '▾' : '▸'}</span>
        <span className="file-name">{node.name}</span>
        <span className="file-count">{(node.children?.length ?? 0)}</span>
      </div>
      {open && node.children?.map((c) => (
        <FileTreeItem key={c.path} node={c} depth={depth + 1} onPick={onPick} />
      ))}
    </>
  );
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
