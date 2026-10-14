import { describe, expect, it } from 'vitest';
import { DECK_PACKS, DEFAULT_DECK, KEY_COUNT, parseDeck } from './useDeck';

describe('parseDeck', () => {
  it('falls back to the default layout for missing or broken data', () => {
    expect(parseDeck(undefined)).toEqual(DEFAULT_DECK);
    expect(parseDeck('nonsense')).toEqual(DEFAULT_DECK);
    expect(parseDeck({ keys: 'x', stick: 3 })).toEqual(DEFAULT_DECK);
  });

  it('keeps valid customisations and repairs invalid fields one by one', () => {
    const deck = parseDeck({
      keys: [
        { label: 'Mine', icon: 'rocket', prompt: 'Do the thing', review: true },
        { label: 42, icon: 'not-an-icon', prompt: 'Kept' },
      ],
      stick: { up: { label: 'Go', icon: 'play', prompt: 'Continue please', review: false } },
    });
    expect(deck.keys).toHaveLength(KEY_COUNT);
    expect(deck.keys[0]).toEqual({
      label: 'Mine',
      icon: 'rocket',
      prompt: 'Do the thing',
      review: true,
    });
    expect(deck.keys[1]).toEqual({ ...DEFAULT_DECK.keys[1], prompt: 'Kept' });
    expect(deck.keys[2]).toEqual(DEFAULT_DECK.keys[2]);
    expect(deck.stick.up.label).toBe('Go');
    expect(deck.stick.left).toEqual(DEFAULT_DECK.stick.left);
  });

  it('does not let reserved command-key icons onto programmable keys', () => {
    const deck = parseDeck({ keys: [{ label: 'X', icon: 'check', prompt: 'p', review: false }] });
    expect(deck.keys[0]!.icon).toBe(DEFAULT_DECK.keys[0]!.icon);
  });

  it('ships complete packs', () => {
    for (const pack of DECK_PACKS) {
      expect(parseDeck(pack.config)).toEqual(pack.config);
    }
  });
});
