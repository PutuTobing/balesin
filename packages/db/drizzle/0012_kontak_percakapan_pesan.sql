-- Fase 2 butir 4: kontak, percakapan (sesi kontak × channel, jendela 24 jam), pesan; retensi payload
-- `webhook_events` (review webhook S4) + kaitan kejadian → kontak untuk hapus per kontak (UU PDP).
CREATE TYPE "public"."conversation_status" AS ENUM('bot', 'unserved', 'served', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'played', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_sender_kind" AS ENUM('customer', 'agent', 'bot', 'broadcast', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts', 'interactive', 'reaction', 'system', 'unsupported');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "contacts_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_type" "channel_type" NOT NULL,
	"wa_bsuid" text,
	"phone" text,
	"wa_username" text,
	"profile_name" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contacts_number_unique" UNIQUE("number"),
	CONSTRAINT "contacts_whatsapp_identity_required" CHECK ("contacts"."channel_type" <> 'whatsapp' or "contacts"."wa_bsuid" is not null or "contacts"."phone" is not null),
	CONSTRAINT "contacts_phone_e164" CHECK ("contacts"."phone" is null or "contacts"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "contacts_wa_bsuid_format" CHECK ("contacts"."wa_bsuid" is null or ("contacts"."wa_bsuid" ~ '^[A-Za-z0-9._:-]+$' and char_length("contacts"."wa_bsuid") <= 256)),
	CONSTRAINT "contacts_text_lengths" CHECK (("contacts"."name" is null or char_length("contacts"."name") between 1 and 256) and ("contacts"."profile_name" is null or char_length("contacts"."profile_name") between 1 and 256) and ("contacts"."wa_username" is null or char_length("contacts"."wa_username") between 1 and 256))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "conversations_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "conversation_status" NOT NULL,
	"assignee_user_id" uuid,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "conversations_number_unique" UNIQUE("number"),
	CONSTRAINT "conversations_unread_count_nonnegative" CHECK ("conversations"."unread_count" >= 0),
	CONSTRAINT "conversations_window_matches_inbound" CHECK (("conversations"."last_inbound_at" is null) = ("conversations"."window_expires_at" is null)),
	CONSTRAINT "conversations_resolved_at_matches_status" CHECK (("conversations"."status" = 'resolved') = ("conversations"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender_kind" "message_sender_kind" NOT NULL,
	"sender_user_id" uuid,
	"type" "message_type" NOT NULL,
	"raw_type" text,
	"wamid" text,
	"text" text,
	"media" jsonb,
	"location" jsonb,
	"extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reply_to_wamid" text,
	"reply_to_message_id" uuid,
	"reaction_emoji" text,
	"reaction_to_wamid" text,
	"reaction_to_message_id" uuid,
	"status" "message_delivery_status",
	"status_updated_at" timestamp with time zone,
	"error_code" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "messages_number_unique" UNIQUE("number"),
	CONSTRAINT "messages_inbound_has_no_status" CHECK ("messages"."direction" <> 'inbound' or ("messages"."status" is null and "messages"."sender_kind" = 'customer')),
	CONSTRAINT "messages_outbound_has_status" CHECK ("messages"."direction" <> 'outbound' or "messages"."status" is not null),
	CONSTRAINT "messages_wamid_length" CHECK (("messages"."wamid" is null or char_length("messages"."wamid") between 1 and 256) and ("messages"."reply_to_wamid" is null or char_length("messages"."reply_to_wamid") between 1 and 256) and ("messages"."reaction_to_wamid" is null or char_length("messages"."reaction_to_wamid") between 1 and 256)),
	CONSTRAINT "messages_text_length" CHECK ("messages"."text" is null or char_length("messages"."text") <= 65536),
	CONSTRAINT "messages_raw_type_format" CHECK ("messages"."raw_type" is null or "messages"."raw_type" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "messages_reaction_emoji_length" CHECK ("messages"."reaction_emoji" is null or char_length("messages"."reaction_emoji") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "webhook_payload_retention_days" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "payload_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_assignee_user_id_fk" FOREIGN KEY ("organization_id","assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reaction_to_message_id_messages_id_fk" FOREIGN KEY ("reaction_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_sender_user_id_fk" FOREIGN KEY ("organization_id","sender_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_id_channel_type_wa_bsuid_unique" ON "contacts" USING btree ("organization_id","channel_type","wa_bsuid") WHERE "contacts"."wa_bsuid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_id_channel_type_phone_unique" ON "contacts" USING btree ("organization_id","channel_type","phone") WHERE "contacts"."phone" is not null;--> statement-breakpoint
CREATE INDEX "contacts_organization_id_created_at_idx" ON "contacts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_contact_channel_unique" ON "conversations" USING btree ("organization_id","contact_id","channel_id") WHERE "conversations"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "conversations_organization_id_last_message_at_idx" ON "conversations" USING btree ("organization_id","last_message_at","id");--> statement-breakpoint
CREATE INDEX "conversations_organization_id_status_last_message_at_idx" ON "conversations" USING btree ("organization_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_organization_id_assignee_user_id_idx" ON "conversations" USING btree ("organization_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "conversations_organization_id_contact_id_idx" ON "conversations" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_id_wamid_unique" ON "messages" USING btree ("channel_id","wamid");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_occurred_at_idx" ON "messages" USING btree ("conversation_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "messages_organization_id_contact_id_idx" ON "messages" USING btree ("organization_id","contact_id");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_retention_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."payload_purged_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_events_organization_id_contact_id_idx" ON "webhook_events" USING btree ("organization_id","contact_id") WHERE "webhook_events"."contact_id" is not null;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_webhook_payload_retention_days_range" CHECK ("organizations"."webhook_payload_retention_days" between 1 and 90);--> statement-breakpoint
-- S4: kejadian `other` (field selain `messages`) tidak lagi menyimpan isi lengkap — baris lama
-- diganti hash isinya (kunci dedup tetap).
UPDATE "webhook_events" SET "payload" = jsonb_build_object('wabaId', "payload"->'wabaId', 'valueSha256', encode(sha256(convert_to(coalesce("payload"->'value', '{}'::jsonb)::text, 'UTF8')), 'hex')) WHERE "kind" = 'other' AND "payload" ? 'value';
