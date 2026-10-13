import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, speakableText } from './Markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown', () => {
  it('renders code fences, lists, headings and inline styles', () => {
    const html = render(
      '## Plan\n\n1. Run `npm test`\n2. Fix **failures**\n\n```ts\nconst x = 1;\n```\n\nSee [docs](https://example.com).',
    );
    expect(html).toContain('<p class="md-heading">Plan</p>');
    expect(html).toContain(
      '<ol><li>Run <code>npm test</code></li><li>Fix <strong>failures</strong></li></ol>',
    );
    expect(html).toContain('<pre class="md-code"><code>const x = 1;</code></pre>');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('never turns model output into markup', () => {
    const html = render('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="javascript');
  });

  it('renders an unterminated fence (mid-stream) as code', () => {
    expect(render('Here:\n```\npartial')).toContain(
      '<pre class="md-code"><code>partial</code></pre>',
    );
  });

  it('produces speakable text without code or punctuation', () => {
    expect(speakableText('**Done.** Ran `npm test`:\n```\nok\n```\nSee [docs](https://x.y).')).toBe(
      'Done. Ran npm test: (code omitted) See docs.',
    );
  });
});
