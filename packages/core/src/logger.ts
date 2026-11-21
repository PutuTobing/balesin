import { createRequire } from 'node:module';

import { pino, type DestinationStream, type LogFn, type Logger, type LoggerOptions } from 'pino';

import { describeError, redactSecrets, sanitizeText, scrubSecretsInJsonLine } from './redact';
import { REDACTED } from './secret';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CreateLoggerOptions {
  /** Nama layanan (`api`, `worker`): muncul di setiap baris log. */
  service: string;
  level: LogLevel;
  /** Keluaran berwarna yang enak dibaca. Hanya untuk development; butuh `pino-pretty`. */
  pretty?: boolean;
  /** Tujuan keluaran khusus (dipakai tes). Mengabaikan `pretty`. */
  destination?: DestinationStream;
}

/**
 * Lapis tambahan lewat mekanisme `redact` bawaan pino untuk lokasi header yang sudah pasti.
 * Lapis utamanya tetap `redactSecrets` (berbasis nama kunci, sedalam apa pun).
 */
const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-balesin-signature',
];
const HEADER_PARENTS = [
  'headers',
  'req.headers',
  'request.headers',
  'res.headers',
  'response.headers',
];
const PINO_REDACT_PATHS = HEADER_PARENTS.flatMap((parent) =>
  SENSITIVE_HEADERS.map((header) => `${parent}["${header}"]`),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Hanya path: query string bisa memuat rahasia (mis. `hub.verify_token`) atau data pelanggan. */
function pathOnly(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Serializer `req`: sengaja minimal. Header dan body TIDAK PERNAH di-log
 * (token, cookie, isi pesan pelanggan). Menerima request Fastify maupun `IncomingMessage`.
 */
export function serializeRequest(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) return {};
  const socket = isRecord(request.socket) ? request.socket : undefined;
  return {
    method: request.method,
    url: typeof request.url === 'string' ? pathOnly(request.url) : undefined,
    ip: request.ip ?? socket?.remoteAddress,
  };
}

/** Serializer `res`: hanya kode status. */
export function serializeResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) return {};
  return { statusCode: response.statusCode };
}

function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const { req, res, err, ...rest } = object;
  const result = redactSecrets(rest) as Record<string, unknown>;
  // Tiga kunci ini punya serializer sendiri (lihat `serializers` di createLogger).
  if (req !== undefined) result.req = req;
  if (res !== undefined) result.res = res;
  if (err !== undefined) result.err = err;
  return result;
}

/**
 * pino memakai `err.message` mentah sebagai pesan bila log error ditulis tanpa pesan
 * (`log.error(err)` / `log.error({ err })`). Pesan mentah bisa memuat nilai parameter query,
 * jadi di sini pesannya diganti versi aman.
 */
function withSafeErrorMessage(args: unknown[]): unknown[] {
  const [first, second, ...rest] = args;
  if (first instanceof Error) {
    return typeof second === 'string'
      ? [{ err: first }, second, ...rest]
      : [{ err: first }, describeError(first)];
  }
  if (isRecord(first) && first.err instanceof Error && typeof second !== 'string') {
    return [first, describeError(first.err)];
  }
  return args;
}

/**
 * Menyiapkan argumen `log.info(...)` sebelum pino menyusun pesannya.
 *
 * pino menyisipkan argumen format (`%s`, `%j`, `%o`) langsung ke teks pesan, melewati
 * `formatters.log`. Karena itu di sini pesan dan setiap argumen format disensor dulu: teks
 * lewat `sanitizeText`, objek lewat `redactSecrets` (sensor berbasis nama kunci tetap berlaku
 * untuk `log.info('payload %j', { password })`).
 */
function prepareLogArguments(args: unknown[]): unknown[] {
  const prepared = withSafeErrorMessage(args);
  // Sama seperti pino: bila argumen pertama objek (termasuk null), pesan ada di argumen kedua.
  const messageAt = typeof prepared[0] === 'object' ? 1 : 0;
  return prepared.map((arg, index) => {
    if (index < messageAt) return arg;
    if (typeof arg === 'string') return sanitizeText(arg);
    return typeof arg === 'object' && arg !== null ? redactSecrets(arg) : arg;
  });
}

/**
 * pino tidak menerapkan `formatters.bindings` ke child logger, jadi binding child
 * (`logger.child({ ... })`) disensor di sini. Child dari child ikut tercakup karena
 * setiap child mewarisi method ini dari induknya.
 */
function redactChildBindings(logger: Logger): Logger {
  type CreateChild = (
    this: unknown,
    bindings: Record<string, unknown>,
    options?: unknown,
  ) => unknown;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- selalu dipanggil lewat .call(this)
  const createChild = logger.child as unknown as CreateChild;
  const createRedactedChild: CreateChild = function (bindings, options) {
    return createChild.call(this, redactLogObject(bindings), options);
  };
  logger.child = createRedactedChild as unknown as Logger['child'];
  return logger;
}

/** `pino-pretty` hanya ada di instalasi development; bila tidak ada, log tetap JSON. */
function resolvePrettyTarget(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
}

/**
 * Logger pino bersama untuk api dan worker, dengan redaksi rahasia berlapis:
 *  - `req`/`res` hanya memuat method, path, IP, dan status;
 *  - nilai dari kunci berbau rahasia disensor di kedalaman berapa pun, termasuk di dalam error;
 *  - pola rahasia di teks (pesan log, stack, URL) disensor tepat sebelum baris ditulis.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: PINO_REDACT_PATHS, censor: REDACTED },
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: redactSecrets,
    },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: redactLogObject,
      log: redactLogObject,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, prepareLogArguments(args) as Parameters<LogFn>);
      },
      streamWrite: scrubSecretsInJsonLine,
    },
  };

  if (options.destination) {
    return redactChildBindings(pino(loggerOptions, options.destination));
  }

  const prettyTarget = options.pretty ? resolvePrettyTarget() : undefined;
  if (prettyTarget) {
    return redactChildBindings(
      pino({
        ...loggerOptions,
        transport: {
          target: prettyTarget,
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
    );
  }
  return redactChildBindings(pino(loggerOptions));
}
