CREATE TABLE "email_mailbox_states" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_ok" boolean,
	"last_poll_code" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"skipped_messages" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_mailbox_states_counters" CHECK ("email_mailbox_states"."last_uid" >= 0 and "email_mailbox_states"."consecutive_failures" >= 0 and "email_mailbox_states"."skipped_messages" >= 0 and ("email_mailbox_states"."uid_validity" is null or "email_mailbox_states"."uid_validity" > 0)),
	CONSTRAINT "email_mailbox_states_code_format" CHECK ("email_mailbox_states"."last_poll_code" is null or "email_mailbox_states"."last_poll_code" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "message_email_bodies" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"html" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_email_bodies_html_size" CHECK (octet_length("message_email_bodies"."html") between 1 and 524288)
);
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_deleted_without_secrets";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_window_matches_inbound";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_bot_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_bot_username" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_bot_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_bot_token_tail" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_webhook_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tg_webhook_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_address" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_from_name" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_host" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_port" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_security" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_username" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_password_tail" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_imap_folder" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_poll_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_mark_as_read" boolean;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_mode" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_host" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_port" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_security" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_username" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "email_smtp_password_tail" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_page_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_ig_account_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_page_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_page_token_tail" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_app_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_app_secret_tail" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_verify_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta_verify_token_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "external_user_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "channel_handle" text;--> statement-breakpoint
ALTER TABLE "email_mailbox_states" ADD CONSTRAINT "email_mailbox_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_mailbox_states" ADD CONSTRAINT "email_mailbox_states_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_email_bodies" ADD CONSTRAINT "message_email_bodies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_email_bodies" ADD CONSTRAINT "message_email_bodies_organization_id_message_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_mailbox_states_next_poll_at_idx" ON "email_mailbox_states" USING btree ("next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_organization_id_tg_bot_id_live_unique" ON "channels" USING btree ("organization_id","tg_bot_id") WHERE "channels"."deleted_at" is null and "channels"."type" = 'telegram';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_organization_id_email_address_live_unique" ON "channels" USING btree ("organization_id","email_address") WHERE "channels"."deleted_at" is null and "channels"."type" = 'email';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_organization_id_meta_page_id_live_unique" ON "channels" USING btree ("organization_id","type","meta_page_id") WHERE "channels"."deleted_at" is null and "channels"."type" in ('messenger', 'instagram');--> statement-breakpoint
CREATE INDEX "channels_email_live_idx" ON "channels" USING btree ("id") WHERE "channels"."type" = 'email' and "channels"."deleted_at" is null and "channels"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_id_channel_type_external_user_id_unique" ON "contacts" USING btree ("organization_id","channel_type","external_user_id") WHERE "contacts"."external_user_id" is not null;--> statement-breakpoint
CREATE INDEX "contacts_channel_handle_trgm_idx" ON "contacts" USING gin ("channel_handle" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_telegram_live_complete" CHECK ("channels"."type" <> 'telegram' or "channels"."deleted_at" is not null or ("channels"."tg_bot_id" is not null and "channels"."tg_bot_token_encrypted" is not null and "channels"."tg_webhook_secret_encrypted" is not null));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_email_live_complete" CHECK ("channels"."type" <> 'email' or "channels"."deleted_at" is not null or ("channels"."email_address" is not null and "channels"."email_from_name" is not null and "channels"."email_imap_host" is not null and "channels"."email_imap_port" is not null and "channels"."email_imap_security" is not null and "channels"."email_imap_username" is not null and "channels"."email_imap_password_encrypted" is not null and "channels"."email_imap_folder" is not null and "channels"."email_poll_interval_minutes" is not null and "channels"."email_mark_as_read" is not null and "channels"."email_smtp_mode" is not null and ("channels"."email_smtp_mode" = 'system' or ("channels"."email_smtp_host" is not null and "channels"."email_smtp_port" is not null and "channels"."email_smtp_security" is not null and "channels"."email_smtp_username" is not null and "channels"."email_smtp_password_encrypted" is not null))));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_meta_social_live_complete" CHECK ("channels"."type" not in ('messenger', 'instagram') or "channels"."deleted_at" is not null or ("channels"."meta_page_id" is not null and "channels"."meta_page_token_encrypted" is not null and "channels"."meta_app_secret_encrypted" is not null and "channels"."meta_verify_token_encrypted" is not null and "channels"."meta_verify_token_rotated_at" is not null and ("channels"."type" <> 'instagram' or "channels"."meta_ig_account_id" is not null)));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_fase6_formats" CHECK (("channels"."tg_bot_id" is null or "channels"."tg_bot_id" ~ '^[0-9]{5,16}$') and ("channels"."tg_bot_username" is null or "channels"."tg_bot_username" ~ '^[A-Za-z0-9_]{1,64}$') and ("channels"."meta_page_id" is null or "channels"."meta_page_id" ~ '^[0-9]{5,32}$') and ("channels"."meta_ig_account_id" is null or "channels"."meta_ig_account_id" ~ '^[0-9]{5,32}$') and ("channels"."email_address" is null or char_length("channels"."email_address") between 3 and 254) and ("channels"."email_from_name" is null or char_length("channels"."email_from_name") between 1 and 100) and ("channels"."email_imap_host" is null or char_length("channels"."email_imap_host") between 1 and 253) and ("channels"."email_smtp_host" is null or char_length("channels"."email_smtp_host") between 1 and 253) and ("channels"."email_imap_username" is null or char_length("channels"."email_imap_username") between 1 and 255) and ("channels"."email_smtp_username" is null or char_length("channels"."email_smtp_username") between 1 and 255) and ("channels"."email_imap_folder" is null or char_length("channels"."email_imap_folder") between 1 and 200) and ("channels"."email_imap_port" is null or "channels"."email_imap_port" between 1 and 65535) and ("channels"."email_smtp_port" is null or "channels"."email_smtp_port" between 1 and 65535) and ("channels"."email_poll_interval_minutes" is null or "channels"."email_poll_interval_minutes" between 1 and 60) and ("channels"."email_imap_security" is null or "channels"."email_imap_security" in ('ssl', 'starttls')) and ("channels"."email_smtp_security" is null or "channels"."email_smtp_security" in ('ssl', 'starttls', 'none')) and ("channels"."email_smtp_mode" is null or "channels"."email_smtp_mode" in ('system', 'custom')));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_deleted_without_secrets" CHECK ("channels"."deleted_at" is null or ("channels"."wa_access_token_encrypted" is null and "channels"."wa_app_secret_encrypted" is null and "channels"."wa_verify_token_encrypted" is null and "channels"."tg_bot_token_encrypted" is null and "channels"."tg_webhook_secret_encrypted" is null and "channels"."email_imap_password_encrypted" is null and "channels"."email_smtp_password_encrypted" is null and "channels"."meta_page_token_encrypted" is null and "channels"."meta_app_secret_encrypted" is null and "channels"."meta_verify_token_encrypted" is null));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_external_identity_required" CHECK ("contacts"."channel_type" = 'whatsapp' or "contacts"."external_user_id" is not null or "contacts"."wa_identity_released_at" is not null);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_external_identity_format" CHECK (("contacts"."external_user_id" is null or (char_length("contacts"."external_user_id") between 1 and 320 and "contacts"."external_user_id" !~ '[[:cntrl:][:space:]]')) and ("contacts"."channel_handle" is null or char_length("contacts"."channel_handle") between 1 and 320));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_window_requires_inbound" CHECK ("conversations"."window_expires_at" is null or "conversations"."last_inbound_at" is not null);