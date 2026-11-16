-- Fase 2 butir 6 (ruang chat): salinan lokal media (unggahan & cache unduhan, retensi per organisasi),
-- pesan keluar (alasan gagal, kunci idempotensi per pengirim, jumlah percobaan, tautan media).
CREATE TYPE "public"."media_kind" AS ENUM('image', 'audio', 'video', 'document', 'sticker');--> statement-breakpoint
CREATE TYPE "public"."media_source" AS ENUM('upload', 'inbound');--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" "media_source" NOT NULL,
	"kind" "media_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"filename" text,
	"storage_key" text,
	"meta_media_ref" text,
	"uploaded_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_files_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "media_files_size_nonnegative" CHECK ("media_files"."size_bytes" >= 0),
	CONSTRAINT "media_files_storage_key_format" CHECK ("media_files"."storage_key" is null or "media_files"."storage_key" ~ '^[a-z]+/[0-9a-f-]{36}$'),
	CONSTRAINT "media_files_deleted_without_storage" CHECK ("media_files"."deleted_at" is null or "media_files"."storage_key" is null),
	CONSTRAINT "media_files_text_lengths" CHECK (char_length("media_files"."mime_type") between 3 and 128 and char_length("media_files"."sha256") = 64 and ("media_files"."filename" is null or char_length("media_files"."filename") between 1 and 255) and ("media_files"."meta_media_ref" is null or char_length("media_files"."meta_media_ref") between 1 and 256))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_file_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "media_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_uploaded_by_user_id_fk" FOREIGN KEY ("organization_id","uploaded_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_files_expires_at_idx" ON "media_files" USING btree ("expires_at") WHERE "media_files"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_media_file_id_fk" FOREIGN KEY ("organization_id","media_file_id") REFERENCES "public"."media_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_unique" ON "messages" USING btree ("organization_id","sender_user_id","idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_failure_reason_format" CHECK ("messages"."failure_reason" is null or "messages"."failure_reason" ~ '^[a-z_]{1,64}$');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_idempotency_key_format" CHECK ("messages"."idempotency_key" is null or "messages"."idempotency_key" ~ '^[0-9a-f-]{36}$');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_send_attempts_nonnegative" CHECK ("messages"."send_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_media_retention_days_range" CHECK ("organizations"."media_retention_days" between 1 and 365);