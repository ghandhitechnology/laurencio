CREATE TABLE "profile_heads" (
	"store_id" text PRIMARY KEY NOT NULL,
	"blob_id" text NOT NULL,
	"blob_size" bigint NOT NULL,
	"generation" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_heads" ADD CONSTRAINT "profile_heads_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;