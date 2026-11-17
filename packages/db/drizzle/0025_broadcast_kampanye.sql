-- Fase 4: broadcast (kampanye, penerima, pengaturan, konektor REST), alarm Telegram + outbox alarm,
-- pesan broadcast (`messages.broadcast_id`), review kontak R4 (kontak "mungkin duplikat" / identitas dilepas),
-- indeks jaring pengaman kode OTP template (review template Info 1).
ALTER TYPE "public"."contact_event_kind" ADD VALUE 'whatsapp_identity_attached';--> statement-breakpoint
ALTER TYPE "public"."contact_event_kind" ADD VALUE 'possible_duplicate';--> statement-breakpoint
CREATE TABLE "alarm_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"campaign_id" uuid,
	"details" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alarm_events_known" CHECK (kind in ('emergency_brake', 'auto_brake', 'broadcast_auto_paused', 'broadcast_pending_approval', 'broadcast_completed') and status in ('pending', 'sent', 'skipped', 'failed') and attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "broadcast_campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"source_kind" text,
	"source_label" text,
	"source_imported_at" timestamp with time zone,
	"columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone_column" text,
	"mapping" jsonb DEFAULT '{"body":{},"header":null,"buttons":{}}'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"rate_per_second" integer DEFAULT 5 NOT NULL,
	"dedupe_hours" integer DEFAULT 24,
	"dedupe_scope" text DEFAULT 'template' NOT NULL,
	"auto_tag_id" uuid,
	"source_rows" integer DEFAULT 0 NOT NULL,
	"rejected_rows" integer DEFAULT 0 NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"approval_threshold" integer,
	"approval_requested_at" timestamp with time zone,
	"approval_decided_at" timestamp with time zone,
	"approval_decided_by_user_id" uuid,
	"rejection_reason" text,
	"estimate" jsonb,
	"submitted_by_user_id" uuid,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"waiting_reason" text,
	"waiting_until" timestamp with time zone,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"runner_lease_until" timestamp with time zone,
	"failure_window_from" timestamp with time zone,
	"data_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_campaigns_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "broadcast_campaigns_status_known" CHECK (status in ('draft', 'pending_approval', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "broadcast_campaigns_source_kind_known" CHECK (source_kind is null or source_kind in ('upload', 'segment', 'connector')),
	CONSTRAINT "broadcast_campaigns_pause_known" CHECK ((paused_reason is null) = (paused_at is null) and (paused_reason is null or paused_reason in ('manual', 'emergency_brake', 'failure_spike', 'meta_blocked', 'quality_low', 'template_unavailable', 'channel_unavailable'))),
	CONSTRAINT "broadcast_campaigns_paused_has_reason" CHECK ("broadcast_campaigns"."status" <> 'paused' or "broadcast_campaigns"."paused_reason" is not null),
	CONSTRAINT "broadcast_campaigns_waiting_known" CHECK ((waiting_reason is null) = (waiting_until is null) and (waiting_reason is null or waiting_reason in ('daily_quota', 'meta_tier', 'meta_rate_limit'))),
	CONSTRAINT "broadcast_campaigns_dedupe_known" CHECK (dedupe_scope in ('template', 'any') and (dedupe_hours is null or dedupe_hours between 1 and 720)),
	CONSTRAINT "broadcast_campaigns_rate_range" CHECK ("broadcast_campaigns"."rate_per_second" between 1 and 20 and "broadcast_campaigns"."source_rows" >= 0 and "broadcast_campaigns"."rejected_rows" >= 0),
	CONSTRAINT "broadcast_campaigns_text_lengths" CHECK (char_length("broadcast_campaigns"."name") between 1 and 80 and ("broadcast_campaigns"."source_label" is null or char_length("broadcast_campaigns"."source_label") <= 200) and ("broadcast_campaigns"."rejection_reason" is null or char_length("broadcast_campaigns"."rejection_reason") <= 300) and cardinality("broadcast_campaigns"."columns") <= 30)
);
--> statement-breakpoint
CREATE TABLE "broadcast_connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_header_name" text,
	"auth_header_value_encrypted" text,
	"auth_header_tail" text,
	"items_path" text DEFAULT '' NOT NULL,
	"phone_field" text NOT NULL,
	"last_test_ok" boolean,
	"last_test_code" text,
	"last_test_items" integer,
	"last_tested_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_connectors_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "broadcast_connectors_auth_consistent" CHECK (("broadcast_connectors"."auth_header_name" is null) = ("broadcast_connectors"."auth_header_value_encrypted" is null) and ("broadcast_connectors"."auth_header_name" is null) = ("broadcast_connectors"."auth_header_tail" is null)),
	CONSTRAINT "broadcast_connectors_lengths" CHECK (char_length("broadcast_connectors"."name") between 1 and 60 and char_length("broadcast_connectors"."url") between 1 and 2000 and char_length("broadcast_connectors"."phone_field") between 1 and 64 and char_length("broadcast_connectors"."items_path") <= 120),
	CONSTRAINT "broadcast_connectors_last_test_complete" CHECK (("broadcast_connectors"."last_test_ok" is null) = ("broadcast_connectors"."last_tested_at" is null) and ("broadcast_connectors"."last_test_ok" is null) = ("broadcast_connectors"."last_test_code" is null))
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"phone" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"contact_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_recipients_status_known" CHECK (status in ('pending', 'skipped', 'queued', 'cancelled') and (skip_reason is null or skip_reason in ('recently_sent', 'missing_variable', 'invalid_variable', 'contact_unavailable')) and ((status = 'skipped') = (skip_reason is not null))),
	CONSTRAINT "broadcast_recipients_queued_has_message" CHECK ("broadcast_recipients"."status" <> 'queued' or ("broadcast_recipients"."message_id" is not null and "broadcast_recipients"."processed_at" is not null)),
	CONSTRAINT "broadcast_recipients_phone_e164" CHECK ("broadcast_recipients"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "broadcast_recipients_data_size" CHECK (jsonb_typeof("broadcast_recipients"."data") = 'object' and octet_length("broadcast_recipients"."data"::text) <= 32768 and "broadcast_recipients"."row_number" > 0 and "broadcast_recipients"."send_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "broadcast_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"approval_threshold" integer NOT NULL,
	"max_rate_per_second" integer NOT NULL,
	"quota_reserve_percent" integer NOT NULL,
	"auto_brake_enabled" boolean NOT NULL,
	"failure_spike_percent" integer NOT NULL,
	"failure_spike_min_sample" integer NOT NULL,
	"spike_multiplier" integer NOT NULL,
	"spike_min_per_minute" integer NOT NULL,
	"spike_absolute_per_minute" integer NOT NULL,
	"rates" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_settings_ranges" CHECK ("broadcast_settings"."approval_threshold" between 1 and 100000 and "broadcast_settings"."max_rate_per_second" between 1 and 20 and "broadcast_settings"."quota_reserve_percent" between 5 and 90 and "broadcast_settings"."failure_spike_percent" between 10 and 100 and "broadcast_settings"."failure_spike_min_sample" between 5 and 1000 and "broadcast_settings"."spike_multiplier" between 2 and 100 and "broadcast_settings"."spike_min_per_minute" between 10 and 10000 and "broadcast_settings"."spike_absolute_per_minute" between 10 and 100000)
);
--> statement-breakpoint
CREATE TABLE "telegram_alarm_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"bot_token_encrypted" text NOT NULL,
	"bot_token_tail" text NOT NULL,
	"telegram_chat" text NOT NULL,
	"last_test_ok" boolean,
	"last_test_code" text,
	"last_tested_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_alarm_settings_chat_format" CHECK ("telegram_alarm_settings"."telegram_chat" ~ '^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$'),
	CONSTRAINT "telegram_alarm_settings_last_test_complete" CHECK (("telegram_alarm_settings"."last_test_ok" is null) = ("telegram_alarm_settings"."last_tested_at" is null) and ("telegram_alarm_settings"."last_test_ok" is null) = ("telegram_alarm_settings"."last_test_code" is null))
);
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_whatsapp_identity_required";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "possible_duplicate_of_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "wa_identity_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "broadcast_id" uuid;--> statement-breakpoint
ALTER TABLE "alarm_events" ADD CONSTRAINT "alarm_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_decided_by_user_id_fk" FOREIGN KEY ("organization_id","approval_decided_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_submitted_by_user_id_fk" FOREIGN KEY ("organization_id","submitted_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_paused_by_user_id_fk" FOREIGN KEY ("organization_id","paused_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organization_id_cancelled_by_user_id_fk" FOREIGN KEY ("organization_id","cancelled_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_connectors" ADD CONSTRAINT "broadcast_connectors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_connectors" ADD CONSTRAINT "broadcast_connectors_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_connectors" ADD CONSTRAINT "broadcast_connectors_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_organization_id_campaign_id_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."broadcast_campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_settings" ADD CONSTRAINT "broadcast_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_settings" ADD CONSTRAINT "broadcast_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_alarm_settings" ADD CONSTRAINT "telegram_alarm_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_alarm_settings" ADD CONSTRAINT "telegram_alarm_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alarm_events_pending_idx" ON "alarm_events" USING btree ("next_attempt_at") WHERE "alarm_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "alarm_events_organization_id_created_at_idx" ON "alarm_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcast_campaigns_organization_id_created_at_idx" ON "broadcast_campaigns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcast_campaigns_active_idx" ON "broadcast_campaigns" USING btree ("status","scheduled_at") WHERE "broadcast_campaigns"."status" in ('scheduled', 'running');--> statement-breakpoint
CREATE INDEX "broadcast_connectors_organization_id_idx" ON "broadcast_connectors" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_campaign_id_phone_unique" ON "broadcast_recipients" USING btree ("campaign_id","phone");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_campaign_id_status_row_idx" ON "broadcast_recipients" USING btree ("campaign_id","status","row_number");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_phone_processed_at_idx" ON "broadcast_recipients" USING btree ("organization_id","phone","processed_at") WHERE "broadcast_recipients"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "broadcast_recipients_contact_processed_at_idx" ON "broadcast_recipients" USING btree ("organization_id","contact_id","processed_at") WHERE "broadcast_recipients"."contact_id" is not null and "broadcast_recipients"."replied_at" is null;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_message_id_idx" ON "broadcast_recipients" USING btree ("message_id") WHERE "broadcast_recipients"."message_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_broadcast_id_fk" FOREIGN KEY ("organization_id","broadcast_id") REFERENCES "public"."broadcast_campaigns"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_sensitive_template_idx" ON "messages" USING btree ("created_at") WHERE ("messages"."extras" -> 'template' ->> 'sensitive') = 'true' and ("messages"."extras" -> 'template' -> 'values') <> '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "messages_broadcast_id_idx" ON "messages" USING btree ("broadcast_id") WHERE "messages"."broadcast_id" is not null;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_whatsapp_identity_required" CHECK ("contacts"."channel_type" <> 'whatsapp' or "contacts"."wa_bsuid" is not null or "contacts"."phone" is not null or "contacts"."wa_identity_released_at" is not null);