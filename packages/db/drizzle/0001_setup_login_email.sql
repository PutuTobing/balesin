CREATE TYPE "public"."smtp_security" AS ENUM('ssl', 'starttls', 'none');--> statement-breakpoint
CREATE TABLE "email_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"security" "smtp_security" NOT NULL,
	"username" text,
	"password_encrypted" text,
	"password_tail" text,
	"last_test_ok" boolean,
	"last_test_code" text,
	"last_tested_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "email_settings_port_range" CHECK ("email_settings"."port" between 1 and 65535),
	CONSTRAINT "email_settings_from_address_normalized" CHECK ("email_settings"."from_address" = lower(btrim("email_settings"."from_address"))),
	CONSTRAINT "email_settings_credentials_paired" CHECK (("email_settings"."username" is null) = ("email_settings"."password_encrypted" is null)),
	CONSTRAINT "email_settings_last_test_complete" CHECK (("email_settings"."last_test_ok" is null) = ("email_settings"."last_tested_at" is null) and ("email_settings"."last_test_ok" is null) = ("email_settings"."last_test_code" is null))
);
--> statement-breakpoint
CREATE TABLE "installation" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"organization_id" uuid NOT NULL,
	"setup_completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_singleton" CHECK ("installation"."singleton")
);
--> statement-breakpoint
CREATE TABLE "organization_logos" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logos_content_type" CHECK ("organization_logos"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "organization_logos_byte_size" CHECK ("organization_logos"."byte_size" = octet_length("organization_logos"."data") and "organization_logos"."byte_size" between 1 and 262144)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_brand_color_hex" CHECK ("organizations"."brand_color" is null or "organizations"."brand_color" ~ '^#[0-9a-f]{6}$');