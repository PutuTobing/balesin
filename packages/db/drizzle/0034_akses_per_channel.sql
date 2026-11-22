CREATE TABLE "channel_access_departments" (
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_access_departments_pk" PRIMARY KEY("channel_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "channel_access_users" (
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_access_users_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_access_departments" ADD CONSTRAINT "channel_access_departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_access_departments" ADD CONSTRAINT "channel_access_departments_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_access_departments" ADD CONSTRAINT "channel_access_departments_organization_id_department_id_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_access_users" ADD CONSTRAINT "channel_access_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_access_users" ADD CONSTRAINT "channel_access_users_organization_id_channel_id_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_access_users" ADD CONSTRAINT "channel_access_users_organization_id_user_id_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_access_departments_department_id_idx" ON "channel_access_departments" USING btree ("organization_id","department_id");--> statement-breakpoint
CREATE INDEX "channel_access_users_user_id_idx" ON "channel_access_users" USING btree ("organization_id","user_id");