import {
  accountTokenDeliveryContext,
  invitationDeliveryContext,
  randomToken,
  sha256Hex,
  type SecretBox,
  type SmtpFallbackConfig,
} from '@balesin/core';
import { emailSettings, type DbExecutor } from '@balesin/db';
import { eq } from 'drizzle-orm';

import type { RateLimitRule } from '../../http/rate-limit';

/**
 * Token sekali pakai di tautan email (undangan, atur ulang password, verifikasi email) —
 * SECURITY.md §1:
 *  - 256-bit acak (`randomToken(32)`, base64url 43 karakter); database hanya menyimpan SHA-256;
 *  - token TIDAK PERNAH masuk payload antrian, log, atau audit. Supaya worker bisa menaruhnya
 *    di email, api menyimpan salinan TERENKRIPSI (`SecretBox`, AES-256-GCM, AAD terikat baris)
 *    yang dihapus worker begitu email terkirim/gagal permanen.
 */

export interface IssuedLinkToken {
  /** Token mentah — hanya untuk tautan (email, atau ditampilkan sekali ke pembuat undangan). */
  token: string;
  tokenHash: string;
}

export function issueLinkToken(): IssuedLinkToken {
  const token = randomToken(32);
  return { token, tokenHash: sha256Hex(token) };
}

/** Hash token dari tautan untuk dicari di database. */
export function hashLinkToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Percobaan token tautan yang TIDAK berlaku per IP, untuk semua rute publik bertoken (undangan,
 * atur ulang password, verifikasi). Tokennya 256-bit — tebakan mustahil — jadi ini hanya
 * menahan pemindaian/beban; token yang sah mengembalikan jatahnya.
 */
export const PUBLIC_TOKEN_IP_RULE: RateLimitRule = {
  name: 'tautan-ip',
  limit: 30,
  windowSeconds: 15 * 60,
};

export const PUBLIC_TOKEN_RATE_MESSAGE = 'Terlalu banyak percobaan membuka tautan dari jaringanmu.';

export interface TokenDelivery {
  /**
   * Email bertoken bisa dikirim: email pengirim diatur (Pengaturan → Email pengirim, atau cadangan
   * `SMTP_*` di .env) DAN token bisa disegel untuk worker (`BALESIN_MASTER_KEY` terisi).
   */
  emailAvailable(executor: DbExecutor, organizationId: string): Promise<boolean>;
  sealInvitationToken(
    organizationId: string,
    invitationId: string,
    sendCount: number,
    token: string,
  ): string;
  sealAccountToken(organizationId: string, tokenId: string, token: string): string;
}

export function createTokenDelivery(deps: {
  secretBox: SecretBox | null;
  fallback: SmtpFallbackConfig | null;
}): TokenDelivery {
  const { secretBox, fallback } = deps;
  function box(): SecretBox {
    // `emailAvailable` sudah `false` tanpa master key; pemanggil tidak sampai ke sini.
    if (!secretBox) throw new Error('BALESIN_MASTER_KEY kosong: token tidak bisa disegel');
    return secretBox;
  }
  return {
    async emailAvailable(executor, organizationId) {
      if (!secretBox) return false;
      if (fallback) return true;
      const [row] = await executor
        .select({ id: emailSettings.id })
        .from(emailSettings)
        .where(eq(emailSettings.organizationId, organizationId))
        .limit(1);
      return row !== undefined;
    },
    sealInvitationToken: (organizationId, invitationId, sendCount, token) =>
      box().encrypt(token, invitationDeliveryContext(organizationId, invitationId, sendCount)),
    sealAccountToken: (organizationId, tokenId, token) =>
      box().encrypt(token, accountTokenDeliveryContext(organizationId, tokenId)),
  };
}
