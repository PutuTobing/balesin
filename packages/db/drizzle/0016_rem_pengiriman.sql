-- Review ruang chat: batas kirim harian/per percakapan + rem darurat (S2), klaim kirim (R3), pengirim
-- ulang terpisah dari penulis (R2), indeks hitungan pesan keluar 24 jam.
ALTER TABLE "messages" ADD COLUMN "send_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "last_sent_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "send_daily_limit_per_user" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "send_daily_limit_per_organization" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "send_per_conversation_per_minute" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sending_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sending_paused_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sending_pause_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_last_sent_by_user_id_fk" FOREIGN KEY ("organization_id","last_sent_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_outbound_created_at_idx" ON "messages" USING btree ("organization_id","created_at") WHERE "messages"."direction" = 'outbound';--> statement-breakpoint
CREATE INDEX "messages_outbound_sender_created_at_idx" ON "messages" USING btree ("organization_id","sender_user_id","created_at") WHERE "messages"."direction" = 'outbound';--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_send_limits_range" CHECK ("organizations"."send_daily_limit_per_user" between 1 and 100000 and "organizations"."send_daily_limit_per_organization" between 1 and 1000000 and "organizations"."send_per_conversation_per_minute" between 1 and 120);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_sending_pause_consistent" CHECK (("organizations"."sending_paused_at" is not null or ("organizations"."sending_paused_by_user_id" is null and "organizations"."sending_pause_reason" is null)) and ("organizations"."sending_pause_reason" is null or char_length("organizations"."sending_pause_reason") <= 200));