CREATE TABLE "appliances" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand" text,
	"model_number" text,
	"serial_number" text,
	"appliance_type" text,
	"notes" text,
	"photo_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "appliance_id" integer;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_appliance_id_appliances_id_fk" FOREIGN KEY ("appliance_id") REFERENCES "public"."appliances"("id") ON DELETE no action ON UPDATE no action;