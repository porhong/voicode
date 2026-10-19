import { useId, type ReactNode } from 'react';

/**
 * Building blocks of the Settings sheet, laid out like a phone's own settings: a small
 * section title, one card of rows divided by hairlines, and a footnote under the card for
 * anything that explains rather than sets. Each row is a label (with an optional hint)
 * on the left and its control on the right; wide controls (choices, sliders) stack under
 * the label instead.
 */
export function SettingsSection({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <div className="settings-group">{children}</div>
      {footer && <div className="settings-footer">{footer}</div>}
    </section>
  );
}

function RowText({ label, hint }: { label: ReactNode; hint?: ReactNode }) {
  return (
    <span className="settings-text">
      <span>{label}</span>
      {hint && <span className="settings-hint">{hint}</span>}
    </span>
  );
}

/** A row with any control (or a value) on the right. */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <RowText label={label} hint={hint} />
      {children}
    </div>
  );
}

export function SettingsToggle({
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
    <label className={disabled ? 'settings-row disabled' : 'settings-row'}>
      <RowText label={label} hint={hint} />
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

/** A select on the right of its label; the label names it for screen readers. */
export function SettingsSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <RowText label={label} />
      <select
        className="select settings-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

/**
 * Two or three options as one pill control under the label. Only the chosen option's
 * description shows, under the pills, so the row stays one line of choices.
 */
export function SettingsChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [value: T, label: string, hint: string]>;
  onChange: (value: T) => void;
  /** Shown under the description, e.g. whether the chosen option is ready. */
  children?: ReactNode;
}) {
  const hintId = useId();
  const hint = options.find(([v]) => v === value)?.[2];
  return (
    <div className="settings-row settings-row-stack">
      <span className="settings-text">{label}</span>
      <div className="settings-choice" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            aria-describedby={v === value ? hintId : undefined}
            className={v === value ? 'active' : undefined}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
      {hint && (
        <span id={hintId} className="settings-hint">
          {hint}
        </span>
      )}
      {children}
    </div>
  );
}

export function SettingsSlider({
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
    <label className="settings-row settings-row-stack">
      <span className="settings-slider-head">
        <span>{label}</span>
        <output className="settings-value">{format(value)}</output>
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
