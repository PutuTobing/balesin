-- Fase 3: lapisan kompatibel MobiChat — pelaku API key di riwayat penanganan & catatan sesi (bot),
-- webhook keluar format "mobichat" (API key terenkripsi + 4 karakter terakhir + alamat balik).
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_format_known";--> statement-breakpoint
ALTER TABLE "conversation_notes" ALTER COLUMN "author_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "mobichat_base_url" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "mobichat_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "mobichat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "mobichat_api_key_last4" text;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_mobichat_api_key_id_fk" FOREIGN KEY ("organization_id","mobichat_api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_single_actor" CHECK ("conversation_events"."actor_user_id" is null or "conversation_events"."api_key_id" is null);--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_single_author" CHECK (("conversation_notes"."author_user_id" is null) <> ("conversation_notes"."api_key_id" is null));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_mobichat_consistent" CHECK (case when "webhook_endpoints"."format" = 'mobichat' then "webhook_endpoints"."mobichat_api_key_encrypted" is not null and "webhook_endpoints"."mobichat_api_key_id" is not null and "webhook_endpoints"."mobichat_api_key_last4" is not null else "webhook_endpoints"."mobichat_api_key_encrypted" is null and "webhook_endpoints"."mobichat_api_key_id" is null and "webhook_endpoints"."mobichat_api_key_last4" is null and "webhook_endpoints"."mobichat_base_url" is null end);--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_mobichat_base_url_length" CHECK ("webhook_endpoints"."mobichat_base_url" is null or char_length("webhook_endpoints"."mobichat_base_url") between 8 and 2048);--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_format_known" CHECK ("webhook_endpoints"."format" in ('native', 'mobichat'));