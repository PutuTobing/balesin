CREATE TABLE "channel_avatars" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_avatars_content_type" CHECK ("channel_avatars"."content_type" = 'image/png'),
	CONSTRAINT "channel_avatars_size" CHECK (octet_length("channel_avatars"."data") between 1 and 131072 and "channel_avatars"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mail_account_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"user_id" uuid,
	"department_id" uuid,
	"level" text NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_account_access_principal" CHECK (("mail_account_access"."principal_type" = 'user' and "mail_account_access"."user_id" is not null and "mail_account_access"."department_id" is null) or ("mail_account_access"."principal_type" = 'department' and "mail_account_access"."department_id" is not null and "mail_account_access"."user_id" is null)),
	CONSTRAINT "mail_account_access_level" CHECK (level in ('read', 'send', 'manage'))
);
--> statement-breakpoint
CREATE TABLE "mail_account_avatars" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_account_avatars_content_type" CHECK ("mail_account_avatars"."content_type" = 'image/png'),
	CONSTRAINT "mail_account_avatars_size" CHECK (octet_length("mail_account_avatars"."data") between 1 and 131072 and "mail_account_avatars"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" uuid,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"email_address" text NOT NULL,
	"from_name" text NOT NULL,
	"color" text NOT NULL,
	"imap_host" text,
	"imap_port" integer,
	"imap_security" text,
	"imap_username" text,
	"imap_password_encrypted" text,
	"imap_password_tail" text,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_security" text,
	"smtp_username" text,
	"smtp_password_encrypted" text,
	"smtp_password_tail" text,
	"smtp_same_credentials" boolean DEFAULT true NOT NULL,
	"trusted_auth_serv_ids" text[],
	"sync_window_days" integer DEFAULT 90,
	"periodic_sync_minutes" integer DEFAULT 5 NOT NULL,
	"sync_state" text DEFAULT 'initial_sync' NOT NULL,
	"sync_paused_by_user_id" uuid,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"folders_synced_at" timestamp with time zone,
	"initial_sync_done" integer DEFAULT 0 NOT NULL,
	"initial_sync_total" integer,
	"capabilities" jsonb,
	"idle_active" boolean DEFAULT false NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_incoming_ok" boolean,
	"last_test_outgoing_ok" boolean,
	"message_count" bigint DEFAULT 0 NOT NULL,
	"unread_count" bigint DEFAULT 0 NOT NULL,
	"quota_used_bytes" bigint,
	"quota_limit_bytes" bigint,
	"avatar_sha256" text,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_accounts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_accounts_known" CHECK (kind in ('shared', 'personal') and provider in ('cpanel', 'imap', 'microsoft', 'google', 'pop3') and color in ('tagBlue', 'tagTeal', 'tagPurple', 'accent', 'success', 'warning') and sync_state in ('initial_sync', 'ready', 'syncing', 'paused', 'auth_failed', 'error', 'owner_inactive', 'deleting')),
	CONSTRAINT "mail_accounts_owner" CHECK (("mail_accounts"."kind" = 'personal' and "mail_accounts"."owner_user_id" is not null) or ("mail_accounts"."kind" = 'shared' and "mail_accounts"."owner_user_id" is null)),
	CONSTRAINT "mail_accounts_text_lengths" CHECK (char_length("mail_accounts"."display_name") between 1 and 60 and char_length("mail_accounts"."email_address") between 3 and 254 and "mail_accounts"."email_address" = lower("mail_accounts"."email_address") and char_length("mail_accounts"."from_name") between 1 and 80 and ("mail_accounts"."imap_host" is null or char_length("mail_accounts"."imap_host") between 1 and 253) and ("mail_accounts"."smtp_host" is null or char_length("mail_accounts"."smtp_host") between 1 and 253) and ("mail_accounts"."imap_username" is null or char_length("mail_accounts"."imap_username") between 1 and 255) and ("mail_accounts"."smtp_username" is null or char_length("mail_accounts"."smtp_username") between 1 and 255) and ("mail_accounts"."last_error_code" is null or char_length("mail_accounts"."last_error_code") <= 64) and ("mail_accounts"."avatar_sha256" is null or "mail_accounts"."avatar_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "mail_accounts_servers" CHECK (("mail_accounts"."imap_security" is null or "mail_accounts"."imap_security" in ('ssl', 'starttls')) and ("mail_accounts"."smtp_security" is null or "mail_accounts"."smtp_security" in ('ssl', 'starttls')) and ("mail_accounts"."imap_port" is null or "mail_accounts"."imap_port" between 1 and 65535) and ("mail_accounts"."smtp_port" is null or "mail_accounts"."smtp_port" between 1 and 65535)),
	CONSTRAINT "mail_accounts_live_complete" CHECK ("mail_accounts"."deleted_at" is not null or ("mail_accounts"."imap_host" is not null and "mail_accounts"."imap_port" is not null and "mail_accounts"."imap_security" is not null and "mail_accounts"."imap_username" is not null and "mail_accounts"."imap_password_encrypted" is not null and "mail_accounts"."smtp_host" is not null and "mail_accounts"."smtp_port" is not null and "mail_accounts"."smtp_security" is not null and ("mail_accounts"."smtp_same_credentials" or ("mail_accounts"."smtp_username" is not null and "mail_accounts"."smtp_password_encrypted" is not null)))),
	CONSTRAINT "mail_accounts_numbers" CHECK (("mail_accounts"."sync_window_days" is null or "mail_accounts"."sync_window_days" in (30, 90, 365)) and "mail_accounts"."periodic_sync_minutes" between 1 and 60 and "mail_accounts"."consecutive_failures" >= 0 and "mail_accounts"."initial_sync_done" >= 0 and "mail_accounts"."message_count" >= 0 and "mail_accounts"."unread_count" >= 0 and ("mail_accounts"."trusted_auth_serv_ids" is null or (cardinality("mail_accounts"."trusted_auth_serv_ids") between 1 and 5 and char_length(array_to_string("mail_accounts"."trusted_auth_serv_ids", ',')) <= 1300 and array_to_string("mail_accounts"."trusted_auth_serv_ids", ',') ~ '^[a-z0-9.,-]+$')))
);
--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"filename" text,
	"declared_type" text,
	"detected_type" text,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL,
	"risk" text DEFAULT 'ok' NOT NULL,
	"risk_reason" text,
	"storage_key" text,
	"fetched_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_attachments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_attachments_message_id_part_id_unique" UNIQUE("message_id","part_id"),
	CONSTRAINT "mail_attachments_known" CHECK ("mail_attachments"."risk" in ('ok', 'warn', 'blocked') and char_length("mail_attachments"."part_id") between 1 and 64 and ("mail_attachments"."filename" is null or char_length("mail_attachments"."filename") <= 255) and ("mail_attachments"."declared_type" is null or char_length("mail_attachments"."declared_type") <= 255) and ("mail_attachments"."content_id" is null or char_length("mail_attachments"."content_id") <= 998) and "mail_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"path" text NOT NULL,
	"delimiter" text,
	"name" text NOT NULL,
	"role" text,
	"role_source" text,
	"parent_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"subscribed" boolean DEFAULT true NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"uidvalidity" bigint,
	"uidnext" bigint,
	"highest_modseq" numeric,
	"total_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"oldest_synced_at" timestamp with time zone,
	"has_older_on_server" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_full_flag_sweep_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_folders_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_folders_account_id_path_unique" UNIQUE("account_id","path"),
	CONSTRAINT "mail_folders_known" CHECK ((role is null or role in ('inbox', 'sent', 'drafts', 'junk', 'trash', 'archive', 'all', 'flagged')) and (role_source is null or role_source in ('special_use', 'name_guess', 'created')) and ((role is null) = (role_source is null))),
	CONSTRAINT "mail_folders_text_lengths" CHECK (char_length("mail_folders"."path") between 1 and 1000 and char_length("mail_folders"."name") between 1 and 200 and ("mail_folders"."delimiter" is null or char_length("mail_folders"."delimiter") = 1) and "mail_folders"."depth" between 0 and 50 and "mail_folders"."total_count" >= 0 and "mail_folders"."unread_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"address" text NOT NULL,
	"display_name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_identities_account_id_address_unique" UNIQUE("account_id","address"),
	CONSTRAINT "mail_identities_text_lengths" CHECK (char_length("mail_identities"."address") between 3 and 254 and "mail_identities"."address" = lower("mail_identities"."address") and char_length("mail_identities"."display_name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "mail_message_bodies" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"text" text,
	"html_sanitized" text,
	"remote_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_warnings" integer DEFAULT 0 NOT NULL,
	"raw_headers" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_message_bodies_sizes" CHECK (("mail_message_bodies"."text" is null or octet_length("mail_message_bodies"."text") <= 1048576) and ("mail_message_bodies"."html_sanitized" is null or octet_length("mail_message_bodies"."html_sanitized") <= 2097152) and jsonb_array_length("mail_message_bodies"."remote_images") <= 200 and ("mail_message_bodies"."raw_headers" is null or octet_length("mail_message_bodies"."raw_headers") <= 65536) and "mail_message_bodies"."link_warnings" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"folder_role" text,
	"uid" bigint NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"message_id_header" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text,
	"from_name" text,
	"sender_address" text,
	"reply_to" jsonb,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb,
	"to_count" integer DEFAULT 0 NOT NULL,
	"cc_count" integer DEFAULT 0 NOT NULL,
	"delivered_to" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_answered" boolean DEFAULT false NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"sender_verification" text DEFAULT 'unverified' NOT NULL,
	"auth_details" jsonb,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"body_state" text DEFAULT 'none' NOT NULL,
	"pending_action" text,
	"pending_action_at" timestamp with time zone,
	"bodystructure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mail_messages_folder_uid_unique" UNIQUE("folder_id","uidvalidity","uid"),
	CONSTRAINT "mail_messages_known" CHECK (sender_verification in ('pass', 'fail', 'unverified') and body_state in ('none', 'loading', 'ready', 'too_large', 'error') and (folder_role is null or folder_role in ('inbox', 'sent', 'drafts', 'junk', 'trash', 'archive', 'all', 'flagged')) and warnings <@ array['lookalike_sender', 'impersonation', 'link_mismatch', 'dangerous_attachment']::text[]),
	CONSTRAINT "mail_messages_sizes" CHECK (("mail_messages"."message_id_header" is null or char_length("mail_messages"."message_id_header") <= 998) and ("mail_messages"."in_reply_to" is null or char_length("mail_messages"."in_reply_to") <= 998) and cardinality("mail_messages"."references") <= 20 and ("mail_messages"."subject" is null or char_length("mail_messages"."subject") <= 998) and ("mail_messages"."snippet" is null or char_length("mail_messages"."snippet") <= 200) and ("mail_messages"."from_address" is null or char_length("mail_messages"."from_address") <= 254) and ("mail_messages"."from_name" is null or char_length("mail_messages"."from_name") <= 200) and ("mail_messages"."delivered_to" is null or char_length("mail_messages"."delivered_to") <= 254) and jsonb_array_length("mail_messages"."to") <= 100 and jsonb_array_length("mail_messages"."cc") <= 100 and cardinality("mail_messages"."keywords") <= 50 and "mail_messages"."uid" > 0 and "mail_messages"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_remote_image_allow" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sender_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_remote_image_allow_user_sender_unique" UNIQUE("user_id","sender_address"),
	CONSTRAINT "mail_remote_image_allow_sender" CHECK (char_length("mail_remote_image_allow"."sender_address") between 3 and 254 and "mail_remote_image_allow"."sender_address" = lower("mail_remote_image_allow"."sender_address"))
);
--> statement-breakpoint
CREATE TABLE "mail_settings" (
	"organization_id" uuid NOT NULL,
	"cache_retention_days" integer DEFAULT 90 NOT NULL,
	"default_sync_window_days" integer DEFAULT 90,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_settings_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "mail_settings_numbers" CHECK ("mail_settings"."cache_retention_days" between 7 and 3650 and ("mail_settings"."default_sync_window_days" is null or "mail_settings"."default_sync_window_days" in (30, 90, 365)))
);
--> statement-breakpoint
ALTER TABLE "channel_avatars" ADD CONSTRAINT "channel_avatars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_avatars" ADD CONSTRAINT "channel_avatars_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_access" ADD CONSTRAINT "mail_account_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_access" ADD CONSTRAINT "mail_account_access_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_access" ADD CONSTRAINT "mail_account_access_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_access" ADD CONSTRAINT "mail_account_access_organization_id_department_id_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_access" ADD CONSTRAINT "mail_account_access_organization_id_granted_by_user_id_fk" FOREIGN KEY ("organization_id","granted_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_avatars" ADD CONSTRAINT "mail_account_avatars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_avatars" ADD CONSTRAINT "mail_account_avatars_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_organization_id_owner_user_id_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_organization_id_sync_paused_by_user_id_fk" FOREIGN KEY ("organization_id","sync_paused_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_organization_id_message_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."mail_messages"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_identities" ADD CONSTRAINT "mail_identities_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message_bodies" ADD CONSTRAINT "mail_message_bodies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message_bodies" ADD CONSTRAINT "mail_message_bodies_organization_id_message_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."mail_messages"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_organization_id_account_id_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."mail_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_organization_id_folder_id_fk" FOREIGN KEY ("organization_id","folder_id") REFERENCES "public"."mail_folders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_remote_image_allow" ADD CONSTRAINT "mail_remote_image_allow_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_remote_image_allow" ADD CONSTRAINT "mail_remote_image_allow_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_account_access_account_user_unique" ON "mail_account_access" USING btree ("account_id","user_id") WHERE "mail_account_access"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_account_access_account_department_unique" ON "mail_account_access" USING btree ("account_id","department_id") WHERE "mail_account_access"."department_id" is not null;--> statement-breakpoint
CREATE INDEX "mail_account_access_user_idx" ON "mail_account_access" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "mail_account_access_department_idx" ON "mail_account_access" USING btree ("organization_id","department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_organization_id_email_address_live_unique" ON "mail_accounts" USING btree ("organization_id","email_address") WHERE "mail_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mail_accounts_sync_state_next_attempt_at_idx" ON "mail_accounts" USING btree ("sync_state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mail_accounts_organization_id_owner_user_id_idx" ON "mail_accounts" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_expires_at_idx" ON "mail_attachments" USING btree ("expires_at") WHERE "mail_attachments"."storage_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_folders_account_id_role_unique" ON "mail_folders" USING btree ("account_id","role") WHERE "mail_folders"."role" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_identities_one_primary" ON "mail_identities" USING btree ("account_id") WHERE "mail_identities"."is_primary";--> statement-breakpoint
CREATE INDEX "mail_messages_folder_received_idx" ON "mail_messages" USING btree ("folder_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_messages_unread_idx" ON "mail_messages" USING btree ("organization_id","account_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE not "mail_messages"."is_read" and "mail_messages"."folder_role" is distinct from 'junk' and "mail_messages"."folder_role" is distinct from 'trash';--> statement-breakpoint
CREATE INDEX "mail_messages_starred_idx" ON "mail_messages" USING btree ("organization_id","account_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail_messages"."is_starred" and "mail_messages"."folder_role" is distinct from 'junk' and "mail_messages"."folder_role" is distinct from 'trash';--> statement-breakpoint
CREATE INDEX "mail_messages_account_message_id_idx" ON "mail_messages" USING btree ("account_id","message_id_header");