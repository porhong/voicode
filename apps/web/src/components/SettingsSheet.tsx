import { useState } from 'react';
import type { StorageInfo, VoiceMicStatus } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import { notificationsSupported, requestNotificationPermission } from '../hooks/useApprovalAlerts';
import { micCaptureSupported } from '../hooks/useMicStream';
import type { Settings } from '../hooks/useSettings';
import { speechSynthesisSupported } from '../hooks/useSpeakReplies';
import { api } from '../lib/api';
import { MODEL_PRESETS } from '../lib/models';
import { playAlertSound } from '../lib/sound';
import {
  SettingsChoice,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSlider,
  SettingsToggle,
} from './SettingsGroup';
import { Sheet } from './Sheet';
import { StorageSection } from './StorageSection';

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  device?: { id: string; name: string };
  agentVersion?: string;
  /** The PC's virtual microphone, for the Claude Code dictation option. */
  voiceMic?: VoiceMicStatus;
  /** The agent's disposable files on the PC (Storage section). */
  storage?: StorageInfo;
  send: Send;
  connected: boolean;
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

const LAYOUTS = [
  ['chat', 'Chat', 'Conversation and a prompt box.'],
  ['deck', 'Deck', 'Macro keys, scroll wheel and joystick.'],
] as const;

const DICTATION = [
  ['browser', 'Phone', 'This browser’s speech service.'],
  ['claude-code', 'Claude Code', 'Dictation on the PC, tuned for code.'],
] as const;

const times = (v: number) => `${v.toFixed(1)}×`;
const OTHER = '__other__';

/** Whether Claude Code dictation can run, as a coloured status line under the choice. */
function DictationStatus({ voiceMic }: { voiceMic?: VoiceMicStatus }) {
  const [ok, text] = !micCaptureSupported()
    ? [false, 'This browser cannot capture microphone audio.']
    : voiceMic?.available
      ? [
          true,
          `Ready. Your voice plays into “${voiceMic.device}” on the PC and Claude Code’s /voice transcribes it (needs a claude.ai sign-in).`,
        ]
      : [
          false,
          `Not ready on the PC: ${voiceMic?.reason ?? 'not connected'}. Run “voicecode-agent doctor” there.`,
        ];
  return <p className={ok ? 'settings-status ok' : 'settings-status warn'}>{text}</p>;
}

export function SettingsSheet({
  settings,
  update,
  device,
  agentVersion,
  voiceMic,
  storage,
  send,
  connected,
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
  const presetModel = MODEL_PRESETS.some(([value]) => value === settings.model);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <SettingsSection
        title="Claude"
        footer="The model chip above a session switches the one on screen."
      >
        <SettingsChoice
          label="Layout"
          value={settings.claudeLayout}
          options={LAYOUTS}
          onChange={(claudeLayout) => update({ claudeLayout })}
        />
        <SettingsToggle
          label="Show tool activity"
          hint="Commands, file reads and their results"
          checked={settings.showToolActivity}
          onChange={(showToolActivity) => update({ showToolActivity })}
        />
        <SettingsSelect
          label="Model for new sessions"
          value={presetModel ? settings.model : 'custom'}
          onChange={(model) => update({ model })}
        >
          {MODEL_PRESETS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          {!presetModel && <option value="custom">{settings.model}</option>}
        </SettingsSelect>
      </SettingsSection>

      <SettingsSection title="Voice">
        <SettingsChoice
          label="Dictation"
          value={settings.dictation}
          options={DICTATION}
          onChange={(dictation) => update({ dictation })}
        >
          {settings.dictation === 'claude-code' && <DictationStatus voiceMic={voiceMic} />}
        </SettingsChoice>
        <SettingsSelect
          label="Language"
          value={customLang ? OTHER : settings.voiceLang}
          onChange={(value) => {
            const other = value === OTHER;
            setCustomLang(other);
            if (!other) update({ voiceLang: value });
          }}
        >
          {LANGUAGES.map(([tag, label]) => (
            <option key={tag} value={tag}>
              {label}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </SettingsSelect>
        {customLang && (
          <label className="settings-row settings-row-stack">
            <span className="settings-hint">Language tag, e.g. pt-PT or ar-SA</span>
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
        {settings.dictation === 'browser' && (
          <SettingsToggle
            label="Send when I stop talking"
            hint="Skips reviewing the dictated text first"
            checked={settings.autoSendVoice}
            onChange={(autoSendVoice) => update({ autoSendVoice })}
          />
        )}
        <SettingsToggle
          label="Read Claude’s replies aloud"
          hint={speechSynthesisSupported() ? undefined : 'Not available in this browser'}
          checked={settings.speakReplies}
          disabled={!speechSynthesisSupported()}
          onChange={(speakReplies) => update({ speakReplies })}
        />
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsToggle
          label="Approval requests"
          hint={
            notificationsSupported()
              ? 'A system notification when Claude needs you and this app is in the background'
              : 'Not available here (on iPhone, add VoiceCode to the Home Screen first)'
          }
          checked={settings.notifyApprovals}
          disabled={!notificationsSupported()}
          onChange={async (enable) =>
            update({ notifyApprovals: enable && (await requestNotificationPermission()) })
          }
        />
        <SettingsToggle
          label="Sound effects"
          hint="A chime when a task finishes, an alert on errors"
          checked={settings.soundAlerts}
          onChange={(soundAlerts) => {
            update({ soundAlerts });
            if (soundAlerts) playAlertSound('done', true);
          }}
        />
        {settings.soundAlerts && (
          <SettingsRow label="Preview">
            <span className="settings-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => playAlertSound('done', true)}
              >
                Chime
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => playAlertSound('error', true)}
              >
                Alert
              </button>
            </span>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title="Trackpad">
        <SettingsSlider
          label="Pointer speed"
          min={0.5}
          max={4}
          step={0.1}
          value={settings.sensitivity}
          format={times}
          onChange={(sensitivity) => update({ sensitivity })}
        />
        <SettingsSlider
          label="Acceleration"
          min={0}
          max={2}
          step={0.1}
          value={settings.acceleration}
          format={(v) => (v === 0 ? 'Off' : times(v))}
          onChange={(acceleration) => update({ acceleration })}
        />
        <SettingsSlider
          label="Scroll speed"
          min={1}
          max={8}
          step={0.5}
          value={settings.scrollSpeed}
          format={times}
          onChange={(scrollSpeed) => update({ scrollSpeed })}
        />
        <SettingsToggle
          label="Natural scrolling"
          hint="Content follows your fingers"
          checked={settings.naturalScroll}
          onChange={(naturalScroll) => update({ naturalScroll })}
        />
      </SettingsSection>

      <StorageSection storage={storage} send={send} disabled={!connected} />

      <SettingsSection title="This device">
        <SettingsRow label="Paired as">
          <span className="settings-value">{device ? device.name : 'Not connected'}</span>
        </SettingsRow>
        {agentVersion && (
          <SettingsRow label="Agent on the PC">
            <span className="settings-value">v{agentVersion}</span>
          </SettingsRow>
        )}
      </SettingsSection>
      <button className="btn btn-danger btn-block settings-unpair" onClick={unpair}>
        Unpair this device
      </button>
    </Sheet>
  );
}
