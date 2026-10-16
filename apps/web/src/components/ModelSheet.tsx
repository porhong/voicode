import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ModelChoice,
  type PermissionModeName,
  type SessionSummary,
} from '@voicecode/protocol';
import { MODE_TEXT } from '../lib/modes';
import type { Send } from '../hooks/useAgentSocket';
import type { AppState } from '../lib/store';
import { EFFORT_SHORT, EFFORT_TEXT, modelLabel } from '../lib/models';
import { Sheet } from './Sheet';

interface Props {
  state: AppState;
  send: Send;
  /** The session on screen; its model and effort are switched right away. */
  session?: SessionSummary;
  /** This phone's choice for new sessions ('' = the PC's default). */
  chosen: string;
  onChoose: (model: string) => void;
  /** This phone's effort for new sessions ('' = the model's default). */
  effort: EffortLevel | '';
  onChooseEffort: (effort: EffortLevel | '') => void;
  disabled: boolean;
  onClose: () => void;
}

/** A change is sent once the thumb rests this long, not on every step it passes. */
const COMMIT_MS = 450;

/**
 * Reasoning effort as a stepped slider: a native range input (arrow keys, screen
 * readers announce the level by name), with the level names under it as tap targets.
 * Only the levels the selected model takes are offered.
 */
function EffortSlider({
  levels,
  value,
  disabled,
  onCommit,
}: {
  levels: readonly EffortLevel[];
  value: EffortLevel | '';
  disabled: boolean;
  onCommit: (effort: EffortLevel | '') => void;
}) {
  const [prevValue, setPrevValue] = useState(value);
  const [draft, setDraft] = useState<EffortLevel | ''>(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = (next: EffortLevel | '', delay = COMMIT_MS) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    if (next === value) return;
    timer.current = window.setTimeout(() => onCommit(next), delay);
  };

  // A level the model does not take (or none chosen) sits on the nearest stop it has.
  const index = draft ? levels.indexOf(draft) : -1;
  const shown = index >= 0 ? index : nearest(levels, draft);
  const current = levels[shown];
  const fill = levels.length > 1 ? (shown / (levels.length - 1)) * 100 : 0;

  return (
    <div className={`effort ${draft ? '' : 'effort-default'}`}>
      <div className="effort-head">
        <span className="effort-value" aria-hidden>
          {draft ? EFFORT_TEXT[draft].name : 'Model default'}
        </span>
        {draft && (
          <button
            className="btn btn-ghost btn-small"
            disabled={disabled}
            onClick={() => commit('', 0)}
          >
            Use model default
          </button>
        )}
      </div>
      <input
        type="range"
        className="effort-range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={shown}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        disabled={disabled}
        aria-label="Effort"
        aria-valuetext={draft ? EFFORT_TEXT[draft].name : `Model default`}
        onChange={(e) => commit(levels[Number(e.target.value)]!)}
        onPointerUp={() => {
          // Letting go means "this one": send now instead of waiting.
          window.clearTimeout(timer.current);
          if (draft !== value) onCommit(draft);
        }}
      />
      <div className="effort-stops" aria-hidden>
        {levels.map((level, i) => (
          <button
            key={level}
            tabIndex={-1}
            className={i === shown && draft ? 'on' : ''}
            disabled={disabled}
            onClick={() => commit(level, 0)}
          >
            {EFFORT_SHORT[level]}
          </button>
        ))}
      </div>
      <p className="small muted effort-hint" aria-live="polite">
        {draft
          ? EFFORT_TEXT[draft].hint
          : `Claude Code picks the effort for this model.${current ? ' Slide to choose one.' : ''}`}
      </p>
    </div>
  );
}

function nearest(levels: readonly EffortLevel[], level: EffortLevel | ''): number {
  if (!level) return Math.max(0, levels.indexOf('high') >= 0 ? levels.indexOf('high') : 0);
  const want = EFFORT_LEVELS.indexOf(level);
  let best = 0;
  levels.forEach((l, i) => {
    if (
      Math.abs(EFFORT_LEVELS.indexOf(l) - want) <
      Math.abs(EFFORT_LEVELS.indexOf(levels[best]!) - want)
    )
      best = i;
  });
  return best;
}

/**
 * Picks the Claude model and its reasoning effort: for the session on screen now, and
 * for the sessions this phone starts next. The list comes from the agent (the SDK's own
 * list for SDK sessions, the aliases Claude Code accepts for terminal sessions).
 */
