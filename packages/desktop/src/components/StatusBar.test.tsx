/**
 * StatusBar.test.tsx — connection state pill + model + info rendering.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});