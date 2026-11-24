CREATE TABLE "api_key_email_senders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"sender_kind" text NOT NULL,
	"channel_id" uuid,
	"mail_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_email_senders_api_key_id_channel_id_unique" UNIQUE("api_key_id","channel_id"),
	CONSTRAINT "api_key_email_senders_api_key_id_mail_account_id_unique" UNIQUE("api_key_id","mail_account_id"),
	CONSTRAINT "api_key_email_senders_sender_one" CHECK (("api_key_email_senders"."sender_kind" = 'channel' and "api_key_email_senders"."channel_id" is not null and "api_key_email_senders"."mail_account_id" is null) or ("api_key_email_senders"."sender_kind" = 'account' and "api_key_email_senders"."mail_account_id" is not null and "api_key_email_senders"."channel_id" is null))
);
--> statement-breakpoint
CREATE TABLE "email_outbound" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"api_key_id" uuid,
	"created_by_user_id" uuid,
	"sender_kind" text NOT NULL,
	"channel_id" uuid,
	"mail_account_id" uuid,
	"from_address" text NOT NULL,
	"from_name" text NOT NULL,
	"reply_to" text,
	"to" jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipient_count" integer NOT NULL,
	"subject" text NOT NULL,
	"html" text,
	"text" text,
	"sanitized" boolean DEFAULT false NOT NULL,
	"template_id" uuid,
	"template_version_id" uuid,
	"template_version" integer,
	"idempotency_key" text,
	"request_hash" text,
	"metadata" jsonb,
	"conversation_id" uuid,
	"message_id" uuid,
	"contact_id" uuid,
	"reply_to_message_id" uuid,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"message_id_header" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sending_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"smtp_code" integer,
	"rejected_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bounces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bounced_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbound_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "email_outbound_organization_id_message_id_header_unique" UNIQUE("organization_id","message_id_header"),
	CONSTRAINT "email_outbound_known" CHECK (status in ('scheduled', 'queued', 'sending', 'sent', 'failed', 'bounced', 'canceled') and source in ('api', 'test') and (failure_reason is null or failure_reason in ('recipient_rejected', 'message_rejected', 'sender_rejected', 'sender_unavailable', 'sender_not_allowed', 'sending_paused_expired', 'throttle_expired', 'delivery_unknown', 'attachment_unavailable', 'credentials_unavailable'))),
	CONSTRAINT "email_outbound_sender_one" CHECK (("email_outbound"."sender_kind" = 'channel' and "email_outbound"."channel_id" is not null and "email_outbound"."mail_account_id" is null) or ("email_outbound"."sender_kind" = 'account' and "email_outbound"."mail_account_id" is not null and "email_outbound"."channel_id" is null)),
	CONSTRAINT "email_outbound_source_actor" CHECK (("email_outbound"."source" = 'api' and "email_outbound"."api_key_id" is not null) or ("email_outbound"."source" = 'test' and "email_outbound"."created_by_user_id" is not null)),
	CONSTRAINT "email_outbound_sizes" CHECK ("email_outbound"."recipient_count" between 1 and 50 and char_length("email_outbound"."subject") between 1 and 200 and char_length("email_outbound"."from_address") between 3 and 254 and char_length("email_outbound"."from_name") <= 100 and ("email_outbound"."html" is null or octet_length("email_outbound"."html") <= 1572864) and ("email_outbound"."text" is null or octet_length("email_outbound"."text") <= 524288) and ("email_outbound"."idempotency_key" is null or char_length("email_outbound"."idempotency_key") between 1 and 100) and ("email_outbound"."request_hash" is null or "email_outbound"."request_hash" ~ '^[0-9a-f]{64}$') and ("email_outbound"."metadata" is null or octet_length("email_outbound"."metadata"::text) <= 4096) and char_length("email_outbound"."message_id_header") between 3 and 300 and "email_outbound"."attempts" >= 0 and cardinality("email_outbound"."references") <= 20)
);
--> statement-breakpoint
CREATE TABLE "email_outbound_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email_outbound_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text,
	"source" text NOT NULL,
	"source_host" text,
	"inline" boolean DEFAULT false NOT NULL,
	"cid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbound_attachments_known" CHECK ("email_outbound_attachments"."source" in ('base64', 'media', 'url', 'qris', 'logo') and "email_outbound_attachments"."size_bytes" between 0 and 20971520 and "email_outbound_attachments"."position" >= 0 and char_length("email_outbound_attachments"."filename") between 1 and 255 and char_length("email_outbound_attachments"."content_type") between 3 and 128 and char_length("email_outbound_attachments"."sha256") = 64 and ("email_outbound_attachments"."storage_key" is null or "email_outbound_attachments"."storage_key" ~ '^email-out/[0-9a-f-]{36}$') and ("email_outbound_attachments"."cid" is null or "email_outbound_attachments"."cid" ~ '^[A-Za-z0-9._-]{1,64}$') and ("email_outbound_attachments"."source_host" is null or char_length("email_outbound_attachments"."source_host") <= 253))
);
--> statement-breakpoint
CREATE TABLE "email_sender_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sender_kind" text NOT NULL,
	"channel_id" uuid,
	"mail_account_id" uuid,
	"hourly_limit" integer DEFAULT 100 NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"throttled_until" timestamp with time zone,
	"throttle_streak" integer DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"blocked_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sender_settings_channel_id_unique" UNIQUE("channel_id"),
	CONSTRAINT "email_sender_settings_mail_account_id_unique" UNIQUE("mail_account_id"),
	CONSTRAINT "email_sender_settings_known" CHECK (state in ('ok', 'throttled', 'paused', 'blocked') and hourly_limit between 1 and 5000 and throttle_streak >= 0 and (blocked_reason is null or blocked_reason in ('smtp_auth_failed', 'credentials_unavailable', 'smtp_config_invalid')) and (pause_reason is null or char_length(pause_reason) <= 200)),
	CONSTRAINT "email_sender_settings_sender_one" CHECK (("email_sender_settings"."sender_kind" = 'channel' and "email_sender_settings"."channel_id" is not null and "email_sender_settings"."mail_account_id" is null) or ("email_sender_settings"."sender_kind" = 'account' and "email_sender_settings"."mail_account_id" is not null and "email_sender_settings"."channel_id" is null))
);
--> statement-breakpoint
CREATE TABLE "email_template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text,
	"variables" jsonb NOT NULL,
	"layout" text NOT NULL,
	"footer_text" text,
	"created_by_user_id" uuid,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_versions_template_id_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "email_template_versions_known" CHECK (state in ('draft', 'published', 'superseded') and layout in ('brand', 'none') and version >= 0 and ((state = 'draft') = (version = 0))),
	CONSTRAINT "email_template_versions_sizes" CHECK (char_length("email_template_versions"."subject") <= 1000 and octet_length("email_template_versions"."html") <= 524288 and ("email_template_versions"."text" is null or octet_length("email_template_versions"."text") <= 262144) and jsonb_array_length("email_template_versions"."variables") <= 30 and ("email_template_versions"."footer_text" is null or char_length("email_template_versions"."footer_text") <= 500))
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"preset_key" text,
	"published_version" integer,
	"archived_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "email_templates_organization_id_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "email_templates_text_lengths" CHECK ("email_templates"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("email_templates"."slug") between 2 and 64 and char_length("email_templates"."name") between 1 and 80 and ("email_templates"."description" is null or char_length("email_templates"."description") <= 200) and ("email_templates"."preset_key" is null or char_length("email_templates"."preset_key") <= 64) and ("email_templates"."published_version" is null or "email_templates"."published_version" >= 1))
);
--> statement-breakpoint
ALTER TABLE "alarm_events" DROP CONSTRAINT "alarm_events_known";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "email_attachment_hosts" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_events" ADD COLUMN "email_outbound_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key_email_senders" ADD CONSTRAINT "api_key_email_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_email_senders" ADD CONSTRAINT "api_key_email_senders_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_email_senders" ADD CONSTRAINT "api_key_email_senders_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_template_version_id_email_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."email_template_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound" ADD CONSTRAINT "email_outbound_organization_id_template_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."email_templates"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_attachments" ADD CONSTRAINT "email_outbound_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_attachments" ADD CONSTRAINT "email_outbound_attachments_organization_id_email_outbound_id_fk" FOREIGN KEY ("organization_id","email_outbound_id") REFERENCES "public"."email_outbound"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_settings" ADD CONSTRAINT "email_sender_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_settings" ADD CONSTRAINT "email_sender_settings_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_settings" ADD CONSTRAINT "email_sender_settings_organization_id_paused_by_user_id_fk" FOREIGN KEY ("organization_id","paused_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_settings" ADD CONSTRAINT "email_sender_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_organization_id_template_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."email_templates"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_organization_id_published_by_user_id_fk" FOREIGN KEY ("organization_id","published_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbound_idempotency_unique" ON "email_outbound" USING btree ("organization_id","api_key_id","idempotency_key") WHERE "email_outbound"."api_key_id" is not null and "email_outbound"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "email_outbound_due_idx" ON "email_outbound" USING btree ("status","next_attempt_at") WHERE "email_outbound"."status" in ('queued', 'scheduled');--> statement-breakpoint
CREATE INDEX "email_outbound_organization_id_channel_id_sent_at_idx" ON "email_outbound" USING btree ("organization_id","channel_id","sent_at");--> statement-breakpoint
CREATE INDEX "email_outbound_waiting_idx" ON "email_outbound" USING btree ("organization_id","channel_id","created_at") WHERE "email_outbound"."status" in ('queued', 'scheduled', 'sending');--> statement-breakpoint
CREATE INDEX "email_outbound_organization_id_api_key_id_created_at_idx" ON "email_outbound" USING btree ("organization_id","api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "email_outbound_organization_id_created_at_id_idx" ON "email_outbound" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_outbound_message_id_idx" ON "email_outbound" USING btree ("message_id") WHERE "email_outbound"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "email_outbound_contact_id_idx" ON "email_outbound" USING btree ("contact_id") WHERE "email_outbound"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "email_outbound_attachments_email_outbound_id_idx" ON "email_outbound_attachments" USING btree ("email_outbound_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_versions_one_draft" ON "email_template_versions" USING btree ("template_id") WHERE "email_template_versions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "email_templates_organization_id_archived_at_name_idx" ON "email_templates" USING btree ("organization_id","archived_at","name");--> statement-breakpoint
ALTER TABLE "outgoing_events" ADD CONSTRAINT "outgoing_events_organization_id_email_outbound_id_fk" FOREIGN KEY ("organization_id","email_outbound_id") REFERENCES "public"."email_outbound"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_email_attachment_hosts_count" CHECK (cardinality("api_keys"."email_attachment_hosts") <= 20);--> statement-breakpoint
ALTER TABLE "alarm_events" ADD CONSTRAINT "alarm_events_known" CHECK (kind in ('emergency_brake', 'auto_brake', 'broadcast_auto_paused', 'broadcast_pending_approval', 'broadcast_completed', 'email_sender_blocked') and status in ('pending', 'sent', 'skipped', 'failed') and attempts >= 0);