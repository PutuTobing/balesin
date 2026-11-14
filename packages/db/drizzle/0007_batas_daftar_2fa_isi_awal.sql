-- Isi awal `users.two_factor_enrollment_due_at` (review undangan R3, Fase 1 butir 6).
-- Migrasi khusus (`drizzle-kit generate --custom`): pembaruan data, bukan perubahan skema.
--
-- Admin/Supervisor yang sudah ada dan BELUM mendaftar 2FA (akun hasil undangan sebelum butir 6)
-- diberi batas 72 jam sejak akunnya dibuat — sama dengan aturan untuk akun baru. Owner sengaja
-- tidak diberi batas: satu-satunya jalan membuat Owner adalah wizard setup, dan Owner itu tidak
-- boleh terkunci dari instalasinya sendiri (docs/DECISIONS.md, 2026-11-14).
UPDATE "users"
SET "two_factor_enrollment_due_at" = "created_at" + interval '72 hours'
WHERE "role" IN ('admin', 'supervisor')
  AND "totp_enabled_at" IS NULL
  AND "two_factor_enrollment_due_at" IS NULL;
