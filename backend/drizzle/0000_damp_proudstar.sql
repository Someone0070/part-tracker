CREATE TABLE "cross_references" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_id" integer NOT NULL,
	"cross_ref_part_number" text NOT NULL,
	"relationship" text NOT NULL,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cross_ref_unique" UNIQUE("part_id","cross_ref_part_number")
);
--> statement-breakpoint
CREATE TABLE "ebay_poll_watermark" (
	"id" serial PRIMARY KEY NOT NULL,
	"last_polled_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ebay_processed_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"ebay_order_id" text NOT NULL,
	"ebay_line_item_id" text NOT NULL,
	"part_id" integer,
	"quantity_depleted" integer NOT NULL,
	"quarantine_reason" text,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ebay_order_line_unique" UNIQUE("ebay_order_id","ebay_line_item_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"quantity_change" integer NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_number" text NOT NULL,
	"part_number_raw" text NOT NULL,
	"brand" text,
	"description" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"listed_quantity" integer DEFAULT 0 NOT NULL,
	"ebay_listing_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "parts_part_number_unique" UNIQUE("part_number"),
	CONSTRAINT "parts_ebay_listing_id_unique" UNIQUE("ebay_listing_id"),
	CONSTRAINT "listed_quantity_check" CHECK ("parts"."listed_quantity" >= 0 AND "parts"."listed_quantity" <= "parts"."quantity")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"cross_ref_enabled" boolean DEFAULT false NOT NULL,
	"ebay_enabled" boolean DEFAULT false NOT NULL,
	"ebay_access_token" text,
	"ebay_refresh_token" text,
	"ebay_token_expires_at" timestamp,
	"dark_mode" boolean DEFAULT false NOT NULL,
	"password_hash" text NOT NULL,
	"password_version" integer DEFAULT 1 NOT NULL,
	"pending_ebay_state" text,
	"pending_ebay_state_expires" timestamp
);
--> statement-breakpoint
ALTER TABLE "cross_references" ADD CONSTRAINT "cross_references_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_processed_orders" ADD CONSTRAINT "ebay_processed_orders_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;