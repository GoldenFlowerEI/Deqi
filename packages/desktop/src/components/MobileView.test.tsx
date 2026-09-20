/**
 * MobileView.test.tsx — pair code generation, paired-device list, unpair.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileView } from './MobileView';
import type { MobilePair } from '../lib/types';

const sample: MobilePair[] = [
  { id: 'p1', deviceName: 'iPhone 15', code: '29FC-1552', pairedAt: new Date().toISOString() },
];

function makeApi(items = sample) {
  return {
    listPairs: vi.fn().mockResolvedValue({ items }),
    createPair: vi.fn().mockResolvedValue({
      item: { id: 'p2', deviceName: 'iPad', code: 'ABCD-1234-EF56', pairedAt: new Date().toISOString() },
    }),
    deletePair: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe('MobileView', () => {
  it('renders the phase 2 badge', async () => {
    render(<MobileView api={makeApi()} />);
    await waitFor(() => expect(screen.getAllByText(/phase 2/i).length).toBeGreaterThanOrEqual(1));
  });

  it('renders the empty state when no pairs', async () => {
    render(<MobileView api={makeApi([])} />);
    await waitFor(() => expect(screen.getByText(/No paired devices/)).toBeInTheDocument());
  });

  it('renders existing pairs in the list', async () => {
    render(<MobileView api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
  });

  it('clicking Generate code calls api.createPair and shows the code', async () => {
    const api = makeApi();
    render(<MobileView api={api} />);
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Generate code'));
    await waitFor(() => expect(api.createPair).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('ABCD-1234-EF56')).toBeInTheDocument());
  });

  it('Generate code uses the typed device name', async () => {
    const api = makeApi();
    render(<MobileView api={api} />);
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
    const nameInput = screen.getByPlaceholderText('Device name') as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'iPad Pro');
    await userEvent.click(screen.getByText('Generate code'));
    await waitFor(() => expect(api.createPair).toHaveBeenCalledWith('iPad Pro'));
  });

  it('Unpair calls api.deletePair', async () => {
    const api = makeApi();
    render(<MobileView api={api} />);
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Unpair'));
    await waitFor(() => expect(api.deletePair).toHaveBeenCalledWith('p1'));
  });

  it('shows the roadmap section with phase 2 items', () => {
    render(<MobileView api={makeApi()} />);
    expect(screen.getByText(/Phase 2 roadmap/)).toBeInTheDocument();
    expect(screen.getByText(/Push notification/)).toBeInTheDocument();
    expect(screen.getByText(/Two-way/)).toBeInTheDocument();
    expect(screen.getByText(/QR code/)).toBeInTheDocument();
    expect(screen.getByText(/iOS/)).toBeInTheDocument();
  });

  it('shows the code-expires disclaimer', async () => {
    const api = makeApi();
    render(<MobileView api={api} />);
    await userEvent.click(screen.getByText('Generate code'));
    await waitFor(() => expect(screen.getByText(/10 minutes/)).toBeInTheDocument());
  });
});