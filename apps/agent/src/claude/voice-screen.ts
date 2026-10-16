import type { PermissionModeName } from '@voicecode/protocol';

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

/** Claude Code's footer per permission mode (checked on Claude Code 2.1.299). */
const MODE_FOOTERS: Array<[RegExp, PermissionModeName]> = [
  [/bypass permissions on/i, 'bypassPermissions'],
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
  [/manual mode on/i, 'default'],
];

/**
 * The permission mode the footer shows. The footer is the last lines of the screen;
 * earlier output could mention a mode in passing, so only the bottom is read.
 */
export function readPermissionMode(lines: string[]): PermissionModeName | undefined {
  const footer = lines
    .filter((l) => l.trim())
    .slice(-3)
    .join('\n');
  return MODE_FOOTERS.find(([re]) => re.test(footer))?.[1];
}

/**
 * A menu Claude Code shows in the terminal (folder trust, a tool permission prompt, a
 * question): what it asks, the lines above it (the tool and command it is about), the
 * options, and which one the cursor is on.
 */
export interface ScreenMenu {
  question: string;
  /** What Claude Code shows above the question, as it shows it (wrapped lines joined). */
  detail: string[];
  options: string[];
  selected: number;
}

const MENU_FOOTER_RE = /Enter to confirm|Esc to cancel|to select|to navigate/i;
const SEPARATOR_RE = /^[\s─━═╌┄-]+$/;

/**
 * Reads the menu off the screen, if one is open. Its cursor (`❯`) is indented, unlike
 * the input prompt's at the start of a line; options are the lines in the cursor's
 * column (numbered or not), and a deeper-indented line continues the option above.
 * A list in Claude's own reply has no cursor, so it is never taken for a menu.
 */
export function readMenu(lines: string[]): ScreenMenu | undefined {
  const cursorAt = lines.findLastIndex((l) => /^\s+❯\s+\S/.test(l));
  if (cursorAt < 0) return undefined;
  const col = lines[cursorAt]!.indexOf('❯');
  const optionText = (line: string): string | undefined => {
    if (line.length <= col + 2) return undefined;
    const marker = line.slice(col, col + 2);
    if (line.slice(0, col).trim() || (marker !== '❯ ' && marker !== '  ')) return undefined;
    const rest = line.slice(col + 2);
    return /^\S/.test(rest) ? rest.trimEnd() : undefined;
  };
  const isContinuation = (line: string) =>
    line.length > col + 3 && !line.slice(0, col + 3).trim() && /^\s+\S/.test(line.slice(col + 2));

  // Down from the cursor, then up: each option, with its wrapped lines.
  const rows: Array<{ text: string; at: number }> = [];
  let end = cursorAt;
  for (let i = cursorAt; i < lines.length; i++) {
    const text = optionText(lines[i]!);
    if (text !== undefined) {
      rows.push({ text, at: i });
      end = i;
    } else if (isContinuation(lines[i]!) && rows.length) {
      rows[rows.length - 1]!.text += ` ${lines[i]!.trim()}`;
      end = i;
    } else break;
  }
  let start = cursorAt;
  for (let i = cursorAt - 1; i >= 0; i--) {
    const text = optionText(lines[i]!);
    if (text !== undefined) {
      rows.unshift({ text, at: i });
      start = i;
    } else if (isContinuation(lines[i]!)) {
      continue; // folded into the option above it on the way down only
    } else break;
  }
  if (rows.length < 2) return undefined;
  const numbered = rows.every((r, i) => r.text.startsWith(`${i + 1}. `));
  const footer = lines.slice(end + 1, end + 4).some((l) => MENU_FOOTER_RE.test(l));
  if (!numbered && !footer) return undefined;

  // The question and what is above it, up to the full-width rule that opens the dialog.
  const above: string[] = [];
  for (let i = start - 1; i >= 0 && above.length < 24; i--) {
    const line = lines[i]!;
    if (/^\s*─{10,}\s*$/.test(line)) break;
    above.unshift(line);
  }
  const content = above.filter((l) => l.trim() && !SEPARATOR_RE.test(l)).map((l) => l.trim());
  if (!content.length) return undefined;
  // The question is the last sentence asking one, even mid-paragraph (the trust check);
  // the lines above stay as the terminal shows them.
  const paragraphs = above
    .map((l) => (SEPARATOR_RE.test(l) ? '' : l.trim()))
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  // A line that is a question wins; else the asking sentence of a paragraph.
  const questionLine = content.findLastIndex((l) => l.endsWith('?'));
  const asking = paragraphs.findLast((p) => p.includes('?'));
  const question =
    questionLine >= 0
      ? content[questionLine]!
      : asking
        ? (
            /^.*?\?(?=\s|$)/.exec(asking.slice(0, asking.lastIndexOf('?') + 1))?.[0] ?? asking
          ).trim()
        : content.at(-1)!;
  const detail =
    questionLine >= 0
      ? content.filter((_, i) => i !== questionLine)
      : content.at(-1) === question
        ? content.slice(0, -1)
        : content;
  return {
    question,
    detail,
    options: rows.map((r) => (numbered ? r.text.replace(/^\d+\.\s+/, '') : r.text)),
    selected: rows.findIndex((r) => r.at === cursorAt),
  };
}
