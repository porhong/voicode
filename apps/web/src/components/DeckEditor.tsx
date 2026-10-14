import { useState } from 'react';
import { LIMITS } from '@voicecode/protocol';
import {
  DECK_PACKS,
  DEFAULT_DECK,
  DIRECTIONS,
  PRESET_MACROS,
  type DeckConfig,
  type Direction,
  type Macro,
} from '../hooks/useDeck';
import { DECK_ICON_NAMES, DeckIcon } from './DeckIcons';
import { Sheet } from './Sheet';

type Slot = { kind: 'key'; index: number } | { kind: 'stick'; dir: Direction };

const STICK_LABEL: Record<Direction, string> = {
  up: 'Push up',
  right: 'Push right',
  down: 'Push down',
  left: 'Push left',
};

interface Props {
  deck: DeckConfig;
  onChange: (deck: DeckConfig) => void;
  onClose: () => void;
}

/**
 * Remapping, like the hardware's companion software: pick a whole layout pack, or pick
 * one control and give it a preset or your own label, icon and prompt. Changes apply
 * (and are saved) as you make them.
 */
export function DeckEditor({ deck, onChange, onClose }: Props) {
  const [slot, setSlot] = useState<Slot>({ kind: 'key', index: 0 });
  const macro = slot.kind === 'key' ? deck.keys[slot.index]! : deck.stick[slot.dir];

  const setMacro = (patch: Partial<Macro>) => {
    const next = { ...macro, ...patch };
    if (slot.kind === 'key') {
      onChange({ ...deck, keys: deck.keys.map((k, i) => (i === slot.index ? next : k)) });
    } else {
      onChange({ ...deck, stick: { ...deck.stick, [slot.dir]: next } });
    }
  };
  const same = (a: Slot, b: Slot) =>
    a.kind === b.kind &&
    (a.kind === 'key' ? a.index === (b as typeof a).index : a.dir === (b as typeof a).dir);

  const chip = (s: Slot, m: Macro, title: string) => (
    <button
      key={s.kind === 'key' ? `k${s.index}` : s.dir}
      className={`deck-chip ${same(s, slot) ? 'active' : ''}`}
      aria-pressed={same(s, slot)}
      title={title}
      onClick={() => setSlot(s)}
    >
      <DeckIcon name={m.icon} size={18} />
      <span>{m.label || '—'}</span>
    </button>
  );

  return (
    <Sheet title="Customize deck" onClose={onClose}>
      <h3>Layout packs</h3>
      <div className="deck-packs">
        {DECK_PACKS.map((pack) => (
          <button
            key={pack.name}
            className="deck-pack"
            onClick={() => {
              if (confirm(`Replace all keys and joystick pushes with the “${pack.name}” pack?`)) {
                onChange(pack.config);
              }
            }}
          >
            <strong>{pack.name}</strong>
            <span className="small muted">{pack.description}</span>
          </button>
        ))}
      </div>

      <h3>Keys</h3>
      <div className="deck-chips deck-chips-keys">
        {deck.keys.map((k, index) => chip({ kind: 'key', index }, k, `Key ${index + 1}`))}
      </div>
      <h3>Joystick</h3>
      <div className="deck-chips">
        {DIRECTIONS.map((dir) => chip({ kind: 'stick', dir }, deck.stick[dir], STICK_LABEL[dir]))}
      </div>

      <div className="deck-slot-editor">
        <p className="small muted deck-slot-title">
          Editing{' '}
          {slot.kind === 'key' ? `key ${slot.index + 1}` : STICK_LABEL[slot.dir].toLowerCase()}
        </p>
        <label className="field">
          <span>Preset</span>
          <select
            className="select"
            value=""
            onChange={(e) => {
              const p = PRESET_MACROS.find((x) => x.label === e.target.value);
              if (p) setMacro(p);
            }}
          >
            <option value="">Choose a preset…</option>
            {PRESET_MACROS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label} — {p.prompt}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Label</span>
          <input
            className="input"
            value={macro.label}
            maxLength={24}
            onChange={(e) => setMacro({ label: e.target.value })}
          />
        </label>
        <fieldset className="field deck-icon-picker">
          <legend>Icon</legend>
          {DECK_ICON_NAMES.map((name) => (
            <label key={name} className={macro.icon === name ? 'active' : ''} title={name}>
              <input
                type="radio"
                name="deck-icon"
                className="visually-hidden"
                checked={macro.icon === name}
                onChange={() => setMacro({ icon: name })}
              />
              <DeckIcon name={name} size={20} />
              <span className="visually-hidden">{name}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Prompt sent to Claude</span>
          <textarea
            className="input"
            rows={3}
            value={macro.prompt}
            maxLength={LIMITS.maxPromptLength}
            onChange={(e) => setMacro({ prompt: e.target.value })}
          />
        </label>
        <label className="field field-inline">
          <span>
            Review before sending
            <span className="field-hint">Puts the prompt in the box to edit first</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={macro.review}
            onChange={(e) => setMacro({ review: e.target.checked })}
          />
        </label>
      </div>

      <button
        className="btn btn-block"
        onClick={() =>
          confirm('Reset the whole deck to the default layout?') && onChange(DEFAULT_DECK)
        }
      >
        Reset to default
      </button>
    </Sheet>
  );
}
