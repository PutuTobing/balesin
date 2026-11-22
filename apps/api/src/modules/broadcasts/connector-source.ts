import { fetchRemoteFile, type Lookup, type RemoteFileError } from '@balesin/core';
import { BROADCAST_LIMITS, type BroadcastConnectorTestCode } from '@balesin/shared';

import type { ParsedTable } from './recipient-import';

/**
 * Konektor REST sumber penerima broadcast (Fase 4, SECURITY §6 "Konektor sumber data broadcast
 * mengikuti aturan yang sama"): GET lewat `fetchRemoteFile` — SSRF webhook keluar (alamat terlarang
 * selalu ditolak, IP privat hanya lewat allowlist organisasi, https untuk publik, DNS sekali, port
 * dibatasi), TANPA redirect (header autentikasi tidak pernah ikut ke tempat lain), tenggat 20 dtk, maks.
 * 5 MB. Jawaban JSON = array objek (di akar atau di `itemsPath`); nilai primitif jadi kolom teks.
 * URL & header tidak pernah ditulis ke log.
 */

export interface ConnectorFetchInput {
  url: string;
  header: { name: string; value: string } | null;
  itemsPath: string;
  phoneField: string;
  privateCidrs: readonly string[];
  allowLoopback?: boolean;
  lookup?: Lookup;
}

export type ConnectorFetchResult =
  | { ok: true; table: ParsedTable; items: number }
  | { ok: false; code: Exclude<BroadcastConnectorTestCode, 'ok'> };

function failureCode(
  error: RemoteFileError,
  httpStatus: number | null,
): Exclude<BroadcastConnectorTestCode, 'ok'> {
  switch (error) {
    case 'invalid_url':
    case 'scheme':
    case 'port':
    case 'credentials':
    case 'host_not_allowed':
      return 'invalid_url';
    case 'blocked_address':
      return 'blocked_address';
    case 'private_not_allowed':
      return 'private_not_allowed';
    case 'https_required':
      return 'https_required';
    case 'dns':
      return 'dns';
    case 'timeout':
      return 'timeout';
    case 'too_large':
      return 'too_large';
    case 'http':
      return httpStatus === 401 || httpStatus === 403 ? 'auth_failed' : 'http_error';
    case 'redirect':
      return 'http_error';
    case 'network':
      return 'network';
  }
}

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/** Objek JSON → tabel (kolom = kunci bernilai primitif, urut kemunculan, maks. 30). */
export function jsonItemsToTable(
  body: unknown,
  itemsPath: string,
): { ok: true; table: ParsedTable } | { ok: false; code: 'items_not_found' | 'too_many_items' } {
  let current: unknown = body;
  for (const key of itemsPath === '' ? [] : itemsPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { ok: false, code: 'items_not_found' };
    }
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  if (!Array.isArray(current)) return { ok: false, code: 'items_not_found' };
  if (current.length > BROADCAST_LIMITS.maxRecipients) return { ok: false, code: 'too_many_items' };
  const columns: string[] = [];
  const objects = current.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
  for (const item of objects) {
    for (const [key, value] of Object.entries(item)) {
      if (
        valueText(value) !== null &&
        !columns.includes(key) &&
        columns.length < BROADCAST_LIMITS.maxColumns &&
        key.length <= BROADCAST_LIMITS.maxColumnNameLength &&
        !/[\p{Cc}\p{Cf}]/u.test(key)
      ) {
        columns.push(key);
      }
    }
  }
  return {
    ok: true,
    table: {
      columns,
      rows: objects.map((item, index) => ({
        row: index + 1,
        values: columns.map((column) =>
          Object.hasOwn(item, column) ? (valueText(item[column]) ?? '') : '',
        ),
      })),
    },
  };
}

export async function fetchConnectorTable(
  input: ConnectorFetchInput,
): Promise<ConnectorFetchResult> {
  const response = await fetchRemoteFile({
    url: input.url,
    privateCidrs: input.privateCidrs,
    maxBytes: BROADCAST_LIMITS.maxConnectorBytes,
    timeoutMs: 20_000,
    maxRedirects: 0,
    headers: {
      accept: 'application/json',
      'user-agent': 'Balesin-Konektor/1.0',
      ...(input.header ? { [input.header.name]: input.header.value } : {}),
    },
    ...(input.allowLoopback ? { allowLoopback: true } : {}),
    ...(input.lookup ? { lookup: input.lookup } : {}),
  });
  if (!response.ok) return { ok: false, code: failureCode(response.error, response.httpStatus) };
  let body: unknown;
  try {
    body = JSON.parse(response.body.toString('utf8'));
  } catch {
    return { ok: false, code: 'not_json' };
  }
  const parsed = jsonItemsToTable(body, input.itemsPath);
  if (!parsed.ok) return parsed;
  if (parsed.table.rows.length > 0 && !parsed.table.columns.includes(input.phoneField)) {
    return { ok: false, code: 'phone_field_missing' };
  }
  return { ok: true, table: parsed.table, items: parsed.table.rows.length };
}
