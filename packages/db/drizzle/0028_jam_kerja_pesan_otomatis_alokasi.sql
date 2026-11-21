CREATE TYPE "public"."allocation_mode" AS ENUM('manual', 'round_robin');--> statement-breakpoint
CREATE TYPE "public"."auto_message_kind" AS ENUM('greeting', 'away', 'assigned');--> statement-breakpoint
CREATE TABLE "agent_states" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_auto_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"kind" "auto_message_kind" NOT NULL,
	"message_id" uuid,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_auto_messages_slot_kind" CHECK (("conversation_auto_messages"."slot" = 'assigned') = ("conversation_auto_messages"."kind" = 'assigned') and "conversation_auto_messages"."slot" in ('welcome', 'assigned'))
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"team_hours" jsonb DEFAULT '{"mode":"always"}'::jsonb NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allocation_mode" "allocation_mode" DEFAULT 'manual' NOT NULL,
	"max_open_per_agent" integer,
	"greeting_enabled" boolean DEFAULT false NOT NULL,
	"greeting_text" text NOT NULL,
	"away_enabled" boolean DEFAULT false NOT NULL,
	"away_text" text NOT NULL,
	"assigned_enabled" boolean DEFAULT false NOT NULL,
	"assigned_text" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_capacity_range" CHECK ("workspace_settings"."max_open_per_agent" is null or "workspace_settings"."max_open_per_agent" between 1 and 200),
	CONSTRAINT "workspace_settings_text_lengths" CHECK (char_length("workspace_settings"."greeting_text") between 1 and 1000 and char_length("workspace_settings"."away_text") between 1 and 1000 and char_length("workspace_settings"."assigned_text") between 1 and 1000 and jsonb_typeof("workspace_settings"."holidays") = 'array' and jsonb_array_length("workspace_settings"."holidays") <= 60)
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "team_hours" jsonb;--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_auto_messages" ADD CONSTRAINT "conversation_auto_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_auto_messages" ADD CONSTRAINT "conversation_auto_messages_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_organization_id_updated_by_user_id_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_states_organization_id_idx" ON "agent_states" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_auto_messages_slot_unique" ON "conversation_auto_messages" USING btree ("conversation_id","slot");