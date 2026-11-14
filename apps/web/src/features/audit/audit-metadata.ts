import type { AuditLogEntry } from '@balesin/shared';
import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';

const copy = t.audit;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Nilai rincian untuk dibaca manusia. Isinya apa adanya dari server (sudah disaring rahasianya
 * saat ditulis DAN dikirim); web tidak menambah atau membuka apa pun. Teks dirender sebagai teks
 * React biasa (tidak pernah HTML).
 */
export function metadataValue(value: AuditLogEntry['metadata'][string]): string {
  if (value === null) return copy.emptyValue;
  if (typeof value === 'boolean') return value ? copy.yes : copy.no;
  if (typeof value === 'number') return value.toLocaleString('id-ID');
  if (ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))) return formatDateTime(value);
  return value;
}

export function metadataLabel(key: string): string {
  return Object.hasOwn(copy.metadata, key) ? (copy.metadata[key] ?? key) : key;
}
