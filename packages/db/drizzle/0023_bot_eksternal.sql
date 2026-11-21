-- Fase 3: bot eksternal — saklar bot per channel (jam kerja bot, batas waktu), penanda pesan pelanggan
-- yang menunggu balasan bot, kejadian handoff/kembali ke bot, webhook keluar "hanya saat bot".
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'handoff';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'bot_resumed';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "bot_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "bot_hours" jsonb DEFAULT '{"mode":"always"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "bot_timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "bot_settings_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "bot_awaiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "bot_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_bot_awaiting_idx" ON "conversations" USING btree ("bot_awaiting_since") WHERE "conversations"."status" = 'bot' and "conversations"."bot_awaiting_since" is not null;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_timeout_range" CHECK ("channels"."bot_timeout_minutes" is null or "channels"."bot_timeout_minutes" between 1 and 1440);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bot_awaiting_only_bot" CHECK ("conversations"."status" = 'bot' or "conversations"."bot_awaiting_since" is null);