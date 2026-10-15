import { describe, expect, it } from 'vitest';
import { approvalMoreLines, approvalSummary, plainReply } from './Deck';

describe('approvalSummary', () => {
  it('names a tool call by the first non-empty line of its input', () => {
    expect(approvalSummary('\n  npm test -- --run\n# Run the test suite')).toBe(
      'npm test -- --run',
    );
  });

  it('collapses runs of whitespace and copes with empty input', () => {
    expect(approvalSummary('git   commit\t-m "x"')).toBe('git commit -m "x"');
    expect(approvalSummary('   \n  ')).toBe('');
  });
});

describe('approvalMoreLines', () => {
  it('counts the non-empty lines the one-line summary leaves out', () => {
    expect(approvalMoreLines('npm test')).toBe(0);
    expect(approvalMoreLines('\n  cd app\n\nnpm ci\nnpm test\n')).toBe(2);
    expect(approvalMoreLines('   \n  ')).toBe(0);
  });

  it("leaves out a Bash call's trailing description comment, and only for Bash", () => {
    expect(approvalMoreLines('npm test\n# Run the test suite', 'Bash')).toBe(0);
    expect(approvalMoreLines('npm ci\nnpm test\n# Run the tests', 'Bash')).toBe(1);
    expect(approvalMoreLines('# Title\n# Heading', 'Write')).toBe(1);
  });
});

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
