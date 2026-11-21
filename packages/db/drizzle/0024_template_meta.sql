-- Fase 4: template pesan Meta (sinkron, ajukan, preset) + jenis pesan `template` dan kategori template
-- per pesan (dasar laporan biaya per kategori). Review bot R1: bot aktif wajib punya batas waktu.
ALTER TYPE "public"."message_type" ADD VALUE 'template';--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"meta_template_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"rejected_reason" text,
	"quality_score" text,
	"content" jsonb NOT NULL,
	"meta_components" jsonb,
	"source" text DEFAULT 'balesin' NOT NULL,
	"preset_key" text,
	"local_changes" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"status_updated_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "message_templates_category_known" CHECK ("message_templates"."category" in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
	CONSTRAINT "message_templates_status_known" CHECK ("message_templates"."status" in ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED')),
	CONSTRAINT "message_templates_source_known" CHECK ("message_templates"."source" in ('meta', 'balesin', 'preset')),
	CONSTRAINT "message_templates_name_format" CHECK ("message_templates"."name" ~ '^[a-z0-9_]+$' and char_length("message_templates"."name") <= 512 and char_length("message_templates"."language") between 2 and 16),
	CONSTRAINT "message_templates_draft_without_meta" CHECK ("message_templates"."status" <> 'DRAFT' or "message_templates"."meta_template_id" is null)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_category" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_channel_name_language_unique" ON "message_templates" USING btree ("channel_id","name","language");--> statement-breakpoint
CREATE INDEX "message_templates_organization_id_status_idx" ON "message_templates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "message_templates_waba_meta_id_idx" ON "message_templates" USING btree ("waba_id","meta_template_id");--> statement-breakpoint
-- Review bot R1: channel yang botnya aktif tanpa batas waktu diberi batas bawaan 15 menit.
UPDATE "channels" SET "bot_timeout_minutes" = 15 WHERE "bot_enabled" AND "bot_timeout_minutes" IS NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_enabled_has_timeout" CHECK (not "channels"."bot_enabled" or "channels"."bot_timeout_minutes" is not null);