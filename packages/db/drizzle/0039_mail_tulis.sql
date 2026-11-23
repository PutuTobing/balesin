CREATE TABLE "mail_correspondents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_correspondents_account_id_address_unique" UNIQUE("account_id","address"),
	CONSTRAINT "mail_correspondents_values" CHECK (char_length("mail_correspondents"."address") between 3 and 254 and "mail_correspondents"."address" = lower("mail_correspondents"."address") and ("mail_correspondents"."name" is null or char_length("mail_correspondents"."name") <= 200) and "mail_correspondents"."sent_count" >= 0 and "mail_correspondents"."received_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_draft_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"storage_key" text,
	"source" text NOT NULL,
	"source_attachment_id" uuid,
	"state" text DEFAULT 'ready' NOT NULL,
	"failure_code" text,
	"inline" boolean DEFAULT false NOT NULL,
	"content_id" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_draft_attachments_known" CHECK (source in ('upload', 'original') and state in ('ready', 'loading', 'failed') and size_bytes between 0 and 26214400 and char_length(filename) between 1 and 255 and char_length(content_type) between 3 and 128 and (sha256 is null or sha256 ~ '^[0-9a-f]{64}$') and (storage_key is null or storage_key ~ '^(email-out|mail-out)/[0-9a-f-]{36}$') and (content_id is null or content_id ~ '^[A-Za-z0-9._-]{1,64}$') and (failure_code is null or char_length(failure_code) <= 64) and (state <> 'ready' or storage_key is not null))
);
--> statement-breakpoint
CREATE TABLE "mail_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"source_message_id" uuid,
	"source_snapshot" jsonb,
	"thread_root" text,
	"thread_seen_at" timestamp with time zone,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'html' NOT NULL,
	"body_html" text,
	"body_text" text,
	"include_quote" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'editing' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_send_error" jsonb,
	"server_ref" text NOT NULL,
	"server_folder_id" uuid,
	"server_uid" bigint,
	"server_uidvalidity" bigint,
	"server_message_id" text,
	"server_synced_version" integer,
	"server_sync_state" text DEFAULT 'pending' NOT NULL,
	"server_synced_at" timestamp with time zone,
	"server_error_code" text,
	"template_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_drafts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_drafts_server_ref_unique" UNIQUE("server_ref"),
	CONSTRAINT "mail_drafts_known" CHECK (mode in ('new', 'reply', 'reply_all', 'forward') and format in ('html', 'text') and state in ('editing', 'sending') and server_sync_state in ('pending', 'synced', 'error', 'disabled') and version >= 1),
	CONSTRAINT "mail_drafts_sizes" CHECK (char_length("mail_drafts"."subject") <= 200 and ("mail_drafts"."body_html" is null or octet_length("mail_drafts"."body_html") <= 262144) and ("mail_drafts"."body_text" is null or octet_length("mail_drafts"."body_text") <= 131072) and jsonb_array_length("mail_drafts"."to") <= 100 and jsonb_array_length("mail_drafts"."cc") <= 100 and jsonb_array_length("mail_drafts"."bcc") <= 100 and ("mail_drafts"."thread_root" is null or char_length("mail_drafts"."thread_root") <= 998) and "mail_drafts"."server_ref" ~ '^[a-z2-7]{26}$' and ("mail_drafts"."server_message_id" is null or char_length("mail_drafts"."server_message_id") <= 998) and ("mail_drafts"."server_error_code" is null or char_length("mail_drafts"."server_error_code") <= 64))
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"identity_id" uuid,
	"draft_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text NOT NULL,
	"reply_to" text,
	"envelope_from" text NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipient_count" integer NOT NULL,
	"new_recipient_count" integer DEFAULT 0 NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"subject" text,
	"html" text,
	"text" text,
	"message_id_header" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sending_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"failure_reason" text,
	"smtp_code" integer,
	"rejected_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hold_reason" text,
	"raw_storage_key" text,
	"sent_copy_state" text DEFAULT 'pending' NOT NULL,
	"sent_copy_attempts" integer DEFAULT 0 NOT NULL,
	"sent_copy_next_at" timestamp with time zone,
	"sent_copy_at" timestamp with time zone,
	"sent_message_id" uuid,
	"new_address_units" integer DEFAULT 0 NOT NULL,
	"template_id" uuid,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_outbox_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_outbox_organization_id_message_id_header_unique" UNIQUE("organization_id","message_id_header"),
	CONSTRAINT "mail_outbox_known" CHECK (status in ('pending', 'queued', 'sending', 'sent', 'failed', 'canceled') and mode in ('new', 'reply', 'reply_all', 'forward') and (failure_reason is null or failure_reason in ('recipient_rejected', 'message_rejected', 'sender_rejected', 'sender_unavailable', 'throttle_expired', 'sending_paused_expired', 'delivery_unknown', 'attachment_unavailable', 'credentials_unavailable', 'not_allowed', 'identity_unverified', 'account_unavailable')) and (hold_reason is null or hold_reason in ('hourly_limit', 'throttled', 'paused', 'blocked', 'sending_paused', 'account_offline')) and sent_copy_state in ('pending', 'done', 'server_saved', 'skipped', 'failed') and ((status = 'failed') = (failure_reason is not null))),
	CONSTRAINT "mail_outbox_sizes" CHECK ("mail_outbox"."recipient_count" between 1 and 100 and "mail_outbox"."new_recipient_count" >= 0 and "mail_outbox"."attempts" >= 0 and "mail_outbox"."attachment_count" between 0 and 20 and "mail_outbox"."new_address_units" >= 0 and ("mail_outbox"."subject" is null or char_length("mail_outbox"."subject") <= 200) and ("mail_outbox"."html" is null or octet_length("mail_outbox"."html") <= 524288) and ("mail_outbox"."text" is null or octet_length("mail_outbox"."text") <= 262144) and char_length("mail_outbox"."message_id_header") between 3 and 998 and ("mail_outbox"."in_reply_to" is null or char_length("mail_outbox"."in_reply_to") <= 998) and cardinality("mail_outbox"."references") <= 20 and char_length("mail_outbox"."from_address") between 3 and 254 and char_length("mail_outbox"."from_name") between 1 and 80 and ("mail_outbox"."raw_storage_key" is null or "mail_outbox"."raw_storage_key" ~ '^(email-out|mail-out)/[0-9a-f-]{36}$') and jsonb_array_length("mail_outbox"."rejected_recipients") <= 100)
);
--> statement-breakpoint
CREATE TABLE "mail_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"logo_png" "bytea",
	"logo_sha256" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_signatures_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_signatures_sizes" CHECK (char_length("mail_signatures"."name") between 1 and 60 and octet_length("mail_signatures"."html") <= 32768 and octet_length("mail_signatures"."text") <= 8192 and ("mail_signatures"."logo_png" is null or octet_length("mail_signatures"."logo_png") between 1 and 131072) and (("mail_signatures"."logo_png" is null) = ("mail_signatures"."logo_sha256" is null)) and ("mail_signatures"."logo_sha256" is null or "mail_signatures"."logo_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "mail_user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"undo_send_seconds" integer DEFAULT 10 NOT NULL,
	"compose_format" text DEFAULT 'html' NOT NULL,
	"signature_choices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_user_preferences_values" CHECK (undo_send_seconds between 5 and 30 and compose_format in ('html', 'text') and jsonb_typeof(signature_choices) = 'object')
);
--> statement-breakpoint
ALTER TABLE "mail_identities" DROP CONSTRAINT "mail_identities_text_lengths";--> statement-breakpoint
ALTER TABLE "mail_messages" DROP CONSTRAINT "mail_messages_sizes";--> statement-breakpoint
ALTER TABLE "mail_settings" DROP CONSTRAINT "mail_settings_numbers";--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "sent_copy_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "warn_external_recipients" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_state" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verified_method" text;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_code_hash" text;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_message_id_hash" text;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "verification_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "default_signature_new_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "default_signature_reply_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
-- Data lama (9A): verified_at terisi = verified.
UPDATE "mail_identities" SET "verification_state" = 'verified' WHERE "verified_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "thread_root" text;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "max_recipients_per_email" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "max_attachment_total_mb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "mail_correspondents" ADD CONSTRAINT "mail_correspondents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_correspondents" ADD CONSTRAINT "mail_correspondents_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft_attachments" ADD CONSTRAINT "mail_draft_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft_attachments" ADD CONSTRAINT "mail_draft_attachments_source_attachment_id_mail_attachments_id_fk" FOREIGN KEY ("source_attachment_id") REFERENCES "public"."mail_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft_attachments" ADD CONSTRAINT "mail_draft_attachments_organization_id_draft_id_fk" FOREIGN KEY ("organization_id","draft_id") REFERENCES "public"."mail_drafts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft_attachments" ADD CONSTRAINT "mail_draft_attachments_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_source_message_id_mail_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_organization_id_identity_id_fk" FOREIGN KEY ("organization_id","identity_id") REFERENCES "public"."mail_identities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_organization_id_owner_user_id_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_identity_id_mail_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."mail_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_draft_id_mail_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."mail_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_sent_message_id_mail_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_signatures" ADD CONSTRAINT "mail_signatures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_signatures" ADD CONSTRAINT "mail_signatures_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_signatures" ADD CONSTRAINT "mail_signatures_organization_id_owner_user_id_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_signatures" ADD CONSTRAINT "mail_signatures_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_signatures" ADD CONSTRAINT "mail_signatures_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_user_preferences" ADD CONSTRAINT "mail_user_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_user_preferences" ADD CONSTRAINT "mail_user_preferences_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_correspondents_prefix_idx" ON "mail_correspondents" USING btree ("organization_id","account_id","address" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "mail_draft_attachments_draft_idx" ON "mail_draft_attachments" USING btree ("draft_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_draft_attachments_content_id_unique" ON "mail_draft_attachments" USING btree ("draft_id","content_id") WHERE "mail_draft_attachments"."content_id" is not null;--> statement-breakpoint
CREATE INDEX "mail_drafts_owner_updated_idx" ON "mail_drafts" USING btree ("organization_id","owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_drafts_account_thread_idx" ON "mail_drafts" USING btree ("account_id","thread_root");--> statement-breakpoint
CREATE INDEX "mail_drafts_server_pending_idx" ON "mail_drafts" USING btree ("server_sync_state","updated_at") WHERE "mail_drafts"."server_sync_state" = 'pending';--> statement-breakpoint
CREATE INDEX "mail_outbox_due_idx" ON "mail_outbox" USING btree ("status","send_after","next_attempt_at") WHERE "mail_outbox"."status" in ('pending', 'queued');--> statement-breakpoint
CREATE UNIQUE INDEX "mail_outbox_active_draft_unique" ON "mail_outbox" USING btree ("draft_id") WHERE "mail_outbox"."status" in ('pending', 'queued', 'sending');--> statement-breakpoint
CREATE INDEX "mail_outbox_account_sent_idx" ON "mail_outbox" USING btree ("organization_id","account_id","sent_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_creator_idx" ON "mail_outbox" USING btree ("organization_id","created_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_sent_copy_idx" ON "mail_outbox" USING btree ("sent_copy_state","sent_copy_next_at") WHERE "mail_outbox"."status" = 'sent' and "mail_outbox"."sent_copy_state" = 'pending';--> statement-breakpoint
CREATE INDEX "mail_signatures_account_owner_idx" ON "mail_signatures" USING btree ("organization_id","account_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "api_key_email_senders" ADD CONSTRAINT "api_key_email_senders_organization_id_mail_account_id_fk" FOREIGN KEY ("organization_id","mail_account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_settings" ADD CONSTRAINT "email_sender_settings_organization_id_mail_account_id_fk" FOREIGN KEY ("organization_id","mail_account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_default_signature_new_id_mail_signatures_id_fk" FOREIGN KEY ("default_signature_new_id") REFERENCES "public"."mail_signatures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_default_signature_reply_id_mail_signatures_id_fk" FOREIGN KEY ("default_signature_reply_id") REFERENCES "public"."mail_signatures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_organization_id_verification_requested_by_fk" FOREIGN KEY ("organization_id","verification_requested_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_identities_pending_idx" ON "mail_identities" USING btree ("account_id","verification_message_id_hash") WHERE "mail_identities"."verification_state" = 'pending';--> statement-breakpoint
CREATE INDEX "mail_messages_thread_root_idx" ON "mail_messages" USING btree ("organization_id","account_id","thread_root","received_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_sent_copy_mode" CHECK (sent_copy_mode in ('auto', 'append', 'none'));--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_verification" CHECK (verification_state in ('unverified', 'pending', 'verified') and (verified_method is null or verified_method in ('mailbox', 'code')) and ((verification_state = 'verified') = (verified_at is not null)) and verification_attempts between 0 and 5 and (verification_code_hash is null or char_length(verification_code_hash) <= 64) and (verification_message_id_hash is null or verification_message_id_hash ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_text_lengths" CHECK (char_length("mail_identities"."address") between 3 and 254 and "mail_identities"."address" = lower("mail_identities"."address") and char_length("mail_identities"."display_name") between 1 and 80 and ("mail_identities"."reply_to" is null or (char_length("mail_identities"."reply_to") between 3 and 254 and "mail_identities"."reply_to" = lower("mail_identities"."reply_to"))));--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_sizes" CHECK (("mail_messages"."message_id_header" is null or char_length("mail_messages"."message_id_header") <= 998) and ("mail_messages"."in_reply_to" is null or char_length("mail_messages"."in_reply_to") <= 998) and cardinality("mail_messages"."references") <= 20 and ("mail_messages"."subject" is null or char_length("mail_messages"."subject") <= 998) and ("mail_messages"."snippet" is null or char_length("mail_messages"."snippet") <= 200) and ("mail_messages"."from_address" is null or char_length("mail_messages"."from_address") <= 254) and ("mail_messages"."from_name" is null or char_length("mail_messages"."from_name") <= 200) and ("mail_messages"."delivered_to" is null or char_length("mail_messages"."delivered_to") <= 254) and jsonb_array_length("mail_messages"."to") <= 100 and jsonb_array_length("mail_messages"."cc") <= 100 and cardinality("mail_messages"."keywords") <= 50 and "mail_messages"."uid" > 0 and "mail_messages"."size_bytes" >= 0 and ("mail_messages"."thread_root" is null or char_length("mail_messages"."thread_root") <= 998));--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_numbers" CHECK ("mail_settings"."cache_retention_days" between 7 and 3650 and ("mail_settings"."default_sync_window_days" is null or "mail_settings"."default_sync_window_days" in (30, 90, 365)) and "mail_settings"."max_recipients_per_email" between 1 and 100 and "mail_settings"."max_attachment_total_mb" between 1 and 25);