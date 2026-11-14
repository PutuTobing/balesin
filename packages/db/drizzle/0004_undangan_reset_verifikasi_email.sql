CREATE TYPE "public"."account_token_purpose" AS ENUM('password_reset', 'email_verification');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_status" AS ENUM('queued', 'sent', 'failed', 'skipped', 'link');--> statement-breakpoint
CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "account_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"delivery_status" "email_delivery_status" DEFAULT 'queued' NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_token_encrypted" text,
	"requested_ip" "inet",
	"requested_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_tokens_email_normalized" CHECK ("account_tokens"."email" = lower(btrim("account_tokens"."email"))),
	CONSTRAINT "account_tokens_failed_attempts_range" CHECK ("account_tokens"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"token_hash" text NOT NULL,
	"token_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"delivery_status" "email_delivery_status" NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_token_encrypted" text,
	"invited_by_user_id" uuid NOT NULL,
	"last_sent_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "user_invitations_email_normalized" CHECK ("user_invitations"."email" = lower(btrim("user_invitations"."email"))),
	CONSTRAINT "user_invitations_role_not_owner" CHECK ("user_invitations"."role" <> 'owner'),
	CONSTRAINT "user_invitations_send_count_positive" CHECK ("user_invitations"."send_count" >= 1),
	CONSTRAINT "user_invitations_accepted_paired" CHECK (("user_invitations"."accepted_at" is null) = ("user_invitations"."accepted_user_id" is null)),
	CONSTRAINT "user_invitations_revoked_paired" CHECK (("user_invitations"."revoked_at" is null) = ("user_invitations"."revoked_by_user_id" is null)),
	CONSTRAINT "user_invitations_closed_once" CHECK ("user_invitations"."accepted_at" is null or "user_invitations"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_pending_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_invited_by_user_id_fk" FOREIGN KEY ("organization_id","invited_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_last_sent_by_user_id_fk" FOREIGN KEY ("organization_id","last_sent_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_accepted_user_id_fk" FOREIGN KEY ("organization_id","accepted_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_revoked_by_user_id_fk" FOREIGN KEY ("organization_id","revoked_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_live_unique" ON "account_tokens" USING btree ("organization_id","user_id","purpose") WHERE "account_tokens"."used_at" is null and "account_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "account_tokens_organization_id_user_id_idx" ON "account_tokens" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invitations_open_email_unique" ON "user_invitations" USING btree ("organization_id","email") WHERE "user_invitations"."accepted_at" is null and "user_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_invitations_organization_id_created_at_idx" ON "user_invitations" USING btree ("organization_id","created_at");