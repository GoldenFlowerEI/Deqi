/**
 * MobileView — phase 2 stub.
 *
 * v2.1 ships a fully-laid-out mobile control panel with:
 *   - Pair a new phone: shows a 6-character code + QR (v2.2)
 *   - List of paired devices with last-seen / unpair
 *
 * The actual push-to-phone backend doesn't exist yet (the
 * server only persists the pairing record). We mark the page
 * "Phase 2" so users don't think the missing piece is a bug.
 *
 * The plan: in v2.2, deqi-server adds a WS /v1/push endpoint and
 * a tiny relay; the desktop app pairs the phone via QR scan,
 * and any "send to phone" action in the composer publishes to
 * the relay. For now, the desktop app just shows the device
 * list and lets you create/remove pairings.
 */

import { useEffect, useState } from 'react';
import { DeqiApi } from '../lib/api';
import type { MobilePair } from '../lib/types';

interface Props {
  api: DeqiApi;
}

export function MobileView({ api }: Props) {
  const [pairs, setPairs] = useState<MobilePair[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('iPhone');

  const reload = async () => {
    setBusy(true);
    try {
      const { items } = await api.listPairs();
      setPairs(items);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleCreate = async () => {
    try {
      const { item } = await api.createPair(deviceName || 'iPhone');
      setPendingCode(item.code);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const handleUnpair = async (it: MobilePair) => {
    await api.deletePair(it.id);
    if (pendingCode) setPendingCode(null);
    await reload();
  };

  return (
    <div className="view view-mobile">
      <div className="view-header">
        <h2>Mobile</h2>
        <span className="phase-pill">phase 2</span>
        <p className="view-sub">
          Pair your phone to review and steer deqi from the couch. The pairing is
          ready; the relay is in v2.2.
        </p>
      </div>

      {err && <div className="view-error">⚠ {err}</div>}

      <div className="mobile-pair">
        <h3>Pair a new device</h3>
        <div className="mobile-pair-form">
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Device name"
          />
          <button className="btn btn-primary" onClick={handleCreate}>
            Generate code
          </button>
        </div>
        {pendingCode && (
          <div className="mobile-code-card">
            <div className="mobile-code-label">Enter this on your phone</div>
            <div className="mobile-code">{pendingCode}</div>
            <div className="mobile-code-sub">
              Code expires in 10 minutes. We don't store the code after pairing.
            </div>
          </div>
        )}
      </div>

      <h3 className="mobile-devices-title">Paired devices</h3>
      {busy && <div className="view-busy">Loading…</div>}
      {!busy && pairs.length === 0 && (
        <div className="view-empty small">
          <p>No paired devices yet.</p>
        </div>
      )}
      <ul className="mobile-list">
        {pairs.map((p) => (
          <li key={p.id} className="mobile-row">
            <span className="mobile-device-icon">⌬</span>
            <div className="mobile-device-main">
              <div className="mobile-device-name">{p.deviceName}</div>
              <div className="mobile-device-meta">
                Paired {formatWhen(p.pairedAt)}
                {p.lastSeenAt && ` · seen ${formatWhen(p.lastSeenAt)}`}
              </div>
            </div>
            <button className="btn btn-mini danger" onClick={() => handleUnpair(p)}>
              Unpair
            </button>
          </li>
        ))}
      </ul>

      <div className="mobile-roadmap">
        <h4>Phase 2 roadmap</h4>
        <ul>
          <li>✓ Pairing code generation (v2.1)</li>
          <li>✓ Device list + unpair (v2.1)</li>
          <li>– Push notification when the agent finishes a turn (v2.2)</li>
          <li>– Two-way: send prompts from phone → desktop (v2.2)</li>
          <li>– QR code for camera pairing (v2.2)</li>
          <li>– iOS / Android native shells (v2.3)</li>
        </ul>
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString();
}
