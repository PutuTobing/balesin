CREATE TABLE "mail_remote_image_cache" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"url_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_remote_image_cache_account_url_unique" UNIQUE("account_id","url_hash"),
	CONSTRAINT "mail_remote_image_cache_values" CHECK ("mail_remote_image_cache"."url_hash" ~ '^[0-9a-f]{64}$' and "mail_remote_image_cache"."storage_key" ~ '^mail/[0-9a-f-]{36}$' and "mail_remote_image_cache"."content_type" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') and "mail_remote_image_cache"."size_bytes" between 0 and 5242880)
);
--> statement-breakpoint
ALTER TABLE "mail_remote_image_cache" ADD CONSTRAINT "mail_remote_image_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_remote_image_cache" ADD CONSTRAINT "mail_remote_image_cache_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_remote_image_cache_org_expires_idx" ON "mail_remote_image_cache" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "mail_remote_image_cache_expires_idx" ON "mail_remote_image_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mail_attachments_cached_org_idx" ON "mail_attachments" USING btree ("organization_id","message_id") WHERE "mail_attachments"."storage_key" is not null;