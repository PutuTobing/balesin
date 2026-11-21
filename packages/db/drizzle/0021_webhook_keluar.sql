-- Fase 3: webhook keluar bertanda tangan — outbox kejadian, endpoint (rahasia terenkripsi, rotasi
-- tumpang tindih), riwayat pengiriman (retensi), allowlist IP privat per organisasi; pelaku API key di
-- riwayat kontak (review API publik R2).
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_endpoint_disabled_reason" AS ENUM('manual', 'auto_failures');--> statement-breakpoint
CREATE TABLE "outgoing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"contact_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outgoing_events_type_format" CHECK ("outgoing_events"."type" ~ '^[a-z]+\.[a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"payload_purged_at" timestamp with time zone,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"http_status" integer,
	"duration_ms" integer,
	"error_code" text,
	"response_snippet" text,
	"delivered_at" timestamp with time zone,
	"redelivery_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_snippet_length" CHECK ("webhook_deliveries"."response_snippet" is null or char_length("webhook_deliveries"."response_snippet") <= 500),
	CONSTRAINT "webhook_deliveries_error_code_length" CHECK ("webhook_deliveries"."error_code" is null or char_length("webhook_deliveries"."error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] NOT NULL,
	"format" text DEFAULT 'native' NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_secret_encrypted" text,
	"previous_secret_expires_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" "webhook_endpoint_disabled_reason",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_endpoints_url_length" CHECK (char_length("webhook_endpoints"."url") between 8 and 2048),
	CONSTRAINT "webhook_endpoints_format_known" CHECK ("webhook_endpoints"."format" in ('native')),
	CONSTRAINT "webhook_endpoints_events_count" CHECK (cardinality("webhook_endpoints"."events") between 1 and 50),
	CONSTRAINT "webhook_endpoints_disabled_consistent" CHECK ("webhook_endpoints"."enabled" = ("webhook_endpoints"."disabled_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "contact_events" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "webhook_private_cidrs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_events" ADD CONSTRAINT "outgoing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_endpoint_id_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outgoing_events_created_at_idx" ON "outgoing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;