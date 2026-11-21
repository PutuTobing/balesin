import { AppError } from '@balesin/core';
import type { IdentityConfirmation } from '@balesin/shared';

import type { AuthContext } from '../auth/session.service';
import type { TwoFactorContext, TwoFactorService } from './two-factor.service';

/**
 * Konfirmasi ulang identitas yang WAJIB untuk sebuah aksi (password + kode 2FA pelaku), dengan
 * kesalahan per isian di bawah `confirmation.` (bentuk body `{ …, confirmation: {password, code} }`):
 *  - tidak dikirim → 400 `confirmation.password` dengan `requiredMessage`;
 *  - salah → 400 `confirmation.password` / `confirmation.code`; 429 setelah 5 salah (ember yang
 *    sama dengan halaman Keamanan akun).
 */
export async function requireIdentityConfirmation(
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>,
  auth: AuthContext,
  confirmation: IdentityConfirmation | null | undefined,
  action: string,
  context: TwoFactorContext,
  requiredMessage: string,
): Promise<void> {
  if (!confirmation) {
    throw new AppError('VALIDATION_ERROR', {
      message: requiredMessage,
      details: [{ location: 'body', field: 'confirmation.password', message: requiredMessage }],
    });
  }
  try {
    await twoFactor.confirmIdentity(auth, confirmation, action, context);
  } catch (error) {
    if (!(error instanceof AppError) || !error.details) throw error;
    throw new AppError(error.code, {
      message: error.message,
      statusCode: error.statusCode,
      details: error.details.map((detail) => ({
        ...detail,
        field: `confirmation.${detail.field}`,
      })),
      retryAfterSeconds: error.retryAfterSeconds,
      cause: error.cause,
    });
  }
}
