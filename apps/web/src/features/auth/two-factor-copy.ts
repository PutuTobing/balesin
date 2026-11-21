import type { TwoFactorMethod } from '@balesin/shared';
import { t } from '../../i18n/id';

const copy = t.twoFactor.login;

/** Judul + subjudul halaman masuk untuk langkah kode. */
export function twoFactorLoginCopy(method: TwoFactorMethod, email: string) {
  return method === 'totp'
    ? { title: copy.totpTitle, subtitle: copy.totpSubtitle(email) }
    : { title: copy.backupTitle, subtitle: copy.backupSubtitle(email) };
}
