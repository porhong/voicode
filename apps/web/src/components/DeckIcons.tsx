/**
 * Keycap glyphs for the deck: one path set per name, drawn with `currentColor` like the
 * other icons. Programmable keys pick from DECK_ICON_NAMES.
 */

const PATHS = {
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9',
  bug: 'M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM12 10v8M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2M10 5 9 3M14 5l1-2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  diff: 'M8 4v8M4 8h8M14 18h7M19 4 5 20',
  commit: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v6M12 16v6',
  broom: 'M14 4l6 6M17 7l-6 6M11 13c-3-1-6 1-7 7 6-1 8-4 7-7zM8 16l-2 2',
  question:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  play: 'M7 4l12 8-12 8z',
  wand: 'M4 20 15 9M14 4v3M19 9h-3M18 5l-2 2M10 4l1 1M19 13l1 1',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  hammer: 'M14 6l4 4M12 8l-8 8a1.5 1.5 0 0 0 2 2l8-8M11 5l3-2 6 6-2 3z',
  rocket:
    'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4-8 9-9 2-.3 4 0 4 0s.3 2 0 4c-1 5-5 8-9 9zM15 9h.01',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  compress: 'M4 9h16M4 15h16M12 3v4l-2-2M12 3l2 2M12 21v-4l-2 2M12 21l2-2',
  // Fixed command keys.
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6',
  cross: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9c6 0 11-1 12-6M18 3l-4 1M18 3l1 4',
  keyboard:
    'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M10 14v6',
} as const;

export type DeckIconName = keyof typeof PATHS;

const COMMAND_ICONS = new Set([
  'check',
  'cross',
  'bolt',
  'branch',
  'keyboard',
  'layers',
  'sliders',
]);

/** Icons offered for programmable keys (the command-key glyphs are reserved). */
export const DECK_ICON_NAMES = (Object.keys(PATHS) as DeckIconName[]).filter(
  (name) => !COMMAND_ICONS.has(name),
);

export function DeckIcon({ name, size = 22 }: { name: DeckIconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
