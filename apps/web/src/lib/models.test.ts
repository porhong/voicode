import { describe, expect, it } from 'vitest';
import { modelLabel } from './models';

describe('modelLabel', () => {
  it('shortens ids, aliases and Claude Code labels', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(modelLabel('Sonnet 5.5')).toBe('Sonnet 5.5');
    expect(modelLabel('Opus 5.5 (default)')).toBe('Opus 5.5');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('default')).toBe('Default');
    expect(modelLabel('some-very-long-custom-model-name')).toBe('some-very-long-…');
    expect(modelLabel(undefined)).toBeUndefined();
  });
});
