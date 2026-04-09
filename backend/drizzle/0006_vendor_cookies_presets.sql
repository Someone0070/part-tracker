CREATE TABLE "vendor_cookies" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_name" text NOT NULL,
	"domain" text NOT NULL,
	"cookie_data" text NOT NULL,
	"auth_cookie_expiry" timestamp,
	"is_preset" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'unconfigured' NOT NULL,
	"last_tested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_cookies_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "vendor_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_key" text NOT NULL,
	"input_type" text NOT NULL,
	"page_fingerprint" text NOT NULL,
	"selectors" text NOT NULL,
	"sample_snippet" text,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_preset_unique" UNIQUE("vendor_key","input_type","page_fingerprint")
);