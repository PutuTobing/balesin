/**
 * `node dist/reset-owner-password.js [email]` — dipanggil `balesin reset-owner-password` di
 * server (lihat docs/DEPLOY.md). Password baru dibaca dari STDIN (baris pertama), bukan dari
 * argumen/variabel lingkungan, supaya tidak terlihat di daftar proses atau `docker inspect`.
 *
 * Konfirmasi ("ketik RESET") dilakukan skrip `balesin` sebelum memanggil ini.
 * Kode keluar: 0 berhasil, 1 gagal (pesan bahasa Indonesia), 2 pemakaian salah.
 */
import { closeRedis, createRedis, createLogger, scrubSecretsInText } from '@balesin/core';
import { closeDb, createDb } from '@balesin/db';

import { createPasswordHasher } from '../modules/auth/password-hasher';
import { OwnerRecoveryError, resetOwnerPassword } from './owner-recovery';

async function readFirstLine(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    // Password maks. beberapa ratus karakter; selebihnya pasti salah pakai.
    if (size > 4096) break;
    chunks.push(buffer);
  }
  const [line = ''] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return line;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) {
    process.stderr.write('Pemakaian: reset-owner-password [email-owner]  (password dari stdin)\n');
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL belum diisi.\n');
    return 1;
  }

  const password = await readFirstLine();
  if (!password) {
    process.stderr.write('Password baru kosong. Kirim lewat stdin (baris pertama).\n');
    return 2;
  }

  const db = createDb(databaseUrl, { applicationName: 'balesin-cli', maxConnections: 1 });
  const redisUrl = process.env.REDIS_URL?.trim();
  const redis = redisUrl
    ? createRedis(redisUrl, {
        role: 'client',
        name: 'balesin-cli',
        logger: createLogger({ service: 'cli', level: 'error' }),
      })
    : undefined;

  try {
    const result = await resetOwnerPassword(
      { db, hasher: createPasswordHasher({ concurrency: 1 }), redis },
      { email: args[0], password },
    );
    process.stdout.write(
      [
        `Password Owner ${result.maskedEmail} sudah diganti.`,
        `Sesi yang dicabut: ${String(result.revokedSessions)}. Tercatat di audit log.`,
        result.twoFactorEnabled
          ? 'Verifikasi dua langkah (2FA) tetap aktif: saat masuk, pakai kode dari aplikasi autentikator atau kode cadangan.'
          : 'Owner belum mengaktifkan 2FA: aplikasi akan meminta pendaftaran 2FA setelah masuk.',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (error instanceof OwnerRecoveryError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : 'galat tidak dikenal';
    process.stderr.write(`Gagal mengganti password Owner: ${scrubSecretsInText(message)}\n`);
    return 1;
  } finally {
    await closeDb(db);
    if (redis) await closeRedis(redis).catch(() => undefined);
  }
}

process.exitCode = await main();
