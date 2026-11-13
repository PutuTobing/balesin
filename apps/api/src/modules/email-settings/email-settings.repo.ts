import { emailSettings, type DbExecutor, type EmailSettings } from '@balesin/db';
import type { EmailTestCode, SmtpSecurity } from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';

/** Pengaturan email pengirim milik satu organisasi (paling banyak satu baris). */
export async function findEmailSettings(
  db: DbExecutor,
  organizationId: string,
): Promise<EmailSettings | undefined> {
  const [row] = await db
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  return row;
}

export interface EmailSettingsValues {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  /** Hasil `SecretBox.encrypt` — TIDAK PERNAH password polos. */
  passwordEncrypted: string | null;
  passwordTail: string | null;
}

/**
 * Menyimpan pengaturan (buat baru atau timpa). `resetTestResult` mengosongkan hasil tes
 * terakhir — wajib `true` bila host/port/keamanan/username/password berubah, karena hasil tes
 * lama tidak lagi menggambarkan pengaturan yang tersimpan.
 */
export async function upsertEmailSettings(
  db: DbExecutor,
  organizationId: string,
  values: EmailSettingsValues,
  options: { updatedByUserId: string; resetTestResult: boolean },
): Promise<EmailSettings> {
  const testReset = options.resetTestResult
    ? { lastTestOk: null, lastTestCode: null, lastTestedAt: null }
    : {};
  const [row] = await db
    .insert(emailSettings)
    .values({ organizationId, ...values, updatedByUserId: options.updatedByUserId })
    .onConflictDoUpdate({
      target: emailSettings.organizationId,
      set: {
        ...values,
        ...testReset,
        updatedByUserId: options.updatedByUserId,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error('Pengaturan email tidak tersimpan');
  return row;
}

/** Mencatat hasil tes atas pengaturan yang TERSIMPAN. Mengembalikan waktu tes menurut database. */
export async function recordEmailTestResult(
  db: DbExecutor,
  organizationId: string,
  result: { ok: boolean; code: EmailTestCode },
): Promise<Date | undefined> {
  const [row] = await db
    .update(emailSettings)
    .set({ lastTestOk: result.ok, lastTestCode: result.code, lastTestedAt: sql`now()` })
    .where(eq(emailSettings.organizationId, organizationId))
    .returning({ lastTestedAt: emailSettings.lastTestedAt });
  return row?.lastTestedAt ?? undefined;
}
