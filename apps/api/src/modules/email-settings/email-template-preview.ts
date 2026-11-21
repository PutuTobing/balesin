import {
  renderAccountLockedEmail,
  renderAdminTwoFactorNoticeEmail,
  renderEmailVerificationEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderSecurityNoticeEmail,
  type EmailBrand,
  type EventOrigin,
} from '@balesin/core';
import { organizationLogos, organizations, type DbExecutor } from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  EMAIL_VERIFICATION_VALID_HOURS,
  INVITATION_VALID_HOURS,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  PASSWORD_RESET_VALID_MINUTES,
  buildTokenLink,
  type EmailTemplateId,
  type EmailTemplatePreviewResponse,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';

import type { AuthContext } from '../auth/session.service';

/**
 * Pratinjau template email (docs/PENGATURAN-UI.md §1). Dirender dengan template yang SAMA dengan
 * yang dipakai worker, branding organisasi sungguhan (logo sebagai `data:` URI supaya tampil di
 * browser), dan data contoh — tanpa token sungguhan dan tanpa mengirim apa pun.
 */

/** Token contoh yang jelas bukan token asli (tautan pratinjau tidak bisa dipakai). */
const SAMPLE_TOKEN = 'CONTOH-TAUTAN-PRATINJAU';
const SAMPLE_ORIGIN: EventOrigin = {
  ip: '203.0.113.10',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

async function previewBrand(
  db: DbExecutor,
  organizationId: string,
): Promise<{ brand: EmailBrand; timeZone: string }> {
  const [row] = await db
    .select({
      name: organizations.name,
      productName: organizations.productName,
      brandColor: organizations.brandColor,
      timezone: organizations.timezone,
      logoType: organizationLogos.contentType,
      logoData: organizationLogos.data,
    })
    .from(organizations)
    .leftJoin(organizationLogos, eq(organizationLogos.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!row) throw new Error('Organisasi tidak ditemukan');
  // Email sungguhan hanya menyertakan PNG/JPEG (WebP tidak tampil di sebagian aplikasi email).
  const emailLogo =
    row.logoData && (row.logoType === 'image/png' || row.logoType === 'image/jpeg')
      ? `data:${row.logoType};base64,${row.logoData.toString('base64')}`
      : null;
  return {
    brand: {
      productName: row.productName ?? DEFAULT_PRODUCT_NAME,
      organizationName: row.name,
      logoSrc: emailLogo,
      primaryColor: row.brandColor,
    },
    timeZone: row.timezone,
  };
}

export interface EmailTemplatePreview {
  render(auth: AuthContext, template: EmailTemplateId): Promise<EmailTemplatePreviewResponse>;
}

export function createEmailTemplatePreview(deps: {
  db: DbExecutor;
  appUrl: string;
}): EmailTemplatePreview {
  return {
    async render(auth, template) {
      const { brand, timeZone } = await previewBrand(deps.db, auth.organizationId);
      const now = new Date();
      const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
      const user = auth.user;
      const body = (() => {
        switch (template) {
          case 'invitation':
            return renderInvitationEmail({
              brand,
              timeZone,
              inviterName: user.name,
              role: 'cs',
              email: 'nama.anggota@contoh.co.id',
              link: buildTokenLink(deps.appUrl, 'invitation', SAMPLE_TOKEN),
              expiresAt: minutesFromNow(INVITATION_VALID_HOURS * 60),
              twoFactorRequired: false,
            });
          case 'password_reset':
            return renderPasswordResetEmail({
              brand,
              timeZone,
              userName: user.name,
              email: user.email,
              link: buildTokenLink(deps.appUrl, 'passwordReset', SAMPLE_TOKEN),
              expiresAt: minutesFromNow(PASSWORD_RESET_VALID_MINUTES),
              requestedAt: now,
              origin: SAMPLE_ORIGIN,
              twoFactorEnabled: true,
            });
          case 'email_verification':
            return renderEmailVerificationEmail({
              brand,
              timeZone,
              userName: user.name,
              email: user.email,
              link: buildTokenLink(deps.appUrl, 'emailVerification', SAMPLE_TOKEN),
              expiresAt: minutesFromNow(EMAIL_VERIFICATION_VALID_HOURS * 60),
            });
          case 'password_changed':
          case 'two_factor_enabled':
            return renderSecurityNoticeEmail({
              brand,
              userName: user.name,
              event: template,
              occurredAt: now,
              timeZone,
              origin: SAMPLE_ORIGIN,
            });
          case 'two_factor_enabled_admin':
            return renderAdminTwoFactorNoticeEmail({
              brand,
              timeZone,
              recipientName: user.name,
              subject: { name: 'Nama Anggota', email: 'nama.anggota@contoh.co.id', role: 'admin' },
              occurredAt: now,
              origin: SAMPLE_ORIGIN,
            });
          case 'account_locked':
            return renderAccountLockedEmail({
              brand,
              userName: user.name,
              failedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
              lockMinutes: LOGIN_LOCK_MINUTES,
              lockedUntil: minutesFromNow(LOGIN_LOCK_MINUTES),
              timeZone,
              scope: 'source',
            });
        }
      })();
      return { template, subject: body.subject, text: body.text, html: body.html ?? '' };
    },
  };
}
