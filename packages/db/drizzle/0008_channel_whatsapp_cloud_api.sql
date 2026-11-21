CREATE TYPE "public"."channel_type" AS ENUM('whatsapp', 'telegram', 'email', 'messenger', 'instagram');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "channel_type" NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"wa_phone_number_id" text,
	"wa_business_account_id" text,
	"wa_access_token_encrypted" text,
	"wa_access_token_tail" text,
	"wa_app_secret_encrypted" text,
	"wa_app_secret_tail" text,
	"wa_verify_token_encrypted" text,
	"wa_verify_token_rotated_at" timestamp with time zone,
	"wa_number_summary" jsonb,
	"last_test_ok" boolean,
	"last_test_code" text,
	"last_tested_at" timestamp with time zone,
	"credentials_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "channels_name_length" CHECK (char_length("channels"."name") between 1 and 60),
	CONSTRAINT "channels_wa_ids_numeric" CHECK (("channels"."wa_phone_number_id" is null or "channels"."wa_phone_number_id" ~ '^[0-9]{1,32}$') and ("channels"."wa_business_account_id" is null or "channels"."wa_business_account_id" ~ '^[0-9]{1,32}$')),
	CONSTRAINT "channels_whatsapp_live_complete" CHECK ("channels"."type" <> 'whatsapp' or "channels"."deleted_at" is not null or ("channels"."wa_phone_number_id" is not null and "channels"."wa_business_account_id" is not null and "channels"."wa_access_token_encrypted" is not null and "channels"."wa_app_secret_encrypted" is not null and "channels"."wa_verify_token_encrypted" is not null and "channels"."wa_verify_token_rotated_at" is not null)),
	CONSTRAINT "channels_deleted_without_secrets" CHECK ("channels"."deleted_at" is null or ("channels"."wa_access_token_encrypted" is null and "channels"."wa_app_secret_encrypted" is null and "channels"."wa_verify_token_encrypted" is null)),
	CONSTRAINT "channels_last_test_complete" CHECK (("channels"."last_test_ok" is null) = ("channels"."last_tested_at" is null) and ("channels"."last_test_ok" is null) = ("channels"."last_test_code" is null))
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_organization_id_wa_phone_number_id_live_unique" ON "channels" USING btree ("organization_id","wa_phone_number_id") WHERE "channels"."deleted_at" is null and "channels"."type" = 'whatsapp';--> statement-breakpoint
CREATE INDEX "channels_organization_id_created_at_idx" ON "channels" USING btree ("organization_id","created_at");