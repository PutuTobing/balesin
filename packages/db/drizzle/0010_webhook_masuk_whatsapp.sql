CREATE TYPE "public"."webhook_event_kind" AS ENUM('message', 'status', 'error', 'other');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('pending', 'processed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" "channel_type" NOT NULL,
	"kind" "webhook_event_kind" NOT NULL,
	"field" text NOT NULL,
	"dedup_key" text NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "webhook_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_dedup_key_length" CHECK (char_length("webhook_events"."dedup_key") between 3 and 320),
	CONSTRAINT "webhook_events_field_format" CHECK ("webhook_events"."field" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "webhook_events_external_id_length" CHECK ("webhook_events"."external_id" is null or char_length("webhook_events"."external_id") between 1 and 256),
	CONSTRAINT "webhook_events_attempts_nonnegative" CHECK ("webhook_events"."attempts" >= 0),
	CONSTRAINT "webhook_events_last_error_length" CHECK ("webhook_events"."last_error" is null or char_length("webhook_events"."last_error") <= 200),
	CONSTRAINT "webhook_events_external_id_required" CHECK ("webhook_events"."kind" not in ('message', 'status') or "webhook_events"."external_id" is not null),
	CONSTRAINT "webhook_events_processed_at_matches_status" CHECK (("webhook_events"."status" in ('processed', 'skipped')) = ("webhook_events"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_channel_id_dedup_key_unique" ON "webhook_events" USING btree ("channel_id","dedup_key");--> statement-breakpoint
CREATE INDEX "webhook_events_organization_id_status_received_at_idx" ON "webhook_events" USING btree ("organization_id","status","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_organization_id_channel_id_external_id_idx" ON "webhook_events" USING btree ("organization_id","channel_id","external_id");