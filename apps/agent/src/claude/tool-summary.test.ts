import { describe, expect, it } from 'vitest';
import { describeToolTitle, summarizeToolResult, summarizeToolUse } from './tool-summary.js';

describe('tool summaries', () => {
  it('titles approvals by what the tool will do', () => {
    expect(describeToolTitle('Write', { file_path: 'C:\\proj\\src\\a.ts' })).toBe(
      'Claude wants to create a.ts',
    );
    expect(describeToolTitle('Edit', { file_path: '/proj/b.ts' })).toBe(
      'Claude wants to edit b.ts',
    );
    expect(describeToolTitle('Bash', { command: 'rm -rf /' })).toBe(
      'Claude wants to run a command',
    );
    expect(describeToolTitle('mcp__x__y', {}, 'Do thing')).toBe('Claude wants to use Do thing');
  });

  it('collapses the rejection boilerplate', () => {
    expect(
      summarizeToolResult(
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit…",
      ),
    ).toBe('Rejected');
    expect(summarizeToolResult([{ type: 'text', text: 'v24.0.0' }])).toBe('v24.0.0');
  });

  it('summarizes tool calls by their most telling argument', () => {
    expect(summarizeToolUse('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(summarizeToolUse('Read', { file_path: '/a' })).toBe('Read: /a');
    expect(summarizeToolUse('TodoWrite', {})).toBe('TodoWrite');
  });
});
