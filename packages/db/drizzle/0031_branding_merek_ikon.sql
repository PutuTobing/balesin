CREATE TABLE "organization_logo_icons" (
	"organization_id" uuid NOT NULL,
	"file" text NOT NULL,
	"logo_sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logo_icons_pk" PRIMARY KEY("organization_id","file"),
	CONSTRAINT "organization_logo_icons_file" CHECK ("organization_logo_icons"."file" in ('favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png')),
	CONSTRAINT "organization_logo_icons_byte_size" CHECK ("organization_logo_icons"."byte_size" = octet_length("organization_logo_icons"."data") and "organization_logo_icons"."byte_size" between 1 and 1048576)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "mascot_name" text;--> statement-breakpoint
ALTER TABLE "organization_logo_icons" ADD CONSTRAINT "organization_logo_icons_logo_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization_logos"("organization_id") ON DELETE cascade ON UPDATE no action;