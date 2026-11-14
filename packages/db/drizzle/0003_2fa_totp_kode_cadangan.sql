CREATE TYPE "public"."session_kind" AS ENUM('standard', 'two_factor_enrollment');--> statement-breakpoint
CREATE TABLE "two_factor_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"binding_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"ip_address" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "two_factor_challenges_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "two_factor_challenges_failed_attempts_range" CHECK ("two_factor_challenges"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_backup_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "kind" "session_kind" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "two_factor_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_used_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_pending_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_pending_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "two_factor_challenges" ADD CONSTRAINT "two_factor_challenges_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_backup_codes" ADD CONSTRAINT "user_backup_codes_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "two_factor_challenges_organization_id_user_id_idx" ON "two_factor_challenges" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "user_backup_codes_organization_id_user_id_idx" ON "user_backup_codes" USING btree ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_totp_enabled_paired" CHECK (("users"."totp_secret_encrypted" is null) = ("users"."totp_enabled_at" is null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_totp_pending_paired" CHECK (("users"."totp_pending_secret_encrypted" is null) = ("users"."totp_pending_created_at" is null));