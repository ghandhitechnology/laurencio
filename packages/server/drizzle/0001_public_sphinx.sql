CREATE TABLE "kdf_param_versions" (
	"store_id" text NOT NULL,
	"generation" integer NOT NULL,
	"algo" text NOT NULL,
	"version" integer NOT NULL,
	"salt" text NOT NULL,
	"m" integer NOT NULL,
	"t" integer NOT NULL,
	"p" integer NOT NULL,
	"calibrated_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kdf_param_versions_store_id_generation_pk" PRIMARY KEY("store_id","generation")
);
--> statement-breakpoint
ALTER TABLE "kdf_params" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kdf_param_versions" ADD CONSTRAINT "kdf_param_versions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;