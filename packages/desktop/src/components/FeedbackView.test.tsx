/**
 * FeedbackView.test.tsx — kind selector (radios), textarea,
 * rating buttons, submission lifecycle. Mocks the DeqiApi.submitFeedback.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeedbackView } from './FeedbackView';

function makeApi() {
  return {
    submitFeedback: vi.fn().mockResolvedValue({ ok: true, id: 'fb_test' }),
  } as any;
}

describe('FeedbackView', () => {
  it('renders the four kind radios (bug/feature/comment/question)', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeInTheDocument();
    expect(screen.getByText('Comment')).toBeInTheDocument();
    expect(screen.getByText('Question')).toBeInTheDocument();
  });

  it('defaults to "comment" kind', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    const commentLabel = screen.getByText('Comment').closest('label')!;
    expect(commentLabel.className).toMatch(/is-active/);
  });

  it('clicking a kind radio switches the active kind', async () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    await userEvent.click(screen.getByText('Bug'));
    expect(screen.getByText('Bug').closest('label')!.className).toMatch(/is-active/);
    expect(screen.getByText('Comment').closest('label')!.className).not.toMatch(/is-active/);
  });

  it('renders the textarea for the message', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders the 5 rating buttons', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    expect(screen.getByText('Frustrated')).toBeInTheDocument();
    expect(screen.getByText('Disappointed')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Happy')).toBeInTheDocument();
    expect(screen.getByText('Delighted')).toBeInTheDocument();
  });

  it('Send button is disabled when message is empty', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  it('Send calls api.submitFeedback with the typed message', async () => {
    const api = makeApi();
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.click(screen.getByText('Bug'));
    await userEvent.type(screen.getByRole('textbox'), 'this is broken');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalled());
    const call = api.submitFeedback.mock.calls[0][0];
    expect(call.kind).toBe('bug');
    expect(call.message).toBe('this is broken');
    expect(call.surface).toBe('left-rail');
    expect(call.desktopId).toBeDefined();
    expect(call.clientId).toBeDefined();
  });

  it('after a successful submit, shows a success state with id', async () => {
    const api = makeApi();
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.type(screen.getByRole('textbox'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(screen.getByText(/fb_test/)).toBeInTheDocument());
  });

  it('Send another button on the success state resets the form', async () => {
    const api = makeApi();
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.type(screen.getByRole('textbox'), 'first message');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(screen.getByText(/fb_test/)).toBeInTheDocument());
    await userEvent.click(screen.getByText('Send another'));
    // Form is back; textarea is empty; Submit button is disabled
    expect(screen.queryByText(/fb_test/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  it('submit error shows the error message', async () => {
    const api = { submitFeedback: vi.fn().mockRejectedValue(new Error('network down')) } as any;
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.type(screen.getByRole('textbox'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(screen.getByText(/network down/)).toBeInTheDocument());
  });

  it('clicking a rating button sets the rating (sent in payload)', async () => {
    const api = makeApi();
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.click(screen.getByText('Happy')); // value 4
    await userEvent.type(screen.getByRole('textbox'), 'rating test');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => {
      const call = api.submitFeedback.mock.calls[0][0];
      expect(call.rating).toBe(4);
    });
  });

  it('clicking the same rating button twice clears the rating', async () => {
    const api = makeApi();
    render(<FeedbackView api={api} surface="left-rail" />);
    await userEvent.click(screen.getByText('OK')); // value 3
    await userEvent.click(screen.getByText('OK')); // toggle off
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => {
      const call = api.submitFeedback.mock.calls[0][0];
      expect(call.rating).toBeUndefined();
    });
  });

  it('Cancel button is present when onClose is provided', () => {
    const onClose = vi.fn();
    render(<FeedbackView api={makeApi()} surface="left-rail" onClose={onClose} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('Cancel calls onClose', async () => {
    const onClose = vi.fn();
    render(<FeedbackView api={makeApi()} surface="left-rail" onClose={onClose} />);
    await userEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the PII disclaimer copy', () => {
    render(<FeedbackView api={makeApi()} surface="left-rail" />);
    expect(screen.getByText(/No PII is collected/)).toBeInTheDocument();
    expect(screen.getByText(/feedback\.jsonl/)).toBeInTheDocument();
  });
});