const MAX_DETAIL = 4_000;
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
    default:
      return `Claude wants to use ${displayName ?? name}`;
  }
}

/** Human-readable, length-limited rendering of a tool input for an approval prompt. */
export function describeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return truncate(
        [str(input.command), str(input.description) && `# ${String(input.description)}`]
          .filter(Boolean)
          .join('\n'),
        MAX_DETAIL,
      );
    case 'Edit':
      return truncate(
        `${str(input.file_path) ?? ''}\n--- old\n${str(input.old_string) ?? ''}\n+++ new\n${str(input.new_string) ?? ''}`,
        MAX_DETAIL,
      );
    case 'Write':
      return truncate(`${str(input.file_path) ?? ''}\n\n${str(input.content) ?? ''}`, MAX_DETAIL);
    default:
      return truncate(JSON.stringify(input, null, 2), MAX_DETAIL);
  }
}

/** Flattens a tool_result content payload to short text. */
export function summarizeToolResult(content: unknown): string {
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
