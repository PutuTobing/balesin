-- Fase 2 butir 8-9: master tag + tag kontak, riwayat kontak (tanpa nilai data pelanggan), catatan sesi,
-- pesan ditandai, isian kontak (email, catatan, atribut kustom), template percakapan / quick reply.
CREATE TYPE "public"."contact_event_kind" AS ENUM('tag_added', 'tag_removed', 'contact_updated');--> statement-breakpoint
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'note_added';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'note_updated';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'note_deleted';--> statement-breakpoint
CREATE TABLE "contact_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" "contact_event_kind" NOT NULL,
	"actor_user_id" uuid,
	"tag_name" text,
	"tag_color" text,
	"fields" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_events_tag_has_name" CHECK ("contact_events"."kind" not in ('tag_added', 'tag_removed') or ("contact_events"."tag_name" is not null and "contact_events"."tag_color" is not null)),
	CONSTRAINT "contact_events_update_has_fields" CHECK (kind <> 'contact_updated' or (fields is not null and cardinality(fields) between 1 and 4 and fields <@ array['name', 'email', 'notes', 'attributes']::text[]))
);
--> statement-breakpoint
CREATE TABLE "conversation_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_notes_body_length" CHECK (char_length("conversation_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_organization_id_shortcut_unique" UNIQUE("organization_id","shortcut"),
	CONSTRAINT "quick_replies_shortcut_format" CHECK ("quick_replies"."shortcut" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
	CONSTRAINT "quick_replies_text_lengths" CHECK (char_length("quick_replies"."title") between 1 and 80 and char_length("quick_replies"."body") between 1 and 3500),
	CONSTRAINT "quick_replies_usage_count_nonnegative" CHECK ("quick_replies"."usage_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_pk" PRIMARY KEY("contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tags_name_length" CHECK (char_length("tags"."name") between 1 and 40),
	CONSTRAINT "tags_color_known" CHECK (color in ('gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'teal'))
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attributes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "starred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "starred_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_organization_id_actor_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_author_user_id_fk" FOREIGN KEY ("organization_id","author_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_tag_id_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_events_contact_id_created_at_idx" ON "contact_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_id_created_at_idx" ON "conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_tags_organization_id_tag_id_idx" ON "contact_tags" USING btree ("organization_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_organization_id_name_unique" ON "tags" USING btree ("organization_id",lower("name"));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_starred_by_user_id_fk" FOREIGN KEY ("organization_id","starred_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_id_starred_idx" ON "messages" USING btree ("conversation_id","occurred_at") WHERE "messages"."starred_at" is not null;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_details_lengths" CHECK (("contacts"."email" is null or char_length("contacts"."email") between 3 and 254) and ("contacts"."notes" is null or char_length("contacts"."notes") between 1 and 2000) and jsonb_typeof("contacts"."attributes") = 'array' and jsonb_array_length("contacts"."attributes") <= 30 and octet_length("contacts"."attributes"::text) <= 65536);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_star_consistent" CHECK (("messages"."starred_at" is null) = ("messages"."starred_by_user_id" is null));