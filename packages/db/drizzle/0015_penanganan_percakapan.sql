-- Fase 2 butir 7: riwayat penanganan percakapan (ambil/tugaskan/kembalikan/selesai/buka lagi) dan
-- waktu laporan (pertama ditugaskan, respons pertama).
CREATE TYPE "public"."conversation_event_kind" AS ENUM('claimed', 'assigned', 'unassigned', 'resolved', 'reopened');--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" "conversation_event_kind" NOT NULL,
	"actor_user_id" uuid,
	"assignee_user_id" uuid,
	"previous_assignee_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_events_assignment_has_assignee" CHECK ("conversation_events"."kind" not in ('claimed', 'assigned') or "conversation_events"."assignee_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "first_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_actor_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_assignee_user_id_fk" FOREIGN KEY ("organization_id","assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_previous_assignee_user_id_fk" FOREIGN KEY ("organization_id","previous_assignee_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_events_conversation_id_created_at_idx" ON "conversation_events" USING btree ("conversation_id","created_at");