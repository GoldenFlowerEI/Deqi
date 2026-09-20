/**
 * ChatView — the main chat surface (renamed from ChatArea in v2.1).
 *
 * v2.1 changes vs v0.1:
 *   - 3-column: Files | Chat | Composer (vs 2-column Chat | Composer)
 *   - Files panel is collapsible; uses FileTree for @-mention
 *   - Composer has a model picker (left of Send) and a slash
 *     command menu (when the user types /)
 *   - Inline tool calls are structured blocks, not one line
 *   - Welcome state when no session is active
 *
 * The actual streaming / event coalescing is unchanged from the
 * v0.1 ChatArea; we just wrap it in a richer shell.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DeqiApi } from '../lib/api';
import { FileTree } from './FileTree';
import { ChatArea } from './ChatArea';
import { StatusBar } from './StatusBar';
import type { ModelInfo, ServerConfig, SessionEvent, SessionSummary } from '../lib/types';
import type { WsConnectionState } from '../lib/ws';

interface Props {
  api: DeqiApi;
  events: SessionEvent[];
  userPrompts: string[];
  busy: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  onAbort: () => void;
  config: ServerConfig | null;
  models: ModelInfo[];
  activeModel: string;
  onModelChange: (id: string) => void;
  connection: WsConnectionState;
  connectionInfo?: string;
  activeSession: SessionSummary | null;
}

const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'List all commands' },
  { cmd: '/clear', desc: 'Clear the chat (keeps session)' },
  { cmd: '/compact', desc: 'Compress history into summary' },
  { cmd: '/tree', desc: 'Show session tree' },
  { cmd: '/model', desc: 'Switch model' },
  { cmd: '/fork', desc: 'Fork a new branch' },
  { cmd: '/goto', desc: 'Jump to a node' },
  { cmd: '/goals', desc: 'List emergent goals' },
];

export function ChatView({
  api,
  events,
  userPrompts,
  busy,
  draft,
  setDraft,
  onSend,
  onAbort,
  config,
  models,
  activeModel,
  onModelChange,
  connection,
  connectionInfo,
  activeSession,
}: Props) {
  const [showFiles, setShowFiles] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isWelcome = events.length === 0 && userPrompts.length === 0;

  // Slash command menu + @-mention menu from the composer text
  useEffect(() => {
    const text = draft;
    if (text.startsWith('/') && !text.includes('\n') && text.length < 30) {
      setSlashOpen(true);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
    }
    const lastAt = text.lastIndexOf('@');
    if (lastAt >= 0) {
      const after = text.slice(lastAt + 1);
      if (!after.includes(' ') && after.length < 40) {
        setMentionOpen(true);
      } else {
        setMentionOpen(false);
      }
    } else {
      setMentionOpen(false);
    }
  }, [draft]);

  const slashFiltered = useMemo(() => {
    const q = draft.startsWith('/') ? draft.slice(1).toLowerCase() : '';
    return SLASH_COMMANDS.filter((s) => s.cmd.slice(1).includes(q));
  }, [draft]);

  const pickSlash = (cmd: string) => {
    setDraft(cmd + ' ');
    setSlashOpen(false);
    inputRef.current?.focus();
  };
  const insertMention = (path: string) => {
    const text = draft;
    const lastAt = text.lastIndexOf('@');
    const next = text.slice(0, lastAt) + path + ' ' + text.slice(lastAt + 1 + path.length - 0).replace(/^@?/, '');
    setDraft(next);
    setMentionOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashFiltered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashFiltered[slashIdx].cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className={'chat-view' + (showFiles ? ' with-files' : '')}>
      {showFiles && (
        <aside className="chat-files">
          <div className="chat-files-head">
            <span>Files</span>
            <button className="icon-btn" onClick={() => setShowFiles(false)}>×</button>
          </div>
          <div className="chat-files-body">
            <FileTree api={api} compact />
          </div>
        </aside>
      )}

      <div className="chat-main">
        <StatusBar
          connection={connection}
          info={connectionInfo}
          model={activeModel}
        />

        {isWelcome ? (
          <WelcomeState
            api={api}
            config={config}
            activeSession={activeSession}
            onPickPrompt={(p) => setDraft(p)}
          />
        ) : (
          <ChatArea events={events} userPrompts={userPrompts} busy={busy} />
        )}

        <div className="composer">
          <button
            className={'icon-btn files-toggle' + (showFiles ? ' active' : '')}
            title="Toggle file tree"
            onClick={() => setShowFiles((s) => !s)}
          >
            ⊞
          </button>
          <div className="composer-text-wrap">
            <textarea
              ref={inputRef}
              className="input"
              placeholder={
                mentionOpen
                  ? 'Pick a file…'
                  : slashOpen
                  ? 'Pick a command…'
                  : 'Type a task. / for commands, @ for files. Shift+Enter for newline.'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
            />
            {slashOpen && slashFiltered.length > 0 && (
              <div className="popover slash-popover">
                {slashFiltered.map((s, i) => (
                  <button
                    key={s.cmd}
                    className={'popover-item' + (i === slashIdx ? ' active' : '')}
                    onClick={() => pickSlash(s.cmd)}
                  >
                    <code>{s.cmd}</code>
                    <span>{s.desc}</span>
                  </button>
                ))}
              </div>
            )}
            {mentionOpen && (
              <div className="popover mention-popover">
                <div className="popover-tip">Pick a file to @-mention</div>
                <FileTree api={api} compact onPick={insertMention} />
              </div>
            )}
          </div>
          <div className="composer-side">
            <select
              className="model-picker"
              value={activeModel}
              onChange={(e) => onModelChange(e.target.value)}
              title="Model (grouped by provider)"
            >
              {models.length > 0 ? (
                // v2.2: group models by provider via <optgroup> so
                // the user can see which models belong to which
                // provider at a glance. Providers with no models
                // are skipped.
                Object.entries(
                  models.reduce<Record<string, typeof models>>((acc, m) => {
                    (acc[m.provider] ??= []).push(m);
                    return acc;
                  }, {}),
                )
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([provider, ms]) => (
                    <optgroup key={provider} label={provider}>
                      {ms.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}{m.context_window ? ` · ${Math.round(m.context_window / 1000)}k ctx` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))
              ) : (
                <option value={activeModel}>{activeModel}</option>
              )}
            </select>
            {busy ? (
              <button className="btn btn-abort" onClick={onAbort}>Stop</button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={onSend}
                disabled={!draft.trim()}
                title="Send (Enter)"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeState({
  api,
  config,
  activeSession,
  onPickPrompt,
}: {
  api: DeqiApi;
  config: ServerConfig | null;
  activeSession: SessionSummary | null;
  onPickPrompt: (s: string) => void;
}) {
  const QUICK = [
    { title: 'Read the README', prompt: 'Read the project README and summarize what this codebase does in 5 bullet points.' },
    { title: 'Find TODOs', prompt: 'Grep for TODO and FIXME comments and list the top 5 with file:line and what they ask for.' },
    { title: 'Explain the entrypoint', prompt: 'Open the main entry file and walk me through what runs first when this project starts.' },
    { title: 'Write a test', prompt: 'Pick one function in src/ that has no test and write a vitest/jest test for it. Run the test to confirm it passes.' },
  ];
  return (
    <div className="welcome">
      <h1>Deqi</h1>
      <p className="welcome-sub">
        {activeSession
          ? `Resumed ${activeSession.id} · ${activeSession.model}`
          : (config?.default_model ? `Ready · model: ${config.default_model}` : 'Connecting…')}
      </p>
      <p className="welcome-tip">
        Type a task, or pick a quick action below. <kbd>/</kbd> for commands, <kbd>@</kbd> for files.
      </p>
      <div className="welcome-grid">
        {QUICK.map((q) => (
          <button
            key={q.title}
            className="welcome-card"
            onClick={() => onPickPrompt(q.prompt)}
          >
            <div className="welcome-card-title">{q.title}</div>
            <div className="welcome-card-prompt">{q.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
