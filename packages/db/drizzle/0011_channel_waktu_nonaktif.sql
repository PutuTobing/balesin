-- `channels.disabled_at`: kapan channel dinonaktifkan (UI "dinonaktifkan sejak …"); `null` saat aktif.
ALTER TABLE "channels" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
-- Isi awal untuk channel yang SUDAH nonaktif: waktu pastinya tidak tercatat, jadi dipakai perubahan
-- terakhir baris (paling mendekati; sama dengan waktu dinonaktifkan bila sesudahnya tidak diubah).
UPDATE "channels" SET "disabled_at" = "updated_at" WHERE "enabled" = false AND "disabled_at" IS NULL;
