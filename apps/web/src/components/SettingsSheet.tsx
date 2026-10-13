import { notificationsSupported, requestNotificationPermission } from '../hooks/useApprovalAlerts';
import type { Settings } from '../hooks/useSettings';
import { api } from '../lib/api';

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  device?: { id: string; name: string };
  agentVersion?: string;
  onClose: () => void;
  onUnpaired: () => void;
}

export function SettingsSheet({
  settings,
  update,
  device,
  agentVersion,
  onClose,
  onUnpaired,
}: Props) {
  const unpair = async () => {
    if (!confirm('Unpair this device? You will need a new pairing code to reconnect.')) return;
    await api.unpair().catch(() => undefined);
    onUnpaired();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-header">
          <h2>Settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <h3>Trackpad</h3>
        <label className="field">
          <span>Pointer speed</span>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={settings.sensitivity}
            onChange={(e) => update({ sensitivity: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Acceleration</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={settings.acceleration}
            onChange={(e) => update({ acceleration: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Scroll speed</span>
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={settings.scrollSpeed}
            onChange={(e) => update({ scrollSpeed: Number(e.target.value) })}
          />
        </label>
        <label className="field field-inline">
          <span>Natural scrolling</span>
          <input
            type="checkbox"
            checked={settings.naturalScroll}
            onChange={(e) => update({ naturalScroll: e.target.checked })}
          />
        </label>

        <h3>Voice</h3>
        <label className="field field-inline">
          <span>Send automatically when I stop talking</span>
          <input
            type="checkbox"
            checked={settings.autoSendVoice}
            onChange={(e) => update({ autoSendVoice: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>Recognition language</span>
          <input
            className="input"
            value={settings.voiceLang}
            maxLength={35}
            onChange={(e) => update({ voiceLang: e.target.value })}
          />
        </label>

        <h3>Approvals</h3>
        <label className="field field-inline">
          <span>Notify me when Claude needs approval while the app is in the background</span>
          <input
            type="checkbox"
            checked={settings.notifyApprovals}
            disabled={!notificationsSupported()}
            onChange={async (e) => {
              const enable = e.target.checked;
              update({ notifyApprovals: enable && (await requestNotificationPermission()) });
            }}
          />
        </label>
        {!notificationsSupported() && (
          <p className="small muted">
            This browser can’t show notifications here (on iPhone, add VoiceCode to the Home Screen
            first).
          </p>
        )}

        <h3>Device</h3>
        <p className="small muted">
          {device ? `Paired as “${device.name}”` : 'Not connected'}
          {agentVersion ? ` · agent v${agentVersion}` : ''}
        </p>
        <button className="btn btn-danger btn-block" onClick={unpair}>
          Unpair this device
        </button>
      </section>
    </div>
  );
}
