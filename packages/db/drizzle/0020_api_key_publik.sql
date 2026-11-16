-- Fase 3: API key bertingkat scope (hash HMAC berlada, IP & kedaluwarsa opsional), pesan/unggahan lewat
-- API key (idempotensi per key), pengaturan dokumentasi API publik per organisasi.
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lookup_key" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"allowed_ips" text[],
	"daily_send_limit" integer DEFAULT 500 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "api_keys_lookup_key_unique" UNIQUE("lookup_key"),
	CONSTRAINT "api_keys_lookup_key_format" CHECK ("api_keys"."lookup_key" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "api_keys_secret_hash_format" CHECK ("api_keys"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_name_length" CHECK (char_length("api_keys"."name") between 1 and 80),
	CONSTRAINT "api_keys_scopes_count" CHECK (cardinality("api_keys"."scopes") between 1 and 20 and ("api_keys"."allowed_ips" is null or cardinality("api_keys"."allowed_ips") <= 20)),
	CONSTRAINT "api_keys_daily_send_limit_range" CHECK ("api_keys"."daily_send_limit" between 1 and 100000)
);
--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "uploaded_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "api_docs_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_revoked_by_user_id_fk" FOREIGN KEY ("organization_id","revoked_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_organization_id_created_at_idx" ON "api_keys" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_uploaded_by_api_key_id_fk" FOREIGN KEY ("organization_id","uploaded_by_api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_api_key_idempotency_unique" ON "messages" USING btree ("organization_id","api_key_id","idempotency_key") WHERE "messages"."idempotency_key" is not null and "messages"."api_key_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_outbound_api_key_created_at_idx" ON "messages" USING btree ("organization_id","api_key_id","created_at") WHERE "messages"."direction" = 'outbound' and "messages"."api_key_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_single_sender" CHECK ("messages"."sender_user_id" is null or "messages"."api_key_id" is null);