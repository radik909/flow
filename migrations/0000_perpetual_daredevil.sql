CREATE TABLE IF NOT EXISTS "conversions" (
	"visitor_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"site_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversions_visitor_id_experiment_id_goal_id_pk" PRIMARY KEY("visitor_id","experiment_id","goal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_key" text NOT NULL,
	"name" text NOT NULL,
	"salt" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exposures" (
	"visitor_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"site_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exposures_visitor_id_experiment_id_pk" PRIMARY KEY("visitor_id","experiment_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"visitor_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sites" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variants" (
	"id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"name" text NOT NULL,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "variants_experiment_id_id_pk" PRIMARY KEY("experiment_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_site_key_sites_key_fk" FOREIGN KEY ("site_key") REFERENCES "public"."sites"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variants" ADD CONSTRAINT "variants_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
