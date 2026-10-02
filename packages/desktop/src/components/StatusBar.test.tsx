/**
 * StatusBar.test.tsx — connection state pill + model + info rendering.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  it('shows Connected when state is open', () => {
    render(<StatusBar connection="open" model="MiniMax-M3" />);
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('shows Connecting… when state is connecting', () => {
    render(<StatusBar connection="connecting" model="MiniMax-M3" />);
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it('shows Disconnected when state is closed', () => {
    render(<StatusBar connection="closed" model="MiniMax-M3" />);
    expect(screen.getByText(/Disconnected/)).toBeInTheDocument();
  });

  it('shows Error when state is error', () => {
    render(<StatusBar connection="error" model="MiniMax-M3" />);
    expect(screen.getByText(/Error/)).toBeInTheDocument();
  });

  it('always renders the model', () => {
    render(<StatusBar connection="open" model="claude-sonnet-4-5" />);
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
  });

  it('renders info message when provided', () => {
    render(<StatusBar connection="open" model="MiniMax-M3" info="server unreachable, retrying…" />);
    expect(screen.getByText(/server unreachable/)).toBeInTheDocument();
  });

  it('does NOT render the info line when info is undefined', () => {
    const { container } = render(<StatusBar connection="open" model="MiniMax-M3" />);
    expect(container.querySelector('.status-info')).not.toBeInTheDocument();
  });

  // v0.5: the theme toggle. Asserted end to end — attribute, storage
  // and label — because a toggle that renders a button and changes
  // nothing is the failure mode a screenshot would not catch.
  describe('theme toggle', () => {
    beforeEach(() => {
      localStorage.clear();
      document.documentElement.removeAttribute('data-theme');
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (q: string) => ({
          matches: false, media: q,
          addEventListener: () => {}, removeEventListener: () => {},
        }),
      });
    });

    it('starts from the system preference', () => {
      render(<StatusBar connection="open" model="MiniMax-M3" />);
      // matchMedia reports "not light" above, so dark.
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('flips the attribute, the label and the stored value', () => {
      render(<StatusBar connection="open" model="MiniMax-M3" />);
      const btn = screen.getByLabelText('Switch to light theme');
      fireEvent.click(btn);

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(localStorage.getItem('deqi.theme')).toBe('light');
      // And it now offers the way back.
      expect(screen.getByLabelText('Switch to dark theme')).toBeInTheDocument();
    });

    it('goes back to dark on a second click', () => {
      render(<StatusBar connection="open" model="MiniMax-M3" />);
      fireEvent.click(screen.getByLabelText('Switch to light theme'));
      fireEvent.click(screen.getByLabelText('Switch to dark theme'));
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem('deqi.theme')).toBe('dark');
    });
  });
});