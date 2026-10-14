import { describe, expect, it } from 'vitest';
import { plainReply } from './Deck';

describe('plainReply', () => {
  it('flattens Markdown into one readable line for the deck display', () => {
    expect(
      plainReply(
        "Done. Here's what I changed:\n\n- Added `hello.txt`\n- Tests: **12 passed**\n\n```bash\nnpm test\n```\n\nSee [the docs](https://x.y).",
      ),
    ).toBe(
      "Done. Here's what I changed: - Added hello.txt - Tests: 12 passed [code] See the docs.",
    );
  });

  it('copes with an unclosed code block while a reply is still arriving', () => {
    expect(plainReply('Running:\n```sh\nnpm t')).toBe('Running: [code]');
  });
});
