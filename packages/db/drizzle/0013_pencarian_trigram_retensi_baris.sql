-- Review kontak R3: pencarian inbox `ILIKE '%…%'` pada nama/nama profil/username/nomor kontak memakai
-- indeks trigram. `pg_trgm` adalah ekstensi bawaan Postgres (contrib, termasuk image postgres:16-alpine)
-- dan "trusted" sejak PG 13 — pemilik database boleh membuatnya tanpa superuser. `IF NOT EXISTS`: aman
-- bila ekstensinya sudah dipasang (mis. oleh admin database).
-- Review kontak R5: indeks `received_at` untuk penghapusan baris `webhook_events` lama.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_profile_name_trgm_idx" ON "contacts" USING gin ("profile_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_wa_username_trgm_idx" ON "contacts" USING gin ("wa_username" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_trgm_idx" ON "contacts" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");