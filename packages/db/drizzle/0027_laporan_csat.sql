-- Fase 5: survei kepuasan (CSAT) otomatis setelah percakapan ditandai selesai + pengaturannya.
-- Laporan kinerja & biaya memakai tabel yang sudah ada (tanpa tabel ringkasan).
CREATE TABLE "csat_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"question" text NOT NULL,
	"thanks" text NOT NULL,
	"min_interval_hours" integer DEFAULT 24 NOT NULL,
	"enabled_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csat_settings_lengths" CHECK (char_length("csat_settings"."question") between 1 and 300 and char_length("csat_settings"."thanks") between 1 and 300 and "csat_settings"."min_interval_hours" between 1 and 720)
);
--> statement-breakpoint
CREATE TABLE "csat_surveys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"agent_user_id" uuid,
	"resolved_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"score" integer,
	"comment" text,
	"message_id" uuid,
	"thanks_message_id" uuid,
	"resolved_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"commented_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csat_surveys_status_known" CHECK (status in ('pending', 'sent', 'answered', 'expired', 'failed', 'skipped') and (skip_reason is null or skip_reason in ('window_closed', 'no_customer_message', 'no_human_reply', 'recently_surveyed', 'channel_unavailable', 'recipient_unavailable', 'reopened', 'disabled')) and ((status = 'skipped') = (skip_reason is not null))),
	CONSTRAINT "csat_surveys_score_range" CHECK (("csat_surveys"."score" is null or "csat_surveys"."score" between 1 and 5) and ("csat_surveys"."status" <> 'answered' or ("csat_surveys"."score" is not null and "csat_surveys"."answered_at" is not null)) and ("csat_surveys"."comment" is null or char_length("csat_surveys"."comment") between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "csat_settings" ADD CONSTRAINT "csat_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_settings" ADD CONSTRAINT "csat_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_organization_id_agent_user_id_fk" FOREIGN KEY ("organization_id","agent_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_organization_id_resolved_by_user_id_fk" FOREIGN KEY ("organization_id","resolved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "csat_surveys_conversation_id_unique" ON "csat_surveys" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "csat_surveys_organization_id_created_at_idx" ON "csat_surveys" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "csat_surveys_open_idx" ON "csat_surveys" USING btree ("status","created_at") WHERE "csat_surveys"."status" in ('pending', 'sent', 'answered');--> statement-breakpoint
CREATE INDEX "csat_surveys_contact_id_created_at_idx" ON "csat_surveys" USING btree ("organization_id","contact_id","created_at");