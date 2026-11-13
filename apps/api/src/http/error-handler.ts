import { AppError } from '@balesin/core';
import {
  ERROR_MESSAGES,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorDetail,
  type ErrorDetailLocation,
  type ErrorEnvelope,
} from '@balesin/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  ResponseSerializationError,
} from 'fastify-type-provider-zod';

/**
 * Penanganan error seragam. Semua respons gagal berbentuk amplop:
 *
 *   { "error": { "code", "message", "details"?, "requestId" } }
 *
 * Prinsip: hanya `AppError` yang pesannya dikirim ke klien. Error lain dijawab dengan pesan
 * umum sesuai statusnya; pesan/stack aslinya hanya masuk log (lewat logger yang menyensor
 * rahasia).
 */

interface ErrorResponse {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
}

const VALIDATION_LOCATIONS: Record<string, ErrorDetailLocation> = {
  body: 'body',
  querystring: 'query',
  params: 'params',
  headers: 'headers',
};

/** Kode error Fastify yang layak dapat pesan lebih spesifik daripada pesan umum statusnya. */
const FASTIFY_ERRORS: Record<string, { code: ErrorCode; message?: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: 'BAD_REQUEST',
    message: 'Isi permintaan bukan JSON yang valid.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    code: 'BAD_REQUEST',
    message: 'Isi permintaan kosong, padahal seharusnya berisi JSON.',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { code: 'BAD_REQUEST' },
  FST_ERR_CTP_BODY_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { code: 'UNSUPPORTED_MEDIA_TYPE' },
  FST_ERR_BAD_URL: { code: 'BAD_REQUEST', message: 'Alamat yang diminta tidak valid.' },
  FST_ERR_VALIDATION: { code: 'VALIDATION_ERROR' },
};

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `/alamat/kota` → `alamat.kota` */
function fieldFromInstancePath(instancePath: string): string {
  return instancePath.split('/').filter(Boolean).join('.');
}

function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const context = (error as { validationContext?: string }).validationContext ?? '';
    const location = VALIDATION_LOCATIONS[context];
    return {
      statusCode: ERROR_STATUS.VALIDATION_ERROR,
      code: 'VALIDATION_ERROR',
      message: ERROR_MESSAGES.VALIDATION_ERROR,
      details: error.validation.map((issue) => ({
        ...(location ? { location } : {}),
        field: fieldFromInstancePath(issue.instancePath),
        message: issue.message ?? 'Tidak valid.',
      })),
    };
  }

  // Respons kita sendiri tidak cocok dengan skemanya: bug server, bukan salah klien.
  if (error instanceof ResponseSerializationError) return internalError();

  // Status 4xx hanya dihormati bila berasal dari Fastify sendiri (kode `FST_…`: body rusak,
  // tipe konten salah, URL rusak, dsb.). Error pustaka lain yang kebetulan membawa
  // `statusCode` — mis. klien HTTP saat API luar menjawab 401 — BUKAN kesalahan pengguna kita:
  // dijawab 500 dan dicatat lengkap, supaya "token Meta kedaluwarsa" tidak tampil sebagai
  // "kamu belum masuk". Modul yang ingin menjawab 4xx harus melempar `AppError`.
  if (isRecord(error) && typeof error.code === 'string' && error.code.startsWith('FST_')) {
    const known = FASTIFY_ERRORS[error.code];
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const code = known?.code ?? CODE_BY_STATUS[statusCode] ?? 'BAD_REQUEST';
      return { statusCode, code, message: known?.message ?? ERROR_MESSAGES[code] };
    }
  }

  return internalError();
}

function internalError(): ErrorResponse {
  return {
    statusCode: ERROR_STATUS.INTERNAL_ERROR,
    code: 'INTERNAL_ERROR',
    message: ERROR_MESSAGES.INTERNAL_ERROR,
  };
}

function envelope(response: ErrorResponse, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: response.code,
      message: response.message,
      ...(response.details && response.details.length > 0 ? { details: response.details } : {}),
      requestId,
    },
  };
}

/** Error handler Fastify (`app.setErrorHandler`). */
export function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const response = toErrorResponse(error);

  if (response.statusCode >= 500) {
    request.log.error({ err: error }, 'Permintaan gagal karena kesalahan di server');
  } else if (error instanceof AppError && error.cause !== undefined) {
    request.log.warn({ err: error, errorCode: response.code }, 'Permintaan ditolak');
  } else {
    request.log.info(
      { errorCode: response.code, statusCode: response.statusCode },
      'Permintaan ditolak',
    );
  }

  return reply.status(response.statusCode).send(envelope(response, request.id));
}

/** Handler 404 (`app.setNotFoundHandler`). */
export function handleNotFound(request: FastifyRequest, reply: FastifyReply) {
  const response: ErrorResponse = {
    statusCode: ERROR_STATUS.NOT_FOUND,
    code: 'NOT_FOUND',
    message: ERROR_MESSAGES.NOT_FOUND,
  };
  return reply.status(response.statusCode).send(envelope(response, request.id));
}
