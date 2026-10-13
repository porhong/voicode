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
    rotateIfLarge(options.file);
    streams.push({
      level: level as pino.Level,
      stream: pino.destination({ dest: options.file, mkdir: true, sync: false }),
    });
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

/** Log files above this size are rotated to `<file>.1` when the agent starts. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // Missing file or rename race: nothing to rotate.
  }
}
