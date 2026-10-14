/**
 * Reads Claude Code's dictation state off its terminal screen. The strings are what
 * the CLI prints in its input footer (`● REC · tap to send`, `listening…`, the
 * `Voice …` error lines); they are matched leniently because they are UI text, not an
 * API, and may change between Claude Code versions.
 */

export interface VoiceScreen {
  /** The CLI is recording (tap mode `● REC`, or hold mode `listening…`). */
  recording: boolean;
  /** Dictation is on (the footer hint or a `Voice mode enabled` line was seen). */
  enabled: boolean;
  /** A voice error line on screen, if any. */
  error?: string;
  /** The CLI is asking a question that only the terminal can answer (trust, menus). */
  dialog?: string;
}

const RECORDING_RE = /●\s*REC\b|\bREC\s*·|\blistening…|\blistening\.\.\./i;
const ENABLED_RE = /hold \S+ to speak|tap \S+ to (?:speak|record)|Voice mode enabled/i;
const ERROR_RE =
  /(Voice mode requires[^\n]*|Voice mode is disabled[^\n]*|Microphone access is denied[^\n]*|No audio detected[^\n]*|No speech detected[^\n]*|Voice connection failed[^\n]*|Voice stream error[^\n]*|Voice input is failing[^\n]*|Unknown command: \/voice[^\n]*|Voice mode could not[^\n]*|Voice mode requires SoX[^\n]*)/i;
// Claude Code's folder safety check (its default answer is "No, exit"), and other menus.
const DIALOG_RE =
  /(Quick\s*safety\s*check|Do you trust the files in this folder\?|Is this a project you created|Yes,\s*I\s*trust\s*this\s*folder|Yes, proceed|Press Enter to continue)/i;

export function readVoiceScreen(lines: string[]): VoiceScreen {
  const text = lines.join('\n');
  const error = ERROR_RE.exec(text)?.[1]?.trim();
  const dialog = DIALOG_RE.exec(text)?.[1];
  return {
    recording: RECORDING_RE.test(text),
    enabled: ENABLED_RE.test(text) || RECORDING_RE.test(text),
    error: error || undefined,
    dialog: dialog || undefined,
  };
}
