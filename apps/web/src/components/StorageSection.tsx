import { useEffect, useState } from 'react';
import type { StorageInfo } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import { CATEGORY_LABELS, formatBytes, formatLimit, LIMIT_CHOICES_MB } from '../lib/storage';
import { SettingsRow, SettingsSection, SettingsSelect, SettingsToggle } from './SettingsGroup';

interface Props {
  storage?: StorageInfo;
  send: Send;
  disabled: boolean;
}

/**
 * Settings → Storage: what the agent keeps on the PC that it can do without (old
 * versions, the rotated log, leftovers of interrupted downloads), a button to remove it
 * and the automatic cleanup. This phone itself caches nothing.
 */
export function StorageSection({ storage, send, disabled }: Props) {
  /** `lastCleanup.at` when "Clean up" was pressed; the report after it ends the wait. */
  const [cleaningFrom, setCleaningFrom] = useState<number>();
  const cleaning = cleaningFrom !== undefined && (storage?.lastCleanup?.at ?? 0) === cleaningFrom;
  useEffect(() => {
    if (!disabled) send({ type: 'storage.info' });
  }, [send, disabled]);

  const configure = (patch: Partial<Pick<StorageInfo, 'auto' | 'maxCacheMb'>>) => {
    if (!storage) return;
    send({
      type: 'storage.settings',
      auto: patch.auto ?? storage.auto,
      maxCacheMb: patch.maxCacheMb ?? storage.maxCacheMb,
    });
  };
  const cleanUp = () => {
    setCleaningFrom(storage?.lastCleanup?.at ?? 0);
    send({ type: 'storage.cleanup' });
    // An error instead of a report must not leave the button waiting.
    setTimeout(() => setCleaningFrom(undefined), 30_000);
  };

  const used = storage?.categories.filter((c) => c.bytes > 0) ?? [];
  const last = storage?.lastCleanup;
  const limits: number[] = [...LIMIT_CHOICES_MB];
  if (storage && !limits.includes(storage.maxCacheMb)) limits.push(storage.maxCacheMb);

  return (
    <SettingsSection
      title="Storage on the PC"
      footer={
        <>
          {last && (
            <p role="status">
              {last.trigger === 'auto' ? 'Cleaned up automatically' : 'Cleaned up'}{' '}
              {new Date(last.at).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              : {formatBytes(last.freedBytes)} freed
              {last.failed > 0 ? ` (${last.failed} in use, skipped)` : ''}.
            </p>
          )}
          <p>Never removes your settings, paired devices, certificates or the versions in use.</p>
        </>
      }
    >
      {!storage ? (
        <SettingsRow label={disabled ? 'Not connected' : 'Checking…'} />
      ) : (
        <>
          <div className="settings-row settings-row-stack">
            <span className="settings-slider-head">
              <span>Caches and old files</span>
              <output className="settings-value">{formatBytes(storage.totalBytes)}</output>
            </span>
            {used.length > 0 && (
              <ul className="storage-list settings-hint">
                {used.map((c) => (
                  <li key={c.category}>
                    <span>{CATEGORY_LABELS[c.category]}</span>
                    <span>{formatBytes(c.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="btn btn-block"
              disabled={disabled || cleaning || storage.totalBytes === 0}
              onClick={cleanUp}
            >
              {cleaning
                ? 'Cleaning up…'
                : storage.totalBytes === 0
                  ? 'Nothing to clean up'
                  : `Clean up ${formatBytes(storage.totalBytes)}`}
            </button>
          </div>
          <SettingsToggle
            label="Clean up automatically"
            hint="When these files pass the limit (checked every few hours)"
            checked={storage.auto}
            disabled={disabled}
            onChange={(auto) => configure({ auto })}
          />
          {storage.auto && (
            <SettingsSelect
              label="Limit"
              value={storage.maxCacheMb}
              disabled={disabled}
              onChange={(mb) => configure({ maxCacheMb: Number(mb) })}
            >
              {limits.map((mb) => (
                <option key={mb} value={mb}>
                  {formatLimit(mb)}
                </option>
              ))}
            </SettingsSelect>
          )}
        </>
      )}
    </SettingsSection>
  );
}
