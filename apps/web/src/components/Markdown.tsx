import { Fragment, type ReactNode } from 'react';

/*
 * A deliberately small Markdown renderer for Claude's replies: fenced code blocks,
 * headings, bullet/numbered lists, paragraphs, inline code, bold, italics and links.
 * It only ever creates React elements from text (no innerHTML), so model output can
 * never inject markup or script.
 */

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [token] = match;
    const index = match.index;
    if (index > last) out.push(text.slice(last, index));
    if (match[1]) out.push(<code key={index}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    else if (match[3]) out.push(<em key={index}>{token.slice(1, -1)}</em>);
    else if (match[4]) {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token) ?? [];
      out.push(
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[]): ReactNode[] {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(line)}
    </Fragment>
  ));
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

function block(text: string, key: number): ReactNode {
  const lines = text.split('\n');
  const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]!);
  if (heading && lines.length === 1) {
    return (
      <p key={key} className="md-heading">
        {inline(heading[2]!)}
      </p>
    );
  }
  if (lines.every((l) => LIST_ITEM.test(l) || /^\s{2,}\S/.test(l))) {
    const ordered = /^\s*\d+[.)]/.test(lines[0]!);
    const items: string[] = [];
    for (const line of lines) {
      if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, ''));
      else items[items.length - 1] += ` ${line.trim()}`;
    }
    const List = ordered ? 'ol' : 'ul';
    return (
      <List key={key}>
        {items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </List>
    );
  }
  return <p key={key}>{withBreaks(lines)}</p>;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/^```[^\n]*\n?/m);
  // Even indexes are prose, odd indexes are code (an unterminated fence while
  // streaming simply renders as code until it closes).
  return (
    <div className="md">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="md-code">
            <code>{part.replace(/\n$/, '')}</code>
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .map((b) => b.replace(/^\n+|\n+$/g, ''))
            .filter(Boolean)
            .map((b, j) => block(b, i * 1000 + j))
        ),
      )}
    </div>
  );
}

/** Plain-text version for speech: drops code blocks and Markdown punctuation. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
