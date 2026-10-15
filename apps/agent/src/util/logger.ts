import { renameSync, statSync } from 'node:fs';
import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs go to the agent log file; the interactive terminal output is
 * rendered separately by the CLI. `verbose` mirrors the JSON log to stderr as well.
 */
export function createLogger(options: {
  file?: string;
  verbose?: boolean;
  level?: string;
}): Logger {
  const level = options.level ?? process.env.VOICECODE_LOG_LEVEL ?? 'info';
  const streams: pino.StreamEntry[] = [];
  if (options.file) {
    const file = options.file;
    rotateIfLarge(file);
    const dest = pino.destination({ dest: file, mkdir: true, sync: false });
    // A long-running agent rotates too, not only when it starts.
    setInterval(() => {
      if (rotateIfLarge(file)) dest.reopen();
    }, LOG_CHECK_MS).unref();
    streams.push({ level: level as pino.Level, stream: dest });
  }
  if (options.verbose || !options.file) {
    streams.push({ level: level as pino.Level, stream: process.stderr });
  }
  return pino(
    {
      level,
      base: { pid: process.pid },
      redact: {
        paths: ['req.headers.cookie', 'req.headers["x-voicecode-control"]', '*.token', '*.code'],
        censor: '[redacted]',
      },
    },
    pino.multistream(streams),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Log files above this size are rotated to `<file>.1` (replacing the previous one), at
 * start and every few minutes while running, so the log never takes more than ~2× this.
 */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
const LOG_CHECK_MS = 5 * 60_000;

export function rotateIfLarge(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    // Missing file, or the old copy is open elsewhere: try again next time.
    return false;
  }
}
