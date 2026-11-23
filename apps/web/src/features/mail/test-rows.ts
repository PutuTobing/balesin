import {
  MAIL_FOLDER_ROLE_NAMES,
  MAIL_TEST_HINTS,
  mailTestCodeKind,
  type MailTestCode,
  type TestMailAccountResponse,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import { formatBytes } from './mail-format';

const w = t.mail.wizard;

export type Tone = 'ok' | 'fail' | 'warn' | 'info' | 'pending';

export interface Row {
  key: string;
  tone: Tone;
  title: string;
  body: string;
  /** Langkah perbaikan spesifik untuk kode galat (baris kedua, lebih redup). */
  hint?: string;
  durationMs?: number;
}

/**
 * Judul baris gagal menurut jenis kode (review 9A P9): galat koneksi (host/port/TLS/timeout) belum
 * sampai ke proses masuk, jadi judulnya bukan "Masuk ke … gagal".
 */
export function failedTitle(side: 'incoming' | 'outgoing', code: MailTestCode): string {
  const kind = mailTestCodeKind(code);
  if (side === 'incoming') {
    return kind === 'connection' ? w.incomingUnreachable : w.incomingFailed;
  }
  return kind === 'connection' ? w.outgoingUnreachable : w.outgoingFailed;
}

/** Semua sisi yang gagal adalah galat koneksi → saran "tes ulang setelah port dibuka". */
export function onlyConnectionFailures(result: TestMailAccountResponse): boolean {
  const failed = [result.incoming, result.outgoing].filter((side) => side && !side.ok);
  return (
    failed.length > 0 &&
    failed.every((side) => side && mailTestCodeKind(side.code) === 'connection')
  );
}

/** Baris hasil tes Masuk/Keluar (kontrak §4.2), terpisah per sisi dengan sebab galat Indonesia. */
export function testRows(result: TestMailAccountResponse, emailAddress: string): Row[] {
  const rows: Row[] = [];
  const incoming = result.incoming;
  const details = incoming?.details ?? null;
  if (incoming) {
    rows.push(
      incoming.ok
        ? {
            key: 'incoming',
            tone: 'ok',
            title: w.incomingOk,
            body: details
              ? w.incomingDetail(details.folderCount, details.inboxTotal)
              : incoming.message,
            durationMs: incoming.durationMs,
          }
        : {
            key: 'incoming',
            tone: 'fail',
            title: failedTitle('incoming', incoming.code),
            body: incoming.message,
            hint: MAIL_TEST_HINTS[incoming.code] ?? undefined,
            durationMs: incoming.durationMs || undefined,
          },
    );
    if (incoming.ok && details) {
      const special = details.specialFolders
        .filter((role) => role !== 'inbox' && role !== 'all' && role !== 'flagged')
        .map((role) => MAIL_FOLDER_ROLE_NAMES[role]);
      rows.push(
        special.length > 0
          ? {
              key: 'special',
              tone: 'ok',
              title: w.specialTitle,
              body: w.specialBody(listText(special)),
            }
          : { key: 'special', tone: 'info', title: w.specialNoneTitle, body: w.specialNoneBody },
      );
    }
  }
  const outgoing = result.outgoing;
  if (outgoing) {
    rows.push(
      outgoing.ok
        ? {
            key: 'outgoing',
            tone: 'ok',
            title: w.outgoingOk,
            body: w.outgoingDetail(emailAddress),
            durationMs: outgoing.durationMs,
          }
        : {
            key: 'outgoing',
            tone: 'fail',
            title: failedTitle('outgoing', outgoing.code),
            body: outgoing.message,
            hint: MAIL_TEST_HINTS[outgoing.code] ?? undefined,
            durationMs: outgoing.durationMs || undefined,
          },
    );
  }
  if (incoming?.ok && details) {
    rows.push(
      details.idle
        ? { key: 'idle', tone: 'info', title: w.idleTitle, body: w.idleBody }
        : { key: 'idle', tone: 'info', title: w.noIdleTitle, body: w.noIdleBody },
    );
    if (details.quota && details.quota.limitBytes > 0) {
      rows.push({
        key: 'quota',
        tone: incoming.code === 'imap_quota_full' ? 'warn' : 'info',
        title: w.quotaTitle,
        body:
          incoming.code === 'imap_quota_full'
            ? incoming.message
            : w.quota(formatBytes(details.quota.usedBytes), formatBytes(details.quota.limitBytes)),
      });
    }
  }
  return rows;
}

/** "Terkirim, Draf, dan Sampah". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, dan ${items.at(-1) ?? ''}`;
}
