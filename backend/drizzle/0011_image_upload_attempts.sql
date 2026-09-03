CREATE TABLE "image_upload_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"original_mime" text,
	"original_bytes" integer,
	"normalized_mime" text,
	"normalized_bytes" integer,
	"error_category" text,
	"provider_status" integer,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_upload_attempts_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE INDEX "image_upload_attempts_created_at_idx" ON "image_upload_attempts" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "image_upload_attempts_status_kind_idx" ON "image_upload_attempts" USING btree ("status", "kind");
