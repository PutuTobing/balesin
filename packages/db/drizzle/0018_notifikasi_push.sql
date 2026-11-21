-- Fase 2 butir 10: notifikasi Web Push (kunci VAPID terenkripsi per organisasi, langganan per sesi
-- dengan kunci browser terenkripsi, preferensi per pengguna, cuplikan per organisasi) + indeks parsial
-- pemeriksa klaim kirim macet (review R5 Info).
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"queue" boolean DEFAULT true NOT NULL,
	"assigned_message" boolean DEFAULT true NOT NULL,
	"assigned_to_me" boolean DEFAULT true NOT NULL,
	"quiet_start_minute" smallint,
	"quiet_end_minute" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_quiet_hours" CHECK (("notification_preferences"."quiet_start_minute" is null) = ("notification_preferences"."quiet_end_minute" is null) and ("notification_preferences"."quiet_start_minute" is null or ("notification_preferences"."quiet_start_minute" between 0 and 1439 and "notification_preferences"."quiet_end_minute" between 0 and 1439 and "notification_preferences"."quiet_start_minute" <> "notification_preferences"."quiet_end_minute")))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"keys_encrypted" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_endpoint_format" CHECK (char_length("push_subscriptions"."endpoint") between 9 and 1024 and "push_subscriptions"."endpoint" like 'http%')
);
--> statement-breakpoint
CREATE TABLE "push_vapid_keys" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_vapid_keys_public_key_format" CHECK ("push_vapid_keys"."public_key" ~ '^[A-Za-z0-9_-]{87}$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "notification_preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_user_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_vapid_keys" ADD CONSTRAINT "push_vapid_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_organization_id_user_id_idx" ON "push_subscriptions" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_session_id_idx" ON "push_subscriptions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_pending_send_claim_idx" ON "messages" USING btree ("send_claimed_at") WHERE "messages"."status" = 'pending' and "messages"."wamid" is null and "messages"."send_claimed_at" is not null;