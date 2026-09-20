/**
 * FeedbackView — in-app feedback channel.
 *
 * v5.1: the missing user-to-developer signal. Before this, Deqi had
 * telemetry (developer-side, opt-in) but no way for a real user to
 * say "this is broken" or "I want this" without filing a GitHub issue.
 *
 * Three paths land in the same `~/.deqi/feedback.jsonl`:
 *   1. Desktop: this component (LeftRail → "Feedback")
 *   2. CLI: `deqi feedback "..."` (v5.2 roadmap)
 *   3. Web: future work, same endpoint
 *
 * The server dedupes on `clientId` so a network blip doesn't
 * produce two rows. The `surface` field tells us which view the
 * user was on, so we can prioritize fixes for the worst UX.
 *
 * No PII is collected automatically. The user types what they
 * want. `desktopId` and `sessionId` are non-PII identifiers we
 * already have locally.
 */

import { useState } from 'react';
import { DeqiApi } from '../lib/api';
import { APP_VERSION, DESKTOP_ID } from '../lib/identity';

type Kind = 'bug' | 'feature' | 'comment' | 'question';

interface Props {
  api: DeqiApi;
  /** Which view the user is on — captured for "where is the friction" signal. */
  surface: string;
  /** Optional: the active session id, if the user is in a chat. */
  sessionId?: string | null;
  /** Optional close action — the modal pattern can call this after submit. */
  onClose?: () => void;
}

const KIND_OPTIONS: Array<{ value: Kind; label: string; hint: string }> = [
  { value: 'bug', label: 'Bug', hint: 'Something is broken or wrong' },
  { value: 'feature', label: 'Feature', hint: 'Something you wish Deqi did' },
  { value: 'question', label: 'Question', hint: 'How do I…? Or why does…?' },
  { value: 'comment', label: 'Comment', hint: 'General feedback / kudos / gripes' },
];

const RATING_LABELS: Array<{ value: number; label: string; emoji: string }> = [
  { value: 1, label: 'Frustrated', emoji: '😣' },
  { value: 2, label: 'Disappointed', emoji: '😕' },
  { value: 3, label: 'OK', emoji: '😐' },
  { value: 4, label: 'Happy', emoji: '🙂' },
  { value: 5, label: 'Delighted', emoji: '🤩' },
];

function generateClientId(): string {
  // Stable per-tab. Stored in sessionStorage so a page refresh
  // doesn't dedupe against itself for a new message.
  let id = sessionStorage.getItem('deqi:feedback-client-id');
  if (!id) {
    id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('deqi:feedback-client-id', id);
  }
  return id;
}

export function FeedbackView({ api, surface, sessionId, onClose }: Props) {
  const [kind, setKind] = useState<Kind>('comment');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: true; id: string; deduped?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (message.trim().length === 0) {
      setError('Please write something — even one sentence helps.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.submitFeedback({
        clientId: generateClientId(),
        kind,
        message: message.trim(),
        rating,
        surface,
        sessionId: sessionId ?? undefined,
        desktopId: DESKTOP_ID,
        appVersion: APP_VERSION,
      });
      setResult(res);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="feedback-view feedback-view--success">
        <h2>Thanks</h2>
        <p>
          Your {KIND_OPTIONS.find((k) => k.value === kind)?.label.toLowerCase() ?? 'note'} was logged
          {result.deduped ? ' (matched a prior submission — no duplicate added)' : ''}.
        </p>
        <p className="feedback-view--id">id: <code>{result.id}</code></p>
        <div className="feedback-view--actions">
          <button
            className="settings-edit-btn"
            onClick={() => {
              setResult(null);
              setMessage('');
              setRating(undefined);
            }}
          >
            Send another
          </button>
          {onClose ? (
            <button className="settings-edit-btn settings-edit-btn--primary" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-view">
      <h2>Send feedback</h2>
      <p className="feedback-view--intro">
        No PII is collected. Your message lands in <code>~/.deqi/feedback.jsonl</code> on this machine.
      </p>

      <fieldset className="feedback-view--kind">
        <legend>Kind</legend>
        {KIND_OPTIONS.map((opt) => (
          <label key={opt.value} className={kind === opt.value ? 'is-active' : ''}>
            <input
              type="radio"
              name="kind"
              value={opt.value}
              checked={kind === opt.value}
              onChange={() => setKind(opt.value)}
            />
            <strong>{opt.label}</strong>
            <span className="feedback-view--hint">{opt.hint}</span>
          </label>
        ))}
      </fieldset>

      <label className="feedback-view--field">
        <span>Message</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            kind === 'bug'
              ? 'What did you do, what happened, what did you expect?'
              : kind === 'feature'
                ? 'What should Deqi do? Why?'
                : 'Anything goes.'
          }
          rows={6}
          maxLength={4000}
          autoFocus
        />
        <small>
          {message.length} / 4000
        </small>
      </label>

      <fieldset className="feedback-view--rating">
        <legend>How do you feel about Deqi right now? (optional)</legend>
        {RATING_LABELS.map((r) => (
          <button
            key={r.value}
            type="button"
            className={rating === r.value ? 'is-active' : ''}
            onClick={() => setRating(rating === r.value ? undefined : r.value)}
          >
            <span className="feedback-view--emoji">{r.emoji}</span>
            <span>{r.label}</span>
          </button>
        ))}
      </fieldset>

      {error ? <p className="feedback-view--error">{error}</p> : null}

      <div className="feedback-view--actions">
        {onClose ? (
          <button className="settings-edit-btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        ) : null}
        <button
          className="settings-edit-btn settings-edit-btn--primary"
          onClick={submit}
          disabled={submitting || message.trim().length === 0}
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
