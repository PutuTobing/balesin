import { createLogger, type LogLevel, type Logger } from './logger';

/**
 * Alat bantu tes: logger sungguhan (dengan seluruh redaksi) yang menulis ke memori.
 * Dipakai tes api/worker untuk memastikan tidak ada rahasia yang ikut ter-log.
 */
export interface LogCapture {
  logger: Logger;
  /** Baris log mentah (JSON), persis seperti yang akan ditulis ke stdout. */
  lines: string[];
  /** Baris log yang sudah di-parse. */
  entries(): Array<Record<string, unknown>>;
  /** Seluruh keluaran sebagai satu teks — untuk memeriksa "tidak mengandung X". */
  text(): string;
}

export function createLogCapture(level: LogLevel = 'trace'): LogCapture {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level,
    destination: { write: (line: string) => void lines.push(line) },
  });
  return {
    logger,
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join(''),
  };
}
