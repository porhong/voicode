import { useEffect, useState } from 'react';
import { api, pairingErrorMessage } from '../lib/api';

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Mac OS X/.test(ua)) return 'Mac browser';
  if (/Linux/.test(ua)) return 'Linux browser';
  return 'Browser';
}

/** Reads a pairing code from the QR link fragment and removes it from the URL. */
function takeCodeFromHash(): string {
  const match = /pair=(\d{6})/.exec(location.hash);
  if (match) history.replaceState(null, '', location.pathname + location.search);
  return match?.[1] ?? '';
}

// Read once at startup: state initializers may run twice under StrictMode.
const codeFromLink = takeCodeFromHash();

export function PairPage({ hostname, onPaired }: { hostname?: string; onPaired: () => void }) {
  const [code, setCode] = useState(codeFromLink);
  const [name, setName] = useState(guessDeviceName);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.pair({ code, deviceName: name.trim() || guessDeviceName() });
      onPaired();
    } catch (err) {
      setError(pairingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Initial focus only. A code from the QR link is submitted after the user confirms the
  // device name, so that field gets focus; otherwise the code field does. Running this on
  // every change of `code` moved the cursor away after each digit typed.
  useEffect(() => {
    document.getElementById(codeFromLink ? 'device-name' : 'pair-code')?.focus();
  }, []);

  return (
    <main className="pair">
      <img src="/icon.svg" alt="" width={72} height={72} />
      <h1>Pair with {hostname ?? 'your PC'}</h1>
      <p className="muted">
        Enter the code shown by <code>voicecode-agent start</code> on the computer.
      </p>
      <form onSubmit={submit} className="pair-form">
        <label>
          <span className="small muted">Pairing code</span>
          <input
            id="pair-code"
            className="input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123-456"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d-]/g, ''))}
          />
        </label>
        <label>
          <span className="small muted">Name this device</span>
          <input
            id="device-name"
            className="input"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button
          className="btn btn-primary btn-block"
          disabled={busy || code.replace(/\D/g, '').length !== 6}
        >
          {busy ? 'Pairing…' : 'Pair device'}
        </button>
      </form>
      {servedFromLan() && (
        <p className="small muted">
          Seeing a certificate warning or no microphone? Install the{' '}
          <a href="/voicecode-ca.crt">VoiceCode certificate</a> on this device and mark it as
          trusted.
        </p>
      )}
    </main>
  );
}

/**
 * Only the LAN address uses the agent's own certificate; a Cloudflare Tunnel host name
 * has a publicly trusted one, so the install hint would just be noise there.
 */
function servedFromLan(): boolean {
  const host = location.hostname;
  return /^[\d.]+$|^\[|:/.test(host) || host === 'localhost' || host.endsWith('.local');
}
