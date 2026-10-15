import { describe, expect, it } from 'vitest';
import { parseScreen, repaint, translateInput } from './console-attach.js';

describe('translateInput', () => {
  it('maps the dictation tap, terminal keys and pasted prompts to helper commands', () => {
    expect(translateInput(' ')).toEqual([{ kind: 'key', key: 'space' }]);
    expect(translateInput('\r')).toEqual([{ kind: 'key', key: 'enter' }]);
    expect(translateInput('\x1b')).toEqual([{ kind: 'key', key: 'esc' }]);
    expect(translateInput('\x1b[A')).toEqual([{ kind: 'key', key: 'up' }]);
    expect(translateInput('\x1b[Z')).toEqual([{ kind: 'key', key: 'shift-tab' }]);
    expect(translateInput('\x03')).toEqual([{ kind: 'key', key: 'c-c' }]);
    expect(translateInput('y')).toEqual([{ kind: 'text', text: 'y' }]);
    expect(translateInput('\x1b[200~run the\ntests\x1b[201~')).toEqual([
      { kind: 'text', text: 'run the tests' },
    ]);
    expect(translateInput('/voice tap\r')).toEqual([
      { kind: 'text', text: '/voice tap' },
      { kind: 'key', key: 'enter' },
    ]);
    expect(translateInput('a b')).toEqual([{ kind: 'text', text: 'a b' }]);
  });
});

describe('screen snapshots', () => {
  it('parses the helper line and redraws the whole screen with the cursor', () => {
    const text = Buffer.from('> hello\n  hold space to speak\n', 'utf8').toString('base64');
    const screen = parseScreen(`screen 2 40 0 7 ${text}`);
    expect(screen).toEqual({
      rows: 2,
      cols: 40,
      cursorRow: 0,
      cursorCol: 7,
      lines: ['> hello', '  hold space to speak'],
    });
    expect(repaint(screen!)).toBe('\x1b[2J\x1b[H> hello\r\n  hold space to speak\x1b[1;8H');
  });
});
