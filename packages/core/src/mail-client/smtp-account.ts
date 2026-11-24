import type { MailOutgoingTestCode } from '@balesin/shared';

import { verifySmtpConnection, type SmtpPolicy, type SmtpResult } from '../mail/smtp';
import type { Secret } from '../secret';

/**
 * Tes Keluar akun Email (Fase 9, KONTRAK-API-EMAIL §4.2): `verifySmtpConnection` (sambung + TLS +
 * login, TANPA mengirim) lalu kode Fase 1 → kode `smtp_*` akun Email. Sebab khusus Microsoft 365 /
 * sandi aplikasi dikenali dari `diagnostic.hint` (teks balasan tidak pernah diteruskan).
 */

export interface MailSmtpConfig {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
  username: string;
  password: Secret<string>;
}

export type MailSmtpVerifier = (config: MailSmtpConfig, policy: SmtpPolicy) => Promise<SmtpResult>;

export const defaultMailSmtpVerifier: MailSmtpVerifier = (config, policy) =>
  verifySmtpConnection(
    {
      host: config.host,
      port: config.port,
      security: config.security,
      username: config.username,
      password: config.password,
    },
    policy,
  );

export function mailOutgoingCodeOf(result: SmtpResult): MailOutgoingTestCode {
  if (result.ok) return 'ok';
  if (result.diagnostic.hint === 'm365_auth_disabled') return 'smtp_auth_disabled_m365';
  if (result.diagnostic.hint === 'app_password_required') return 'smtp_app_password_required';
  switch (result.code) {
    case 'host_not_found':
      return 'smtp_host_not_found';
    case 'host_blocked':
      return 'smtp_host_blocked';
    case 'port_not_allowed':
      return 'smtp_port_not_allowed';
    case 'connection_refused':
      return 'smtp_connection_refused';
    case 'connection_timeout':
      return 'smtp_connection_timeout';
    case 'tls_failed':
      return 'smtp_tls_failed';
    case 'certificate_invalid':
      return 'smtp_certificate_invalid';
    case 'auth_failed':
      return 'smtp_auth_failed';
    case 'auth_unsupported':
      return 'smtp_auth_unsupported';
    default:
      return 'unknown';
  }
}

export async function testMailOutgoing(
  config: MailSmtpConfig,
  policy: SmtpPolicy,
  verifier: MailSmtpVerifier = defaultMailSmtpVerifier,
): Promise<{ ok: boolean; code: MailOutgoingTestCode; durationMs: number }> {
  const started = Date.now();
  const result = await verifier(config, policy);
  const code = mailOutgoingCodeOf(result);
  return { ok: code === 'ok', code, durationMs: Date.now() - started };
}
