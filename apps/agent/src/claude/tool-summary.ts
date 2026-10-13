/** Approval details up to this many characters are shown in full (scrollable). */
const MAX_DETAIL = 60_000;
const MAX_SUMMARY = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** One-line description of a tool call for the transcript. */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const summary =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.url) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.description) ??
    '';
  return truncate(summary ? `${name}: ${summary}` : name, MAX_SUMMARY);
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

/** Approval prompt title, used when the SDK does not supply one. */
export function describeToolTitle(
  name: string,
  input: Record<string, unknown>,
  displayName?: string,
): string {
  const file = str(input.file_path) ?? str(input.notebook_path);
  switch (name) {
    case 'Bash':
      return 'Claude wants to run a command';
    case 'Write':
      return file ? `Claude wants to create ${baseName(file)}` : 'Claude wants to create a file';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Claude wants to edit ${baseName(file)}` : 'Claude wants to edit a file';
    case 'WebFetch':
      return 'Claude wants to fetch a web page';
    case 'ExitPlanMode':
      return 'Claude has a plan and wants to start working';
    default:
      return `Claude wants to use ${displayName ?? name}`;
  }
}

/**
 * Characters that render invisibly or reorder text (control and format characters such
 * as bidi overrides) are shown as visible escapes, so an approval cannot hide part of a
 * command. Newlines and tabs are kept.
 */
export function revealHidden(text: string): string {
  return text.replace(
    /[^\P{Cc}\n\t]|\p{Cf}/gu,
    (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

export interface ToolInputView {
  detail: string;
  /** False when the input was too long to show in full; it must not be approved then. */
  complete: boolean;
}

function view(text: string): ToolInputView {
  const shown = revealHidden(text);
  if (shown.length <= MAX_DETAIL) return { detail: shown, complete: true };
  const hidden = shown.length - MAX_DETAIL;
  return {
    detail: `${shown.slice(0, MAX_DETAIL)}\n… ${hidden.toLocaleString('en-US')} more characters not shown`,
    complete: false,
  };
}

/** What an approval prompt shows for a tool input: never silently shortened. */
export function describeToolInput(name: string, input: Record<string, unknown>): ToolInputView {
  switch (name) {
    case 'Bash':
      return view(
        [str(input.command), str(input.description) && `# ${String(input.description)}`]
          .filter(Boolean)
          .join('\n'),
      );
    case 'Edit':
      return view(
        `${str(input.file_path) ?? ''}\n--- old\n${str(input.old_string) ?? ''}\n+++ new\n${str(input.new_string) ?? ''}`,
      );
    case 'Write':
      return view(`${str(input.file_path) ?? ''}\n\n${str(input.content) ?? ''}`);
    case 'ExitPlanMode':
      return view(str(input.plan) ?? '');
    default:
      return view(JSON.stringify(input, null, 2));
  }
}

/** Prefix of the tool_result Claude Code returns when the user rejects a tool call. */
const REJECTION_PREFIX = "The user doesn't want to proceed with this tool use";

/** Flattens a tool_result content payload to short text. */
export function summarizeToolResult(content: unknown): string {
  const text = flattenToolResult(content);
  return text.startsWith(REJECTION_PREFIX) ? 'Rejected' : text;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return truncate(content, MAX_SUMMARY * 2);
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block ? String(block.text) : '',
      )
      .join('\n');
    return truncate(text, MAX_SUMMARY * 2);
  }
  return '';
}
