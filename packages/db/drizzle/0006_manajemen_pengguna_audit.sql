ALTER TABLE "users" ADD COLUMN "two_factor_enrollment_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_logs_organization_id_action_created_at_idx" ON "audit_logs" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_organization_id_target_idx" ON "audit_logs" USING btree ("organization_id","target_type","target_id");