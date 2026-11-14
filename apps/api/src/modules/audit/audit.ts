import { isIP } from 'node:net';

import { redactSecrets } from '@balesin/core';
import { auditLogs, type DbExecutor } from '@balesin/db';

import { USER_AGENT_MAX_LENGTH, type ClientInfo } from '../../http/client-info';

/**
 * Satu-satunya pintu untuk menulis audit log (PRD §3.1, catatan F.16 review Fase 0).
 *
 * - `metadata` selalu disaring `redactSecrets`: nilai dari kunci berbau rahasia (password,
 *   token, secret, …) diganti penanda, sedalam apa pun letaknya. Jangan mengandalkan ini —
 *   pemanggil tetap tidak boleh memasukkan rahasia.
 * - IP divalidasi dan user agent dipotong sebelum disimpan.
 * - Tabelnya hanya-tambah di tingkat database (trigger), jadi tidak ada fungsi ubah/hapus.
 */

/** Nama aksi bertitik. Tambahkan di sini setiap ada aksi baru supaya daftarnya satu tempat. */
export const AUDIT_ACTIONS = {
  setupCompleted: 'setup.completed',
  loginSucceeded: 'auth.login.success',
  loginFailed: 'auth.login.failed',
  accountLocked: 'auth.account.locked',
  logout: 'auth.logout',
  twoFactorChallengeIssued: 'auth.2fa.challenge_issued',
  twoFactorFailed: 'auth.2fa.failed',
  twoFactorEnrollmentStarted: 'auth.2fa.enrollment_started',
  twoFactorEnabled: 'auth.2fa.enabled',
  twoFactorDisabled: 'auth.2fa.disabled',
  twoFactorBackupCodesRegenerated: 'auth.2fa.backup_codes_regenerated',
  twoFactorBackupCodeUsed: 'auth.2fa.backup_code_used',
  emailSettingsUpdated: 'settings.email.updated',
  emailSettingsTested: 'settings.email.tested',
  invitationCreated: 'user.invitation.created',
  invitationResent: 'user.invitation.resent',
  invitationRevoked: 'user.invitation.revoked',
  invitationAccepted: 'user.invitation.accepted',
  /** Tautan undangan ditampilkan ke pembuatnya untuk disalin manual (email pengirim belum diatur). */
  invitationLinkShown: 'user.invitation.link_shown',
  /** Tautan undangan yang tidak berlaku dicoba dibuka/diterima. */
  invitationRejected: 'user.invitation.rejected',
  passwordResetRequested: 'auth.password_reset.requested',
  passwordResetCompleted: 'auth.password_reset.completed',
  passwordResetFailed: 'auth.password_reset.failed',
  emailVerificationSent: 'auth.email.verification_sent',
  emailVerified: 'auth.email.verified',
  emailVerificationFailed: 'auth.email.verification_failed',
  /** Permintaan ditolak 403 karena peran tidak punya izinnya (dibatasi, lihat `access-denied.ts`). */
  accessDenied: 'auth.access.denied',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  organizationId: string;
  /** `null` untuk aksi tanpa pelaku yang dikenal (mis. login gagal). */
  actorUserId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  /** Tanpa rahasia. */
  metadata?: Record<string, unknown>;
  client: ClientInfo;
}

/** Menulis satu baris audit. Mengembalikan ID barisnya (dirujuk job email keamanan untuk IP/perangkat). */
export async function recordAudit(db: DbExecutor, entry: AuditEntry): Promise<string> {
  const [row] = await db
    .insert(auditLogs)
    .values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: redactSecrets(entry.metadata ?? {}) as Record<string, unknown>,
      ipAddress: entry.client.ip !== null && isIP(entry.client.ip) !== 0 ? entry.client.ip : null,
      userAgent: entry.client.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
    })
    .returning({ id: auditLogs.id });
  if (!row) throw new Error('Audit log tidak tersimpan');
  return row.id;
}

/** `budi.santoso@contoh.co.id` → `b***@contoh.co.id`: cukup untuk mengenali, tanpa menyimpan utuh. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`.slice(0, 120);
}
