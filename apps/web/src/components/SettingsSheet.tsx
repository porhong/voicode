import { useState, type ReactNode } from 'react';
import { notificationsSupported, requestNotificationPermission } from '../hooks/useApprovalAlerts';
import type { Settings } from '../hooks/useSettings';
import { speechSynthesisSupported } from '../hooks/useSpeakReplies';
import { api } from '../lib/api';
import { Sheet } from './Sheet';

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  device?: { id: string; name: string };
  agentVersion?: string;
  onClose: () => void;
  onUnpaired: () => void;
}

/** Common dictation languages; any other BCP 47 tag already in use is kept as an option. */
const LANGUAGES: Array<[tag: string, label: string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
  ['km-KH', 'ខ្មែរ (Khmer)'],
  ['th-TH', 'ไทย (Thai)'],
  ['vi-VN', 'Tiếng Việt'],
  ['id-ID', 'Bahasa Indonesia'],
  ['ms-MY', 'Bahasa Melayu'],
  ['zh-CN', '中文 (普通话)'],
  ['zh-TW', '中文 (台灣)'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
  ['hi-IN', 'हिन्दी'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['es-ES', 'Español (España)'],
  ['es-MX', 'Español (México)'],
  ['pt-BR', 'Português (Brasil)'],
  ['it-IT', 'Italiano'],
  ['nl-NL', 'Nederlands'],
  ['ru-RU', 'Русский'],
];

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="field field-inline">
      <span>
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-row">
        <span>{label}</span>
        <output className="field-value">{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

const times = (v: number) => `${v.toFixed(1)}×`;
const OTHER = '__other__';

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
  const listed = LANGUAGES.some(([tag]) => tag === settings.voiceLang);
  // Any BCP 47 tag the browser's recognizer supports can still be typed in.
  const [customLang, setCustomLang] = useState(!listed);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <h3>Voice</h3>
      <label className="field">
        <span>Dictation language</span>
        <select
          className="select"
          value={customLang ? OTHER : settings.voiceLang}
          onChange={(e) => {
            const other = e.target.value === OTHER;
            setCustomLang(other);
            if (!other) update({ voiceLang: e.target.value });
          }}
        >
          {LANGUAGES.map(([tag, label]) => (
            <option key={tag} value={tag}>
              {label}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
      </label>
      {customLang && (
        <label className="field">
          <span className="small muted">Language tag, e.g. pt-PT or ar-SA</span>
          <input
            className="input"
            value={settings.voiceLang}
            maxLength={35}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => update({ voiceLang: e.target.value })}
          />
        </label>
      )}
      <Toggle
        label="Send when I stop talking"
        hint="Skips reviewing the dictated text first"
        checked={settings.autoSendVoice}
        onChange={(autoSendVoice) => update({ autoSendVoice })}
      />
      <Toggle
        label="Read Claude’s replies aloud"
        checked={settings.speakReplies}
        disabled={!speechSynthesisSupported()}
        onChange={(speakReplies) => update({ speakReplies })}
      />

      <h3>Approvals</h3>
      <Toggle
        label="Notify me in the background"
        hint={
          notificationsSupported()
            ? 'A system notification when Claude needs approval'
            : 'Not available here (on iPhone, add VoiceCode to the Home Screen first)'
        }
        checked={settings.notifyApprovals}
        disabled={!notificationsSupported()}
        onChange={async (enable) =>
          update({ notifyApprovals: enable && (await requestNotificationPermission()) })
        }
      />

      <h3>Trackpad</h3>
      <Slider
        label="Pointer speed"
        min={0.5}
        max={4}
        step={0.1}
        value={settings.sensitivity}
        format={times}
        onChange={(sensitivity) => update({ sensitivity })}
      />
      <Slider
        label="Acceleration"
        min={0}
        max={2}
        step={0.1}
        value={settings.acceleration}
        format={(v) => (v === 0 ? 'Off' : times(v))}
        onChange={(acceleration) => update({ acceleration })}
      />
      <Slider
        label="Scroll speed"
        min={1}
        max={8}
        step={0.5}
        value={settings.scrollSpeed}
        format={times}
        onChange={(scrollSpeed) => update({ scrollSpeed })}
      />
      <Toggle
        label="Natural scrolling"
        hint="Content follows your fingers"
        checked={settings.naturalScroll}
        onChange={(naturalScroll) => update({ naturalScroll })}
      />

      <h3>This device</h3>
      <p className="small muted">
        {device ? `Paired as “${device.name}”` : 'Not connected'}
        {agentVersion ? ` · agent v${agentVersion}` : ''}
      </p>
      <button className="btn btn-danger btn-block" onClick={unpair}>
        Unpair this device
      </button>
    </Sheet>
  );
}
