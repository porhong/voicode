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
