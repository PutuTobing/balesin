import { hmacSha256, type Redis } from '@balesin/core';
import {
  emailTestCodeSchema,
  type EmailSettingsInput,
  type EmailTestResult,
} from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

/**
 * Ingatan singkat hasil tes email di wizard setup.
 *
 * Selama wizard berjalan belum ada organisasi, jadi hasil "Tes koneksi" / "Kirim email tes"
 * belum bisa dicatat di `email_settings`. Supaya halaman Pengaturan → Email pengirim langsung
 * menampilkan status dan waktu tes terakhir setelah setup, hasil tes terakhir disimpan
 * sementara di Redis dan dipakai `POST /setup/complete` bila pengaturan yang disimpan SAMA
 * PERSIS dengan yang dites (host, port, keamanan, username, password).
 *
 * Kunci Redis = HMAC dari isian sambungan dengan kunci server — password tidak pernah ada di
 * Redis dalam bentuk apa pun yang bisa dibalik atau ditebak tanpa kunci itu. Nilainya hanya
 * kode hasil dan waktu (bukan rahasia). Kegagalan Redis tidak pernah menggagalkan wizard:
 * paling buruk status tampil "Belum dites".
 */

const TTL_SECONDS = 2 * 60 * 60;

const storedResultSchema = z.object({
  ok: z.boolean(),
  code: emailTestCodeSchema,
  testedAt: z.iso.datetime(),
});

export interface RememberedEmailTest {
  ok: boolean;
  code: EmailTestResult['code'];
  testedAt: Date;
}

export interface SetupEmailTestMemo {
  remember(
    settings: EmailSettingsInput,
    result: EmailTestResult,
    log: FastifyBaseLogger,
  ): Promise<void>;
  recall(
    settings: EmailSettingsInput,
    log: FastifyBaseLogger,
  ): Promise<RememberedEmailTest | undefined>;
}

export interface SetupEmailTestMemoOptions {
  redis: Redis;
  /** Awalan kunci Redis (sama dengan awalan batas laju supaya tes bisa membersihkannya). */
  keyPrefix: string;
  /** Kunci HMAC turunan rahasia server. */
  fingerprintKey: Buffer;
}

export function createSetupEmailTestMemo(options: SetupEmailTestMemoOptions): SetupEmailTestMemo {
  const { redis, keyPrefix, fingerprintKey } = options;

  const keyFor = (settings: EmailSettingsInput): string =>
    `${keyPrefix}:setup-email-test:${hmacSha256(
      fingerprintKey,
      JSON.stringify([
        settings.host,
        settings.port,
        settings.security,
        settings.username ?? null,
        settings.password ?? null,
      ]),
    )}`;

  return {
    async remember(settings, result, log) {
      // Alamat tujuan email tes yang salah bukan kesalahan pengaturan (sama dengan Pengaturan).
      if (result.code === 'recipient_rejected') return;
      try {
        await redis.set(
          keyFor(settings),
          JSON.stringify({ ok: result.ok, code: result.code, testedAt: result.testedAt }),
          'EX',
          TTL_SECONDS,
        );
      } catch (err) {
        log.warn({ err }, 'Hasil tes email di wizard setup tidak bisa diingat');
      }
    },

    async recall(settings, log) {
      try {
        const raw = await redis.get(keyFor(settings));
        if (raw === null) return undefined;
        const parsed = storedResultSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return undefined;
        return { ...parsed.data, testedAt: new Date(parsed.data.testedAt) };
      } catch (err) {
        log.warn({ err }, 'Hasil tes email di wizard setup tidak bisa dibaca');
        return undefined;
      }
    },
  };
}
