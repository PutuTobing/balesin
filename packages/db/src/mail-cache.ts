import { sql } from 'drizzle-orm';

import type { DbExecutor } from './client';

/**
 * Review 9A-2 S7 — pemakaian cache modul Email (byte) untuk kuota: berkas tersimpan
 * (`mail_attachments.storage_key is not null`: lampiran + gambar inline) + isi (`mail_message_bodies`,
 * ukuran TERSIMPAN `pg_column_size` — tidak membuka TOAST). Dipakai worker (sebelum menyimpan) dan api
 * (sebelum mengantre unduhan lampiran) supaya keduanya memakai angka yang sama.
 */
export interface MailCacheUsage {
  organizationFiles: number;
  organizationBodies: number;
  accountFiles: number;
  accountBodies: number;
  /** Berkas tersimpan email `messageId` (0 bila tidak diminta). */
  messageFiles: number;
}

const bodySize = sql.raw(
  'coalesce(pg_column_size(b.text), 0) + coalesce(pg_column_size(b.html_sanitized), 0) + coalesce(pg_column_size(b.raw_headers), 0)',
);

export async function mailCacheUsage(
  db: DbExecutor,
  scope: { organizationId: string; accountId: string; messageId?: string | null },
): Promise<MailCacheUsage> {
  const messageId = scope.messageId ?? null;
  const result = await db.execute<{
    organization_files: string | null;
    organization_bodies: string | null;
    account_files: string | null;
    account_bodies: string | null;
    message_files: string | null;
  }>(sql`
    select
      (select coalesce(sum(a.size_bytes), 0) from mail_attachments a
        where a.organization_id = ${scope.organizationId} and a.storage_key is not null)
        as organization_files,
      (select coalesce(sum(${bodySize}), 0) from mail_message_bodies b
        where b.organization_id = ${scope.organizationId}) as organization_bodies,
      (select coalesce(sum(a.size_bytes), 0) from mail_attachments a
        join mail_messages m on m.organization_id = a.organization_id and m.id = a.message_id
        where a.organization_id = ${scope.organizationId} and a.storage_key is not null
          and m.account_id = ${scope.accountId}) as account_files,
      (select coalesce(sum(${bodySize}), 0) from mail_message_bodies b
        join mail_messages m on m.organization_id = b.organization_id and m.id = b.message_id
        where b.organization_id = ${scope.organizationId} and m.account_id = ${scope.accountId})
        as account_bodies,
      (select coalesce(sum(a.size_bytes), 0) from mail_attachments a
        where a.organization_id = ${scope.organizationId} and a.storage_key is not null
          and a.message_id = ${messageId}::uuid) as message_files`);
  const row = result.rows[0];
  const n = (value: string | null | undefined) => Number(value ?? 0);
  return {
    organizationFiles: n(row?.organization_files),
    organizationBodies: n(row?.organization_bodies),
    accountFiles: n(row?.account_files),
    accountBodies: n(row?.account_bodies),
    messageFiles: n(row?.message_files),
  };
}

/**
 * Ruang yang masih boleh dipakai berkas baru (byte, ≥ 0) di bawah kuota akun, organisasi, dan per
 * email. Isi (`bodies`) ikut dihitung.
 */
export function mailCacheRoom(
  usage: MailCacheUsage,
  limits: { account: number; organization: number; message: number },
): number {
  return Math.max(
    0,
    Math.min(
      limits.account - usage.accountFiles - usage.accountBodies,
      limits.organization - usage.organizationFiles - usage.organizationBodies,
      limits.message - usage.messageFiles,
    ),
  );
}
