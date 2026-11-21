CREATE TABLE "email_settings_change_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"previous_from_name" text,
	"previous_from_address" text,
	"previous_reply_to" text,
	"previous_host" text,
	"previous_port" integer,
	"previous_security" "smtp_security",
	"previous_username" text,
	"previous_password_encrypted" text,
	"new_host" text NOT NULL,
	"new_port" integer NOT NULL,
	"new_from_address" text NOT NULL,
	"pending_deliveries" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_change_notices_pending_nonnegative" CHECK ("email_settings_change_notices"."pending_deliveries" >= 0),
	CONSTRAINT "email_settings_change_notices_previous_complete" CHECK (("email_settings_change_notices"."previous_host" is null) = ("email_settings_change_notices"."previous_port" is null) and ("email_settings_change_notices"."previous_host" is null) = ("email_settings_change_notices"."previous_security" is null) and ("email_settings_change_notices"."previous_host" is null) = ("email_settings_change_notices"."previous_from_address" is null) and ("email_settings_change_notices"."previous_host" is null) = ("email_settings_change_notices"."previous_from_name" is null))
);
--> statement-breakpoint
ALTER TABLE "email_settings_change_notices" ADD CONSTRAINT "email_settings_change_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings_change_notices" ADD CONSTRAINT "email_settings_change_notices_organization_id_actor_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_settings_change_notices_organization_id_idx" ON "email_settings_change_notices" USING btree ("organization_id");