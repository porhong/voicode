import { describe, expect, it } from 'vitest';
import { withoutImageMentions } from './pty-session.js';

describe('withoutImageMentions', () => {
  it('drops the attached image paths and counts them', () => {
    expect(withoutImageMentions('what is this?\n\nAttached image: C:\\a\\b.png')).toEqual({
      text: 'what is this?',
      images: 1,
    });
  });

  it('handles the [Image #N] tokens Claude Code puts in place of the paths', () => {
    // As seen in Claude Code 2.1.299's transcript after pasting one path.
    expect(withoutImageMentions('[Image #1]What colour is this image?\nAttached image:')).toEqual({
      text: 'What colour is this image?',
      images: 1,
    });
    expect(
      withoutImageMentions('[Image #1] [Image #2] compare\nAttached image:\nAttached image:'),
    ).toEqual({ text: 'compare', images: 2 });
  });

  it('leaves a plain prompt alone', () => {
    expect(withoutImageMentions('run the tests')).toEqual({ text: 'run the tests', images: 0 });
  });
});