export function ModelSheet({
  state,
  send,
  session,
  chosen,
  onChoose,
  effort,
  onChooseEffort,
  disabled,
  onClose,
}: Props) {
  const live = session && session.state !== 'closed' && session.state !== 'error';
  const sessionId = live ? session.id : undefined;
  useEffect(() => {
    if (!disabled) send({ type: 'claude.models', sessionId });
  }, [send, sessionId, disabled]);
  const offer = state.models && state.models.sessionId === sessionId ? state.models : undefined;
  const busy = session?.state === 'running' || session?.state === 'awaiting_permission';
  const terminal = session?.kind === 'voice';
  // Claude Desktop offers its own model names and keeps its own effort setting; picking
  // one there leaves the phone's choice for new sessions alone.
  const desktop = live && session.kind === 'desktop';

  const pick = (value: string) => {
    const model = value === 'default' ? null : value;
    if (sessionId) send({ type: 'claude.model.set', sessionId, model });
    if (!desktop) onChoose(model ?? '');
  };
  const isChosen = (value: string) =>
    desktop ? session.model === value : value === 'default' ? chosen === '' : chosen === value;
  const picked: ModelChoice | undefined =
    offer?.models.find((m) => isChosen(m.value)) ?? offer?.models[0];
  // Unknown (terminal sessions, older Claude Code): offer every level; Claude Code
  // lowers one the model can't use.
  const levels = picked?.efforts ?? EFFORT_LEVELS;

  const chooseEffort = (next: EffortLevel | '') => {
    onChooseEffort(next);
    if (sessionId && !terminal)
      send({ type: 'claude.effort.set', sessionId, effort: next || null });
  };

  const modes = live ? (session.modes ?? []) : [];
  const unsafeOff = live && !modes.some((m) => MODE_TEXT[m].risk !== 'safe');
  const pickMode = (mode: PermissionModeName) => {
    if (!sessionId || mode === session?.permissionMode) return;
    if (
      MODE_TEXT[mode].risk === 'danger' &&
      !confirm(
        'Bypass permissions: Claude will run every edit and command on the PC without asking you. Continue?',
      )
    ) {
      return;
    }
    send({ type: 'claude.mode.set', sessionId, mode });
  };

  return (
    <Sheet title="Mode, model and effort" onClose={onClose}>
      {modes.length > 0 && (
        <>
          <h3>Permission mode</h3>
          <ul className="list mode-list">
            {modes.map((mode) => {
              const current = session?.permissionMode === mode;
              return (
                <li
                  key={mode}
                  className={current ? 'list-row current' : 'list-row'}
                  data-risk={MODE_TEXT[mode].risk}
                >
                  <button
                    className="list-main"
                    aria-pressed={current}
                    disabled={disabled}
                    onClick={() => pickMode(mode)}
                  >
                    <span className="list-title">{MODE_TEXT[mode].name}</span>
                    <span className="small muted">{MODE_TEXT[mode].hint}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {unsafeOff && (
            <p className="small muted">
              Bypass permissions and auto are off on this PC. To allow them, run{' '}
              <code>voicecode-agent modes allow-unsafe</code> there.
            </p>
          )}
          <h3>Model</h3>
        </>
      )}
      <p className="small muted">
        {desktop
          ? `This Claude Desktop session uses ${session.model ?? 'its default model'}. Your choice switches it in Claude Desktop.`
          : sessionId
            ? `This session uses ${modelLabel(session?.model) ?? 'the PC’s default'}. Your choice applies to it now and to new sessions from this phone.`
            : 'Applies to the sessions you start from this phone.'}
      </p>
      {offer?.persistsDefault && (
        <p className="small muted">
          Claude Code in the terminal also saves it as its default for new sessions on the PC.
        </p>
      )}
      {busy && (terminal || desktop) && (
        <p className="small error-text">Claude is working; switch once it has finished.</p>
      )}
      <ul className="list">
        {!offer && <li className="small muted list-note">Loading…</li>}
        {offer?.models.map((m) => (
          <li key={m.value} className={isChosen(m.value) ? 'list-row current' : 'list-row'}>
            <button
              className="list-main"
              aria-pressed={isChosen(m.value)}
              disabled={disabled || (busy && (terminal || desktop))}
              onClick={() => pick(m.value)}
            >
              <span className="list-title">{m.label}</span>
              {m.description && <span className="small muted">{m.description}</span>}
            </button>
          </li>
        ))}
      </ul>

      <h3>Effort</h3>
      {desktop ? (
        <p className="small muted">Claude Desktop keeps its own effort setting; change it there.</p>
      ) : levels.length === 0 ? (
        <p className="small muted">{picked?.label ?? 'This model'} has no effort setting.</p>
      ) : (
        <>
          <EffortSlider
            levels={levels}
            value={effort}
            disabled={disabled}
            onCommit={chooseEffort}
          />
          {terminal && (
            <p className="small muted">
              Terminal sessions take the effort when they start, so this applies to your next
              session.
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
