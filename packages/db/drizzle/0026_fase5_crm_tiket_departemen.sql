CREATE TYPE "public"."attribute_entity" AS ENUM('contact', 'ticket');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('text', 'number', 'date', 'select');--> statement-breakpoint
CREATE TYPE "public"."ticket_event_kind" AS ENUM('created', 'updated', 'moved', 'assigned', 'closed', 'reopened', 'commented');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
ALTER TYPE "public"."contact_event_kind" ADD VALUE 'merged';--> statement-breakpoint
ALTER TYPE "public"."contact_event_kind" ADD VALUE 'imported';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_kind" ADD VALUE 'department_changed';--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity" "attribute_entity" NOT NULL,
	"board_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "attribute_type" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_definitions_entity_board" CHECK (("attribute_definitions"."entity" = 'contact') = ("attribute_definitions"."board_id" is null)),
	CONSTRAINT "attribute_definitions_lengths" CHECK (char_length("attribute_definitions"."key") between 1 and 40 and char_length("attribute_definitions"."label") between 1 and 60 and jsonb_typeof("attribute_definitions"."options") = 'array' and jsonb_array_length("attribute_definitions"."options") <= 50),
	CONSTRAINT "attribute_definitions_select_options" CHECK (("attribute_definitions"."type" = 'select') = (jsonb_array_length("attribute_definitions"."options") > 0))
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"organization_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_members_pk" PRIMARY KEY("department_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "departments_text_lengths" CHECK (char_length("departments"."name") between 1 and 60 and ("departments"."description" is null or char_length("departments"."description") between 1 and 300))
);
--> statement-breakpoint
CREATE TABLE "ticket_boards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"department_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_boards_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ticket_boards_text_lengths" CHECK (char_length("ticket_boards"."name") between 1 and 80 and ("ticket_boards"."description" is null or char_length("ticket_boards"."description") between 1 and 300))
);
--> statement-breakpoint
CREATE TABLE "ticket_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_columns_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ticket_columns_board_id_id_unique" UNIQUE("board_id","id"),
	CONSTRAINT "ticket_columns_name_length" CHECK (char_length("ticket_columns"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid,
	"author_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_comments_body_length" CHECK (char_length("ticket_comments"."body") between 1 and 5000),
	CONSTRAINT "ticket_comments_single_author" CHECK ("ticket_comments"."author_user_id" is null or "ticket_comments"."author_api_key_id" is null)
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" "ticket_event_kind" NOT NULL,
	"actor_user_id" uuid,
	"api_key_id" uuid,
	"fields" text[],
	"from_column" text,
	"to_column" text,
	"assignee_user_id" uuid,
	"previous_assignee_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_single_actor" CHECK ("ticket_events"."actor_user_id" is null or "ticket_events"."api_key_id" is null),
	CONSTRAINT "ticket_events_update_has_fields" CHECK (kind <> 'updated' or (fields is not null and cardinality(fields) between 1 and 7 and fields <@ array['title', 'description', 'priority', 'dueAt', 'contactId', 'conversationId', 'attributes']::text[]))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"board_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"assignee_user_id" uuid,
	"due_at" timestamp with time zone,
	"contact_id" uuid,
	"conversation_id" uuid,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_by_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "tickets_conversation_has_contact" CHECK ("tickets"."conversation_id" is null or "tickets"."contact_id" is not null),
	CONSTRAINT "tickets_single_creator" CHECK ("tickets"."created_by_user_id" is null or "tickets"."created_by_api_key_id" is null),
	CONSTRAINT "tickets_text_lengths" CHECK (char_length("tickets"."title") between 1 and 200 and ("tickets"."description" is null or char_length("tickets"."description") between 1 and 5000) and jsonb_typeof("tickets"."attributes") = 'array' and jsonb_array_length("tickets"."attributes") <= 30 and octet_length("tickets"."attributes"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "default_department_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "outgoing_events" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_organization_id_board_id_fk" FOREIGN KEY ("organization_id","board_id") REFERENCES "public"."ticket_boards"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_organization_id_department_id_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_boards" ADD CONSTRAINT "ticket_boards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_boards" ADD CONSTRAINT "ticket_boards_organization_id_department_id_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_columns" ADD CONSTRAINT "ticket_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_columns" ADD CONSTRAINT "ticket_columns_organization_id_board_id_fk" FOREIGN KEY ("organization_id","board_id") REFERENCES "public"."ticket_boards"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_ticket_id_fk" FOREIGN KEY ("organization_id","ticket_id") REFERENCES "public"."tickets"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_author_user_id_fk" FOREIGN KEY ("organization_id","author_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_author_api_key_id_fk" FOREIGN KEY ("organization_id","author_api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_ticket_id_fk" FOREIGN KEY ("organization_id","ticket_id") REFERENCES "public"."tickets"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_actor_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_api_key_id_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_assignee_user_id_fk" FOREIGN KEY ("organization_id","assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_previous_assignee_user_id_fk" FOREIGN KEY ("organization_id","previous_assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_board_id_fk" FOREIGN KEY ("organization_id","board_id") REFERENCES "public"."ticket_boards"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_board_id_column_id_fk" FOREIGN KEY ("board_id","column_id") REFERENCES "public"."ticket_columns"("board_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_assignee_user_id_fk" FOREIGN KEY ("organization_id","assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_contact_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_created_by_user_id_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_created_by_api_key_id_fk" FOREIGN KEY ("organization_id","created_by_api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_contact_key_unique" ON "attribute_definitions" USING btree ("organization_id",lower("key")) WHERE "attribute_definitions"."entity" = 'contact';--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_ticket_key_unique" ON "attribute_definitions" USING btree ("board_id",lower("key")) WHERE "attribute_definitions"."entity" = 'ticket';--> statement-breakpoint
CREATE INDEX "department_members_user_id_idx" ON "department_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_organization_id_name_unique" ON "departments" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ticket_boards_organization_id_position_idx" ON "ticket_boards" USING btree ("organization_id","position");--> statement-breakpoint
CREATE INDEX "ticket_columns_board_id_position_idx" ON "ticket_columns" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_id_created_at_idx" ON "ticket_comments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_board_column_position_idx" ON "tickets" USING btree ("organization_id","board_id","column_id","position");--> statement-breakpoint
CREATE INDEX "tickets_organization_id_updated_at_idx" ON "tickets" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_open_assignee_contact_idx" ON "tickets" USING btree ("organization_id","assignee_user_id","contact_id") WHERE "tickets"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "tickets_organization_id_contact_id_idx" ON "tickets" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "tickets_organization_id_conversation_id_idx" ON "tickets" USING btree ("organization_id","conversation_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_default_department_id_fk" FOREIGN KEY ("organization_id","default_department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_department_id_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_organization_id_department_id_idx" ON "conversations" USING btree ("organization_id","department_id");