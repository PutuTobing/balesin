import { t } from '../../i18n/id';
import { AuthRouteSkeleton } from './AuthLayout';

/*
 * Komponen tunggu rute halaman publik (selama kode halamannya dimuat). Kecil dan ikut bundel
 * utama; isi halamannya dimuat terpisah (lazy).
 */

export function ForgotPasswordPending() {
  return <AuthRouteSkeleton documentTitle={t.forgotPassword.title} />;
}

export function InvitationPending() {
  return <AuthRouteSkeleton documentTitle={t.invitation.documentTitle} tall />;
}

export function ResetPasswordPending() {
  return <AuthRouteSkeleton documentTitle={t.resetPassword.title} tall />;
}

export function VerifyEmailPending() {
  return <AuthRouteSkeleton documentTitle={t.verifyEmail.title} />;
}
